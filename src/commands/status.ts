import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import type { Category } from '../lib/categories.js';
import { CATEGORIES } from '../lib/categories.js';
import { hashTree } from '../lib/hash.js';
import type { ItemStatus } from '../lib/installer.js';
import { computeStatus } from '../lib/installer.js';
import type { CatalogItem } from '../lib/library.js';
import type { Manifest } from '../lib/manifest.js';
import { installedTools, readManifest } from '../lib/manifest.js';
import { detectToolDirs, getAdapter } from '../lib/tools/registry.js';
import type { ToolId } from '../lib/tools/types.js';
import { TOOL_IDS } from '../lib/tools/types.js';
import type { Runtime } from './context.js';
import { defaultRuntime, loadCatalog, optionalProjectRoot, resolveTargets, statusLabel } from './context.js';

export interface StatusOptions {
  readonly global?: boolean;
}

export async function statusCommand(options: StatusOptions, runtime: Runtime = defaultRuntime()): Promise<void> {
  if (options.global === true) {
    const { catalog } = loadCatalog(runtime);
    printGlobalStatus(scanGlobalSetup(os.homedir(), catalog.items));
    return;
  }
  const { catalog } = loadCatalog(runtime);
  const projectRoot = optionalProjectRoot(runtime);
  if (projectRoot === null) {
    console.log(pc.yellow('Not inside a project (no .synlin.json or tool config dir found).'));
    console.log(pc.dim('Run "synlin init" to set one up, or "synlin status --global" for the global overview.'));
    return;
  }
  printProjectStatus(collectProjectStatus(projectRoot, catalog.items));
}

// ---------- project status ----------

export interface ProjectItemStatus {
  readonly id: string;
  readonly tool: ToolId;
  readonly status: ItemStatus;
  readonly viaSharedBlock: boolean;
}

export interface ProjectStatus {
  readonly projectRoot: string;
  readonly targets: readonly ToolId[];
  readonly detectedDirs: readonly ToolId[];
  readonly items: readonly ProjectItemStatus[];
  readonly agentsMdBlocks: readonly string[];
}

export function collectProjectStatus(projectRoot: string, catalogItems: readonly CatalogItem[]): ProjectStatus {
  const manifest = readManifest(projectRoot);
  const items: ProjectItemStatus[] = [];
  const blocks = new Set<string>();

  for (const id of Object.keys(manifest.items).sort()) {
    const libraryItem = catalogItems.find((item) => item.id === id) ?? null;
    for (const tool of installedTools(manifest, id)) {
      const entry = manifest.items[id]?.[tool];
      const viaSharedBlock = entry?.outputs.some((output) => output.kind === 'managed-block') === true;
      if (viaSharedBlock) blocks.add(id);
      items.push({ id, tool, status: computeStatus(projectRoot, manifest, id, libraryItem, tool), viaSharedBlock });
    }
  }
  return {
    projectRoot,
    targets: resolveTargets(manifest),
    detectedDirs: detectToolDirs(projectRoot),
    items,
    agentsMdBlocks: [...blocks].sort(),
  };
}

function printProjectStatus(status: ProjectStatus): void {
  console.log(pc.bold(`Project: ${status.projectRoot}`));
  const dirNote = (tool: ToolId): string => (status.detectedDirs.includes(tool) ? '' : pc.yellow(' (config dir missing)'));
  console.log(`Targets: ${status.targets.map((tool) => `${tool}${dirNote(tool)}`).join(', ')}`);
  const extraDirs = status.detectedDirs.filter((tool) => !status.targets.includes(tool));
  if (extraDirs.length > 0) {
    console.log(pc.dim(`Tool dirs present but not configured as targets: ${extraDirs.join(', ')} — "synlin targets add <tool>"`));
  }

  if (status.items.length === 0) {
    console.log('\nNo synlin-managed items installed.');
    return;
  }

  console.log('');
  let currentId = '';
  for (const item of status.items) {
    if (item.id !== currentId) {
      currentId = item.id;
      console.log(`  ${item.id}`);
    }
    const block = item.viaSharedBlock ? pc.dim(' · AGENTS.md block') : '';
    console.log(`      ${item.tool.padEnd(10)} [${statusLabel(item.status) || pc.green('installed')}]${block}`);
  }

  const attention = status.items.filter((item) => item.status !== 'up-to-date');
  console.log('');
  if (attention.length === 0) {
    console.log(pc.green(`All ${status.items.length} installs up to date.`));
  } else {
    const counts = new Map<ItemStatus, number>();
    for (const item of attention) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    const parts = [...counts.entries()].map(([state, count]) => `${count} ${state}`);
    console.log(`${status.items.length - attention.length} up to date, ${parts.join(', ')}.`);
    console.log(pc.dim('Run "synlin update --dry-run" for details, "synlin import <path>" to keep local edits.'));
  }
}

// ---------- global status ----------

export type LibraryMatch = 'identical' | 'diverged' | 'unmanaged';

export interface GlobalItem {
  readonly tool: ToolId;
  readonly category: Category;
  readonly name: string;
  /** Match against the synlin library, where the on-disk format is canonical. */
  readonly match: LibraryMatch | null;
}

export interface GlobalStatus {
  readonly entries: readonly GlobalItem[];
  readonly instructionFiles: ReadonlyArray<readonly [ToolId, string]>;
}

/** Global config locations per tool, relative to the home directory. */
function globalCategoryDirs(tool: ToolId): ReadonlyArray<readonly [Category, string]> {
  switch (tool) {
    case 'claude':
      return [
        ['skills', '.claude/skills'],
        ['agents', '.claude/agents'],
        ['commands', '.claude/commands'],
        ['rules', '.claude/rules'],
      ];
    case 'codex':
      return [['skills', '.codex/skills']];
    case 'cursor':
      return [
        ['skills', '.cursor/skills'],
        ['agents', '.cursor/agents'],
        ['commands', '.cursor/commands'],
      ];
    case 'opencode':
      return [
        ['skills', '.config/opencode/skills'],
        ['agents', '.config/opencode/agents'],
        ['commands', '.config/opencode/commands'],
      ];
  }
}

function globalInstructionFiles(tool: ToolId): readonly string[] {
  switch (tool) {
    case 'claude':
      return ['.claude/CLAUDE.md'];
    case 'codex':
      return ['.codex/AGENTS.md'];
    case 'cursor':
      return [];
    case 'opencode':
      return ['.config/opencode/AGENTS.md'];
  }
}

/** Canonical-format pairs where a content-hash match against the library is meaningful. */
function isCanonicalOnDisk(tool: ToolId, category: Category): boolean {
  return tool === 'claude' || category === 'skills';
}

export function scanGlobalSetup(homeDir: string, catalogItems: readonly CatalogItem[]): GlobalStatus {
  const entries: GlobalItem[] = [];
  const instructionFiles: Array<readonly [ToolId, string]> = [];

  for (const tool of TOOL_IDS) {
    for (const [category, relativeDir] of globalCategoryDirs(tool)) {
      const dir = path.join(homeDir, ...relativeDir.split('/'));
      if (!fs.existsSync(dir)) continue;
      for (const entryName of fs.readdirSync(dir).sort()) {
        const itemPath = path.join(dir, entryName);
        const stat = fs.statSync(itemPath);
        const isDir = stat.isDirectory();
        if (category === 'skills' ? !isDir : isDir && category !== 'rules') continue;
        const name = parseGlobalName(category, entryName, itemPath);
        if (name === null) continue;
        entries.push({
          tool,
          category,
          name,
          match: isCanonicalOnDisk(tool, category) ? matchAgainstLibrary(catalogItems, category, name, itemPath) : null,
        });
      }
    }
    for (const relativeFile of globalInstructionFiles(tool)) {
      const filePath = path.join(homeDir, ...relativeFile.split('/'));
      if (fs.existsSync(filePath)) {
        instructionFiles.push([tool, `~/${relativeFile}`]);
      }
    }
  }
  return { entries, instructionFiles };
}

function parseGlobalName(category: Category, entryName: string, itemPath: string): string | null {
  if (category === 'skills') {
    return fs.existsSync(path.join(itemPath, 'SKILL.md')) ? entryName : null;
  }
  if (category === 'rules' && fs.statSync(itemPath).isDirectory()) {
    return null; // rule groups handled as flat *.md only at global level (keep simple)
  }
  return entryName.endsWith('.md') ? entryName.slice(0, -3) : null;
}

function matchAgainstLibrary(catalogItems: readonly CatalogItem[], category: Category, name: string, itemPath: string): LibraryMatch {
  const libraryItem = catalogItems.find((item) => item.category === category && (item.name === name || item.name.endsWith(`/${name}`)));
  if (!libraryItem) return 'unmanaged';
  return hashTree(itemPath) === hashTree(libraryItem.sourcePath) ? 'identical' : 'diverged';
}

function printGlobalStatus(status: GlobalStatus): void {
  console.log(pc.bold('Global setup (~/)'));
  if (status.entries.length === 0 && status.instructionFiles.length === 0) {
    console.log('No global agent config found.');
    return;
  }

  for (const tool of TOOL_IDS) {
    const toolEntries = status.entries.filter((entry) => entry.tool === tool);
    const instructions = status.instructionFiles.filter(([t]) => t === tool);
    if (toolEntries.length === 0 && instructions.length === 0) continue;

    console.log(pc.bold(`\n${getAdapter(tool).displayName}`));
    for (const [, file] of instructions) {
      console.log(`  ${file} ${pc.dim('(global instructions)')}`);
    }
    for (const category of CATEGORIES) {
      const items = toolEntries.filter((entry) => entry.category === category);
      if (items.length === 0) continue;
      console.log(`  ${category}:`);
      for (const item of items) {
        console.log(`    ${item.name.padEnd(32)}${matchLabel(item.match)}`);
      }
    }
  }
  console.log('');
  console.log(pc.dim('library match: identical = same as synlin library · diverged = differs from library · unmanaged = not in library'));
}

function matchLabel(match: LibraryMatch | null): string {
  switch (match) {
    case 'identical':
      return pc.green('[identical to library]');
    case 'diverged':
      return pc.yellow('[diverged from library]');
    case 'unmanaged':
      return pc.dim('[not in library]');
    case null:
      return '';
  }
}
