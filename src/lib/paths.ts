import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, defaultLibraryRoot, readConfig } from './config.js';
import { SynlinError } from './errors.js';

/**
 * Locate the synlin package root by walking up from this module's real path
 * until a package.json with name "synlin" is found. Works from src (tsx),
 * dist (built), and tests — and through npm-link symlink chains, because
 * Node resolves module realpaths by default.
 */
export function findPackageRoot(): string {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let current = start;
  for (;;) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null && (parsed as { name?: unknown }).name === 'synlin') {
          return current;
        }
      } catch {
        // unreadable package.json on the way up — keep walking
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new SynlinError(`Could not locate the synlin package root (started at ${start})`, 1);
    }
    current = parent;
  }
}

/**
 * Resolve where the library SHOULD be, without requiring it to exist:
 * SYNLIN_LIBRARY env var → libraryRoot in ~/.config/synlin/config.json →
 * ~/.synlin/library. The CLI ships no library — every user brings their own.
 */
export function resolveLibraryRoot(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const override = env['SYNLIN_LIBRARY'];
  if (override !== undefined && override !== '') {
    return path.resolve(override);
  }
  const configured = readConfig(homeDir).libraryRoot;
  if (configured !== undefined && configured !== '') {
    return path.resolve(configured);
  }
  return defaultLibraryRoot(homeDir);
}

/** resolveLibraryRoot + existence check, with setup guidance when absent. */
export function findLibraryRoot(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const libraryRoot = resolveLibraryRoot(env, homeDir);
  if (!fs.existsSync(libraryRoot)) {
    throw new SynlinError(
      `Library directory not found at ${libraryRoot}. ` +
        `Run "synlin library init" to create one, or point synlin at an existing library ` +
        `via SYNLIN_LIBRARY or "libraryRoot" in ${configPath(homeDir)}.`,
    );
  }
  return libraryRoot;
}

/** Project config dir names of all supported tools, in registry order. */
const TOOL_DIR_NAMES = ['.claude', '.codex', '.cursor', '.opencode'] as const;
const MANIFEST_FILE_NAME = '.synlin.json';

/**
 * Nearest ancestor of cwd (inclusive) that is a synlin project root.
 * A `.synlin.json` manifest anywhere up the tree wins over a closer tool config
 * dir (resolves nested-tool-dir ambiguity); without a manifest, the nearest
 * ancestor containing any tool config dir (.claude/.codex/.cursor/.opencode).
 * The home directory is skipped — ~/.claude etc. are global config, not projects.
 */
export function findProjectRoot(cwd: string, homeDir: string = os.homedir()): string | null {
  let current = path.resolve(cwd);
  const home = path.resolve(homeDir);
  let toolDirCandidate: string | null = null;
  for (;;) {
    if (current !== home) {
      const manifestStat = fs.statSync(path.join(current, MANIFEST_FILE_NAME), { throwIfNoEntry: false });
      if (manifestStat?.isFile()) {
        return current;
      }
      if (toolDirCandidate === null && hasAnyToolDir(current)) {
        toolDirCandidate = current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return toolDirCandidate;
    }
    current = parent;
  }
}

function hasAnyToolDir(dir: string): boolean {
  return TOOL_DIR_NAMES.some((name) => {
    const stat = fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
    return stat?.isDirectory() === true;
  });
}

/**
 * The set of locations synlin is allowed to write to in a project: the tool
 * config dirs, adapter-declared shared files at the root (AGENTS.md), and the
 * manifest. Everything else is off-limits.
 */
export interface WriteEnvelope {
  readonly projectRoot: string;
  readonly toolDirs: readonly string[];
  readonly sharedFiles: readonly string[];
  readonly manifestFile: string;
}

export function projectWriteEnvelope(projectRoot: string, sharedFileNames: readonly string[] = ['AGENTS.md']): WriteEnvelope {
  const root = path.resolve(projectRoot);
  return {
    projectRoot: root,
    toolDirs: TOOL_DIR_NAMES.map((name) => path.join(root, name)),
    sharedFiles: sharedFileNames.map((name) => path.join(root, name)),
    manifestFile: path.join(root, MANIFEST_FILE_NAME),
  };
}

/** Containment guard for the multi-tool world; see WriteEnvelope. */
export function assertWritable(envelope: WriteEnvelope, targetPath: string): void {
  const target = path.resolve(targetPath);
  const insideToolDir = envelope.toolDirs.some((dir) => target === dir || isInside(dir, target));
  const isSharedFile = envelope.sharedFiles.includes(target);
  const isManifest = target === envelope.manifestFile;
  if (!insideToolDir && !isSharedFile && !isManifest) {
    throw new SynlinError(`Refusing to touch ${target}: outside the synlin write envelope of ${envelope.projectRoot}`, 1);
  }
}

export interface InstallTargetGuardOptions {
  readonly homeDir?: string;
  readonly packageRoot?: string;
}

/**
 * Refuse install targets that are not real projects: the home directory
 * (global Claude config) and the synlin checkout itself (the library source).
 */
export function assertSafeInstallTarget(projectRoot: string, options: InstallTargetGuardOptions = {}): void {
  const resolved = realpathOrSelf(path.resolve(projectRoot));
  const home = realpathOrSelf(path.resolve(options.homeDir ?? os.homedir()));
  if (resolved === home) {
    throw new SynlinError(
      'Refusing to install into the home directory — ~/.claude is global config, not a project. cd into a project first.',
    );
  }
  const packageRoot = realpathOrSelf(path.resolve(options.packageRoot ?? findPackageRoot()));
  if (resolved === packageRoot || isInside(packageRoot, resolved)) {
    throw new SynlinError('Refusing to install into the synlin checkout — that is the library source, not a target project.');
  }
}

/** Containment guard: every write/delete must stay inside the project's .claude directory. */
export function assertInside(parentDir: string, targetPath: string): void {
  const parent = path.resolve(parentDir);
  const target = path.resolve(targetPath);
  if (!isInside(parent, target) && target !== parent) {
    throw new SynlinError(`Refusing to touch ${target}: outside of ${parent}`, 1);
  }
}

function isInside(parentDir: string, targetPath: string): boolean {
  const relative = path.relative(parentDir, targetPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Realpath that tolerates missing leaves: resolves the deepest existing
 * ancestor and re-joins the rest (macOS /var vs /private/var consistency).
 */
function realpathOrSelf(somePath: string): string {
  const suffix: string[] = [];
  let current = somePath;
  for (;;) {
    try {
      const resolved = fs.realpathSync(current);
      return suffix.length === 0 ? resolved : path.join(resolved, ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return somePath;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}
