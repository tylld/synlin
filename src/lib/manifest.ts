import fs from 'node:fs';
import path from 'node:path';
import { parseItemId } from './categories.js';
import { SynlinError } from './errors.js';
import { claudeProjectRelativePath } from './tools/claude.js';
import type { ToolId } from './tools/types.js';
import { TOOL_IDS, isToolId } from './tools/types.js';

export const MANIFEST_VERSION = 2;

/**
 * Where an installed (item, tool) pair lives in the project. Recorded at
 * install time so status/remove work even if the adapter's mapping changes
 * or the item disappears from the library. Paths are project-root-relative POSIX.
 */
export type OutputRecord =
  | { readonly kind: 'owned-tree'; readonly rootPath: string }
  | { readonly kind: 'managed-block'; readonly filePath: string; readonly blockId: string };

export interface ToolEntry {
  /** Combined hash of the rendered outputs as installed. */
  readonly hash: string;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly outputs: readonly OutputRecord[];
}

export type ItemEntries = Readonly<Partial<Record<ToolId, ToolEntry>>>;

export interface Manifest {
  readonly version: typeof MANIFEST_VERSION;
  /** Tools this project installs for, in TOOL_IDS order. */
  readonly targets: readonly ToolId[];
  readonly items: Readonly<Record<string, ItemEntries>>;
}

export function emptyManifest(targets: readonly ToolId[] = ['claude']): Manifest {
  return { version: MANIFEST_VERSION, targets: sortTools(targets), items: {} };
}

export function manifestPath(projectRoot: string): string {
  return path.join(projectRoot, '.synlin.json');
}

/** Pre-v2 manifest location, read for migration and deleted on first write. */
export function legacyManifestPath(projectRoot: string): string {
  return path.join(projectRoot, '.claude', '.synlin.json');
}

export function hasManifest(projectRoot: string): boolean {
  return fs.existsSync(manifestPath(projectRoot)) || fs.existsSync(legacyManifestPath(projectRoot));
}

/**
 * Missing files → empty manifest. A legacy v1 manifest is migrated in memory;
 * it is persisted (and the legacy file removed) by the next writeManifest call.
 * Corrupt or future-versioned files are hard errors.
 */
export function readManifest(projectRoot: string): Manifest {
  const rootFile = manifestPath(projectRoot);
  if (fs.existsSync(rootFile)) {
    return parseManifestFile(rootFile);
  }
  const legacyFile = legacyManifestPath(projectRoot);
  if (fs.existsSync(legacyFile)) {
    return parseManifestFile(legacyFile);
  }
  return emptyManifest();
}

/** Atomic write (tmp + rename) with sorted keys; removes the legacy v1 file. */
export function writeManifest(projectRoot: string, manifest: Manifest): void {
  const filePath = manifestPath(projectRoot);
  const sortedItems = Object.fromEntries(
    Object.keys(manifest.items)
      .sort()
      .map((id) => [id, sortedEntries(manifest.items[id] ?? {})]),
  );
  const payload = `${JSON.stringify({ version: manifest.version, targets: sortTools(manifest.targets), items: sortedItems }, null, 2)}\n`;
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, payload);
  fs.renameSync(tmpPath, filePath);

  const legacyFile = legacyManifestPath(projectRoot);
  if (fs.existsSync(legacyFile)) {
    fs.rmSync(legacyFile, { force: true });
  }
}

export function getToolEntry(manifest: Manifest, id: string, tool: ToolId): ToolEntry | undefined {
  return manifest.items[id]?.[tool];
}

/** Tools an item is installed for, in TOOL_IDS order. */
export function installedTools(manifest: Manifest, id: string): readonly ToolId[] {
  const entries = manifest.items[id];
  if (!entries) return [];
  return TOOL_IDS.filter((tool) => entries[tool] !== undefined);
}

/** Immutable update: set one (item, tool) entry. */
export function withToolEntry(manifest: Manifest, id: string, tool: ToolId, entry: ToolEntry): Manifest {
  const existing = manifest.items[id] ?? {};
  return {
    ...manifest,
    items: { ...manifest.items, [id]: { ...existing, [tool]: entry } },
  };
}

/** Immutable update: remove one (item, tool) entry; drops the item when its last tool entry goes. */
export function withoutToolEntry(manifest: Manifest, id: string, tool: ToolId): Manifest {
  const existing = manifest.items[id];
  if (!existing) return manifest;
  const { [tool]: _removed, ...remaining } = existing;
  const { [id]: _item, ...otherItems } = manifest.items;
  if (Object.keys(remaining).length === 0) {
    return { ...manifest, items: otherItems };
  }
  return { ...manifest, items: { ...otherItems, [id]: remaining } };
}

export function withTargets(manifest: Manifest, targets: readonly ToolId[]): Manifest {
  return { ...manifest, targets: sortTools(targets) };
}

/** All (filePath, blockId) references across tools, used to refcount shared blocks. */
export function blockReferences(manifest: Manifest, filePath: string, blockId: string): number {
  let count = 0;
  for (const entries of Object.values(manifest.items)) {
    for (const tool of TOOL_IDS) {
      const entry = entries[tool];
      if (!entry) continue;
      for (const output of entry.outputs) {
        if (output.kind === 'managed-block' && output.filePath === filePath && output.blockId === blockId) {
          count += 1;
        }
      }
    }
  }
  return count;
}

function sortTools(tools: readonly ToolId[]): readonly ToolId[] {
  const unique = new Set(tools);
  return TOOL_IDS.filter((tool) => unique.has(tool));
}

function sortedEntries(entries: ItemEntries): Record<string, ToolEntry> {
  const result: Record<string, ToolEntry> = {};
  for (const tool of TOOL_IDS) {
    const entry = entries[tool];
    if (entry) result[tool] = entry;
  }
  return result;
}

function parseManifestFile(filePath: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SynlinError(`Corrupt manifest at ${filePath}: ${reason}. Fix or delete the file and re-run.`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SynlinError(`Invalid manifest at ${filePath}: expected a JSON object`);
  }
  const candidate = parsed as { version?: unknown };
  if (candidate.version === 1) {
    return migrateV1(parsed, filePath);
  }
  if (candidate.version !== MANIFEST_VERSION) {
    throw new SynlinError(
      `Unsupported manifest version ${String(candidate.version)} at ${filePath} (this synlin supports versions 1-${MANIFEST_VERSION})`,
    );
  }
  return validateV2(parsed, filePath);
}

/** v1 entries were claude-only installs without recorded output locations. */
function migrateV1(parsed: unknown, filePath: string): Manifest {
  const candidate = parsed as { items?: unknown };
  if (typeof candidate.items !== 'object' || candidate.items === null) {
    throw new SynlinError(`Invalid manifest at ${filePath}: "items" must be an object`);
  }
  const items: Record<string, ItemEntries> = {};
  for (const [id, value] of Object.entries(candidate.items)) {
    const ref = parseItemId(id);
    if (!ref) {
      throw new SynlinError(`Invalid manifest entry "${id}" at ${filePath}: not a valid item id`);
    }
    const v1 = validateV1Entry(id, value, filePath);
    items[id] = {
      claude: {
        ...v1,
        outputs: [{ kind: 'owned-tree', rootPath: toPosix(claudeProjectRelativePath(ref)) }],
      },
    };
  }
  return { version: MANIFEST_VERSION, targets: ['claude'], items };
}

function validateV1Entry(id: string, value: unknown, filePath: string): { hash: string; installedAt: string; updatedAt: string } {
  if (typeof value !== 'object' || value === null) {
    throw new SynlinError(`Invalid manifest entry "${id}" at ${filePath}`);
  }
  const entry = value as { hash?: unknown; installedAt?: unknown; updatedAt?: unknown };
  if (typeof entry.hash !== 'string' || typeof entry.installedAt !== 'string' || typeof entry.updatedAt !== 'string') {
    throw new SynlinError(`Invalid manifest entry "${id}" at ${filePath}: hash/installedAt/updatedAt must be strings`);
  }
  return { hash: entry.hash, installedAt: entry.installedAt, updatedAt: entry.updatedAt };
}

function validateV2(parsed: unknown, filePath: string): Manifest {
  const candidate = parsed as { targets?: unknown; items?: unknown };
  if (!Array.isArray(candidate.targets) || !candidate.targets.every((t): t is ToolId => typeof t === 'string' && isToolId(t))) {
    throw new SynlinError(`Invalid manifest at ${filePath}: "targets" must be an array of tool ids (${TOOL_IDS.join(', ')})`);
  }
  if (typeof candidate.items !== 'object' || candidate.items === null) {
    throw new SynlinError(`Invalid manifest at ${filePath}: "items" must be an object`);
  }
  const items: Record<string, ItemEntries> = {};
  for (const [id, value] of Object.entries(candidate.items)) {
    if (typeof value !== 'object' || value === null) {
      throw new SynlinError(`Invalid manifest entry "${id}" at ${filePath}`);
    }
    const entries: Partial<Record<ToolId, ToolEntry>> = {};
    for (const [tool, entry] of Object.entries(value)) {
      if (!isToolId(tool)) {
        throw new SynlinError(`Invalid manifest entry "${id}" at ${filePath}: unknown tool "${tool}"`);
      }
      entries[tool] = validateToolEntry(id, tool, entry, filePath);
    }
    items[id] = entries;
  }
  return { version: MANIFEST_VERSION, targets: sortTools(candidate.targets), items };
}

function validateToolEntry(id: string, tool: string, value: unknown, filePath: string): ToolEntry {
  if (typeof value !== 'object' || value === null) {
    throw new SynlinError(`Invalid manifest entry "${id}" (${tool}) at ${filePath}`);
  }
  const entry = value as { hash?: unknown; installedAt?: unknown; updatedAt?: unknown; outputs?: unknown };
  if (typeof entry.hash !== 'string' || typeof entry.installedAt !== 'string' || typeof entry.updatedAt !== 'string') {
    throw new SynlinError(`Invalid manifest entry "${id}" (${tool}) at ${filePath}: hash/installedAt/updatedAt must be strings`);
  }
  if (!Array.isArray(entry.outputs)) {
    throw new SynlinError(`Invalid manifest entry "${id}" (${tool}) at ${filePath}: "outputs" must be an array`);
  }
  const outputs = entry.outputs.map((output) => validateOutputRecord(id, tool, output, filePath));
  return { hash: entry.hash, installedAt: entry.installedAt, updatedAt: entry.updatedAt, outputs };
}

function validateOutputRecord(id: string, tool: string, value: unknown, filePath: string): OutputRecord {
  if (typeof value !== 'object' || value === null) {
    throw new SynlinError(`Invalid output record in "${id}" (${tool}) at ${filePath}`);
  }
  const record = value as { kind?: unknown; rootPath?: unknown; filePath?: unknown; blockId?: unknown };
  if (record.kind === 'owned-tree' && typeof record.rootPath === 'string') {
    return { kind: 'owned-tree', rootPath: record.rootPath };
  }
  if (record.kind === 'managed-block' && typeof record.filePath === 'string' && typeof record.blockId === 'string') {
    return { kind: 'managed-block', filePath: record.filePath, blockId: record.blockId };
  }
  throw new SynlinError(`Invalid output record in "${id}" (${tool}) at ${filePath}`);
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}
