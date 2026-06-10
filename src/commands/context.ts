import fs from 'node:fs';
import path from 'node:path';
import { confirm, isCancel } from '@clack/prompts';
import pc from 'picocolors';
import { SynlinError } from '../lib/errors.js';
import type { ItemStatus } from '../lib/installer.js';
import type { Catalog } from '../lib/library.js';
import { scanLibrary } from '../lib/library.js';
import type { Manifest } from '../lib/manifest.js';
import { assertSafeInstallTarget, findLibraryRoot, findProjectRoot, resolveLibraryRoot } from '../lib/paths.js';
import type { ToolId } from '../lib/tools/types.js';
import { TOOL_IDS, isToolId } from '../lib/tools/types.js';

/** Injectable runtime so command handlers are testable without a TTY. */
export interface Runtime {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly interactive: boolean;
}

export function defaultRuntime(): Runtime {
  return {
    cwd: process.cwd(),
    env: process.env,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
}

export interface CatalogContext {
  readonly libraryRoot: string;
  readonly catalog: Catalog;
}

export function loadCatalog(runtime: Runtime): CatalogContext {
  const libraryRoot = findLibraryRoot(runtime.env);
  const catalog = scanLibrary(libraryRoot);
  for (const warning of catalog.warnings) {
    console.warn(pc.yellow(`library warning: ${warning}`));
  }
  return { libraryRoot, catalog };
}

/**
 * Locate the project to operate on. When none exists: interactive runs may
 * create .claude/ in cwd after confirmation; non-interactive runs fail.
 */
export async function ensureProjectRoot(runtime: Runtime): Promise<string> {
  const existing = findProjectRoot(runtime.cwd);
  if (existing !== null) {
    assertSafeInstallTarget(existing);
    assertNotLibrary(existing, runtime);
    return existing;
  }
  assertSafeInstallTarget(runtime.cwd);
  assertNotLibrary(runtime.cwd, runtime);
  if (!runtime.interactive) {
    throw new SynlinError(`No .claude directory found at or above ${runtime.cwd}. Run "synlin init" in the project first.`);
  }
  const create = await confirm({ message: `No .claude directory found. Create one in ${runtime.cwd}?` });
  if (isCancel(create) || create !== true) {
    throw new SynlinError('Aborted: no project to install into.', 0);
  }
  fs.mkdirSync(path.join(runtime.cwd, '.claude'), { recursive: true });
  return runtime.cwd;
}

/** The library is the source of items, never an install target. */
function assertNotLibrary(projectRoot: string, runtime: Runtime): void {
  const libraryRoot = resolveLibraryRoot(runtime.env);
  const resolved = path.resolve(projectRoot);
  if (resolved === libraryRoot || resolved.startsWith(libraryRoot + path.sep)) {
    throw new SynlinError('Refusing to install into the library itself — it is the source of items, not a target project.');
  }
}

/** Project root for read-only commands: null when not inside a project. */
export function optionalProjectRoot(runtime: Runtime): string | null {
  return findProjectRoot(runtime.cwd);
}

export function requireProjectRoot(runtime: Runtime): string {
  const projectRoot = findProjectRoot(runtime.cwd);
  if (projectRoot === null) {
    throw new SynlinError(`No .claude directory found at or above ${runtime.cwd}. Run "synlin init" first.`);
  }
  return projectRoot;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The tools a command should operate on: the project's configured targets,
 * optionally narrowed by --tool flags. Unknown or unconfigured tools are errors.
 */
export function resolveTargets(manifest: Manifest, toolFlags?: readonly string[]): readonly ToolId[] {
  const configured: readonly ToolId[] = manifest.targets.length > 0 ? manifest.targets : ['claude'];
  if (toolFlags === undefined || toolFlags.length === 0) {
    return configured;
  }
  const requested = new Set<ToolId>();
  for (const flag of toolFlags) {
    if (!isToolId(flag)) {
      throw new SynlinError(`Unknown tool "${flag}". Valid tools: ${TOOL_IDS.join(', ')}`);
    }
    if (!configured.includes(flag)) {
      throw new SynlinError(`${flag} is not a configured target in this project — run "synlin targets add ${flag}" first.`);
    }
    requested.add(flag);
  }
  return TOOL_IDS.filter((tool) => requested.has(tool));
}

export function statusLabel(status: ItemStatus): string {
  switch (status) {
    case 'up-to-date':
      return pc.green('installed');
    case 'update-available':
      return pc.cyan('update available');
    case 'modified':
      return pc.yellow('modified locally');
    case 'conflict':
      return pc.red('conflict');
    case 'files-missing':
      return pc.red('files missing');
    case 'gone-from-library':
      return pc.red('missing from library');
    case 'not-installed':
      return '';
  }
}

export function truncate(text: string, maxLength = 70): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
