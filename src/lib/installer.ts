import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MarkerStyle } from './blocks.js';
import { hashBlock, readBlockBody, removeBlock, upsertBlock } from './blocks.js';
import { SynlinError } from './errors.js';
import { hashTreeIfExists, hashVirtualTree } from './hash.js';
import type { CatalogItem } from './library.js';
import type { Manifest, OutputRecord, ToolEntry } from './manifest.js';
import { blockReferences, getToolEntry, withToolEntry, withoutToolEntry } from './manifest.js';
import { assertInside, assertWritable, projectWriteEnvelope } from './paths.js';
import { getAdapter } from './tools/registry.js';
import type { OwnedTreeOutput, RenderedOutput, ToolId } from './tools/types.js';

/** Marker comment style for a shared file, by extension. */
function markerStyleFor(filePath: string): MarkerStyle {
  return filePath.endsWith('.toml') ? 'hash' : 'html';
}

export type ItemStatus =
  | 'not-installed'
  | 'up-to-date'
  | 'update-available'
  | 'modified'
  | 'conflict'
  | 'files-missing'
  | 'gone-from-library';

export type InstallAction =
  | 'installed'
  | 'updated'
  | 'overwritten'
  | 'up-to-date'
  | 'skipped-exists'
  | 'skipped-modified'
  | 'skipped-template-exists'
  | 'skipped-unsupported';

export interface InstallResult {
  readonly id: string;
  readonly tool: ToolId;
  readonly action: InstallAction;
  readonly detail?: string;
}

export interface InstallOutcome {
  readonly result: InstallResult;
  readonly manifest: Manifest;
}

/** Absolute path of an owned-tree output root inside the project. */
function absoluteRootPath(projectRoot: string, rootPath: string): string {
  return path.join(projectRoot, ...rootPath.split('/'));
}

function outputDescriptor(output: { readonly kind: string } & ({ readonly rootPath: string } | { readonly filePath: string; readonly blockId: string })): string {
  return 'rootPath' in output ? `tree:${output.rootPath}` : `block:${output.filePath}#${output.blockId}`;
}

/**
 * Combine per-output unit hashes into one entry hash. Single-output entries use
 * the unit hash directly (v1 manifest compatibility); multi-output entries hash
 * the sorted (descriptor, hash) tuples.
 */
function combineUnitHashes(units: ReadonlyArray<{ readonly descriptor: string; readonly hash: string }>): string {
  const only = units[0];
  if (units.length === 1 && only !== undefined) {
    return only.hash;
  }
  const hash = createHash('sha256');
  for (const unit of [...units].sort((a, b) => (a.descriptor < b.descriptor ? -1 : 1))) {
    hash.update(unit.descriptor);
    hash.update('\0');
    hash.update(unit.hash);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** Hash of an item's installed outputs on disk; null when any output is missing. */
export function installedEntryHash(projectRoot: string, outputs: readonly OutputRecord[]): string | null {
  const units: Array<{ descriptor: string; hash: string }> = [];
  for (const output of outputs) {
    if (output.kind === 'owned-tree') {
      const hash = hashTreeIfExists(absoluteRootPath(projectRoot, output.rootPath));
      if (hash === null) return null;
      units.push({ descriptor: outputDescriptor(output), hash });
    } else {
      const filePath = absoluteRootPath(projectRoot, output.filePath);
      if (!fs.existsSync(filePath)) return null;
      const body = readBlockBody(fs.readFileSync(filePath, 'utf8'), output.blockId, markerStyleFor(output.filePath), filePath);
      if (body === null) return null;
      units.push({ descriptor: outputDescriptor(output), hash: hashBlock(body) });
    }
  }
  return combineUnitHashes(units);
}

/** Hash of an item as it would be rendered today for a tool (the "library side" of the three-way compare). */
export function renderedLibraryHash(item: CatalogItem, tool: ToolId): string {
  const rendered = getAdapter(tool).render(item);
  const units = rendered.outputs.map((output) =>
    output.kind === 'owned-tree'
      ? { descriptor: outputDescriptor(output), hash: hashVirtualTree(output.files) }
      : { descriptor: outputDescriptor(output), hash: hashBlock(output.body) },
  );
  return combineUnitHashes(units);
}

/** Manifest output records for a rendered item (locations only, no content). */
function toOutputRecords(outputs: readonly RenderedOutput[]): readonly OutputRecord[] {
  return outputs.map((output) =>
    output.kind === 'owned-tree'
      ? { kind: 'owned-tree' as const, rootPath: output.rootPath.split(path.sep).join('/') }
      : { kind: 'managed-block' as const, filePath: output.filePath, blockId: output.blockId },
  );
}

/**
 * Three-way status per (item, tool): manifest hash (as installed) vs outputs on
 * disk vs current library content rendered for that tool.
 * libraryItem === null means the item no longer exists in the library.
 */
export function computeStatus(
  projectRoot: string,
  manifest: Manifest,
  id: string,
  libraryItem: CatalogItem | null,
  tool: ToolId = 'claude',
): ItemStatus {
  const entry = getToolEntry(manifest, id, tool);
  if (!entry) return 'not-installed';
  if (!libraryItem) return 'gone-from-library';

  const installedHash = installedEntryHash(projectRoot, entry.outputs);
  if (installedHash === null) return 'files-missing';

  const locallyClean = installedHash === entry.hash;
  const upstreamChanged = renderedLibraryHash(libraryItem, tool) !== entry.hash;
  if (locallyClean) return upstreamChanged ? 'update-available' : 'up-to-date';
  return upstreamChanged ? 'conflict' : 'modified';
}

export interface InstallOptions {
  readonly projectRoot: string;
  readonly item: CatalogItem;
  readonly manifest: Manifest;
  readonly tool?: ToolId;
  readonly force?: boolean;
  /** ISO timestamp injected by the caller (testability). */
  readonly now: string;
}

/**
 * Install or refresh one item for one tool. Pure with respect to the manifest
 * (returns a new one); all filesystem writes stay inside the project's write
 * envelope, owned trees additionally inside the tool's own config dir.
 */
export function installItem(options: InstallOptions): InstallOutcome {
  const { item, manifest, force = false } = options;
  const tool = options.tool ?? 'claude';
  const adapter = getAdapter(tool);

  if (adapter.supports(item.category) !== 'supported') {
    const reason = adapter.unsupportedReason(item.category) ?? `${item.category} are not supported for ${adapter.displayName}`;
    return outcome(options, tool, 'skipped-unsupported', reason);
  }

  const rendered = adapter.render(item);
  if (item.category === 'templates' && tool === 'claude') {
    return installTemplate(options, tool, rendered.outputs);
  }

  const entry = getToolEntry(manifest, item.id, tool);
  if (entry) {
    return refreshManaged(options, tool, rendered.outputs);
  }
  const existingUnmanaged = rendered.outputs.find(
    (output) => output.kind === 'owned-tree' && fs.existsSync(absoluteRootPath(options.projectRoot, output.rootPath)),
  );
  if (existingUnmanaged && !force) {
    return outcome(options, tool, 'skipped-exists', 'target exists but is not synlin-managed (use --force to overwrite and adopt)');
  }
  writeOutputs(options.projectRoot, tool, rendered.outputs);
  return adopted(options, tool, rendered.outputs, existingUnmanaged ? 'overwritten' : 'installed');
}

/** Templates are copy-if-absent: once installed they are locally owned. */
function installTemplate(options: InstallOptions, tool: ToolId, outputs: readonly RenderedOutput[]): InstallOutcome {
  const { force = false } = options;
  const first = outputs[0];
  if (outputs.length !== 1 || first === undefined || first.kind !== 'owned-tree') {
    throw new SynlinError(`Unexpected render shape for template ${options.item.id}`, 1);
  }
  const targetPath = absoluteRootPath(options.projectRoot, first.rootPath);
  const existed = fs.existsSync(targetPath);
  if (existed && !force) {
    return outcome(options, tool, 'skipped-template-exists', 'already present — templates are locally owned after install');
  }
  writeOutputs(options.projectRoot, tool, outputs);
  return adopted(options, tool, outputs, existed ? 'overwritten' : 'installed');
}

function refreshManaged(options: InstallOptions, tool: ToolId, outputs: readonly RenderedOutput[]): InstallOutcome {
  const { projectRoot, item, manifest, force = false } = options;
  const status = computeStatus(projectRoot, manifest, item.id, item, tool);
  switch (status) {
    case 'up-to-date':
      return outcome(options, tool, 'up-to-date');
    case 'update-available':
    case 'files-missing':
      writeOutputs(projectRoot, tool, outputs);
      return adopted(options, tool, outputs, 'updated');
    case 'modified':
    case 'conflict': {
      if (force) {
        writeOutputs(projectRoot, tool, outputs);
        return adopted(options, tool, outputs, 'overwritten');
      }
      const detail =
        status === 'conflict'
          ? 'locally modified AND changed in library — use --force to take the library version'
          : 'locally modified — `synlin import` to push your edits to the library, or --force to discard them';
      return outcome(options, tool, 'skipped-modified', detail);
    }
    default:
      throw new SynlinError(`Unexpected status "${status}" while refreshing ${item.id}`, 1);
  }
}

export interface RemoveOutcome {
  readonly manifest: Manifest;
  readonly removedFiles: boolean;
  /** True when a shared block was kept because another tool still references it. */
  readonly retainedSharedBlock: boolean;
}

/**
 * Remove one tool's installed outputs for an item (files + manifest entry),
 * pruning directories left empty inside the tool's config dir. Caller is
 * responsible for confirming removal of locally-modified items.
 */
export function removeItem(projectRoot: string, manifest: Manifest, id: string, tool: ToolId = 'claude'): RemoveOutcome {
  const entry = getToolEntry(manifest, id, tool);
  if (!entry) {
    return { manifest, removedFiles: false, retainedSharedBlock: false };
  }
  const adapter = getAdapter(tool);
  const toolDir = path.join(projectRoot, adapter.configDirName);
  const envelope = projectWriteEnvelope(projectRoot);
  const nextManifest = withoutToolEntry(manifest, id, tool);
  let removedFiles = false;
  let retainedSharedBlock = false;

  for (const output of entry.outputs) {
    if (output.kind === 'owned-tree') {
      const targetPath = absoluteRootPath(projectRoot, output.rootPath);
      assertInside(toolDir, targetPath);
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
        pruneEmptyDirs(path.dirname(targetPath), toolDir);
        removedFiles = true;
      }
    } else {
      // Shared block: physically removed only when no other (item, tool) entry still references it.
      if (blockReferences(nextManifest, output.filePath, output.blockId) > 0) {
        retainedSharedBlock = true;
        continue;
      }
      const filePath = absoluteRootPath(projectRoot, output.filePath);
      assertWritable(envelope, filePath);
      if (!fs.existsSync(filePath)) continue;
      const remaining = removeBlock(fs.readFileSync(filePath, 'utf8'), output.blockId, markerStyleFor(output.filePath), filePath);
      if (remaining === null) {
        fs.rmSync(filePath, { force: true });
      } else {
        fs.writeFileSync(filePath, remaining);
      }
      removedFiles = true;
    }
  }
  return { manifest: nextManifest, removedFiles, retainedSharedBlock };
}

/** Write rendered outputs to disk inside the write envelope. */
function writeOutputs(projectRoot: string, tool: ToolId, outputs: readonly RenderedOutput[]): void {
  const adapter = getAdapter(tool);
  const envelope = projectWriteEnvelope(projectRoot);
  const toolDir = path.join(projectRoot, adapter.configDirName);

  for (const output of outputs) {
    if (output.kind === 'owned-tree') {
      if (!output.rootPath.startsWith(`${adapter.configDirName}/`)) {
        throw new SynlinError(`Adapter ${tool} rendered an owned tree outside its config dir: ${output.rootPath}`, 1);
      }
      const targetPath = absoluteRootPath(projectRoot, output.rootPath);
      assertWritable(envelope, targetPath);
      assertInside(toolDir, targetPath);
      writeOwnedTree(targetPath, output);
    } else {
      const isDeclaredShared = adapter.sharedFiles.includes(output.filePath);
      const isToolInternal = output.filePath.startsWith(`${adapter.configDirName}/`);
      if (!isDeclaredShared && !isToolInternal) {
        throw new SynlinError(`Adapter ${tool} rendered a block into an undeclared shared file: ${output.filePath}`, 1);
      }
      const filePath = absoluteRootPath(projectRoot, output.filePath);
      assertWritable(envelope, filePath);
      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
      fs.writeFileSync(filePath, upsertBlock(existing, output.blockId, output.body, markerStyleFor(output.filePath), filePath));
    }
  }
}

/** Write an owned-tree output to disk, replacing the target. Mirrors copyPath semantics. */
function writeOwnedTree(absoluteRoot: string, output: OwnedTreeOutput): void {
  fs.rmSync(absoluteRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(absoluteRoot), { recursive: true });
  if (output.isFile) {
    if (output.files.length !== 1 || output.files[0] === undefined) {
      throw new SynlinError(`Single-file output at ${output.rootPath} must contain exactly one file`, 1);
    }
    fs.writeFileSync(absoluteRoot, output.files[0].content);
    return;
  }
  for (const file of output.files) {
    const destination = path.join(absoluteRoot, ...file.relativePath.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content);
  }
}

function adopted(options: InstallOptions, tool: ToolId, outputs: readonly RenderedOutput[], action: InstallAction): InstallOutcome {
  const { item, manifest, now } = options;
  const previous = getToolEntry(manifest, item.id, tool);
  const records = toOutputRecords(outputs);
  const hash = installedEntryHash(options.projectRoot, records);
  if (hash === null) {
    throw new SynlinError(`Outputs for ${item.id} are missing right after writing them`, 1);
  }
  const entry: ToolEntry = {
    hash,
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
    outputs: records,
  };
  return { result: { id: item.id, tool, action }, manifest: withToolEntry(manifest, item.id, tool, entry) };
}

function outcome(options: InstallOptions, tool: ToolId, action: InstallAction, detail?: string): InstallOutcome {
  return {
    result: { id: options.item.id, tool, action, ...(detail !== undefined ? { detail } : {}) },
    manifest: options.manifest,
  };
}

function pruneEmptyDirs(startDir: string, stopDir: string): void {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  while (current !== stop && current.startsWith(stop)) {
    const entries = fs.existsSync(current) ? fs.readdirSync(current) : [];
    const junkOnly = entries.every((name) => name === '.DS_Store');
    if (entries.length > 0 && !junkOnly) return;
    if (fs.existsSync(current)) {
      fs.rmSync(current, { recursive: true, force: true });
    }
    current = path.dirname(current);
  }
}
