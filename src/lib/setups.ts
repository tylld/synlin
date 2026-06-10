import fs from 'node:fs';
import path from 'node:path';
import { SynlinError } from './errors.js';
import type { ToolId } from './tools/types.js';
import { TOOL_IDS, isToolId } from './tools/types.js';

/**
 * A named setup: a saved set of library item ids (plus the targets they were
 * saved with) that can be applied to other projects in one command. Stored in
 * the library repo under setups/ so it syncs via git like everything else.
 */
export interface Setup {
  readonly name: string;
  readonly items: readonly string[];
  readonly targets: readonly ToolId[];
  readonly savedAt: string;
}

const SETUP_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export function isValidSetupName(name: string): boolean {
  return SETUP_NAME.test(name) && !name.includes('..');
}

export function setupsDir(libraryRoot: string): string {
  return path.join(libraryRoot, 'setups');
}

export function setupPath(libraryRoot: string, name: string): string {
  if (!isValidSetupName(name)) {
    throw new SynlinError(`Invalid setup name "${name}" (lowercase, [a-z0-9._-])`);
  }
  return path.join(setupsDir(libraryRoot), `${name}.json`);
}

export function listSetups(libraryRoot: string): readonly Setup[] {
  const dir = setupsDir(libraryRoot);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => readSetup(libraryRoot, file.slice(0, -5)));
}

export function readSetup(libraryRoot: string, name: string): Setup {
  const filePath = setupPath(libraryRoot, name);
  if (!fs.existsSync(filePath)) {
    throw new SynlinError(`Setup "${name}" does not exist. "synlin setup" lists available setups.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SynlinError(`Corrupt setup file at ${filePath}: ${reason}`);
  }
  return validateSetup(parsed, name, filePath);
}

/** Atomic write with sorted items for stable git diffs. */
export function writeSetup(libraryRoot: string, setup: Setup): void {
  const filePath = setupPath(libraryRoot, setup.name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = `${JSON.stringify(
    {
      name: setup.name,
      items: [...setup.items].sort(),
      targets: TOOL_IDS.filter((tool) => setup.targets.includes(tool)),
      savedAt: setup.savedAt,
    },
    null,
    2,
  )}\n`;
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, payload);
  fs.renameSync(tmpPath, filePath);
}

export function deleteSetup(libraryRoot: string, name: string): void {
  const filePath = setupPath(libraryRoot, name);
  if (!fs.existsSync(filePath)) {
    throw new SynlinError(`Setup "${name}" does not exist.`);
  }
  fs.rmSync(filePath, { force: true });
}

export function setupExists(libraryRoot: string, name: string): boolean {
  return fs.existsSync(setupPath(libraryRoot, name));
}

function validateSetup(parsed: unknown, name: string, filePath: string): Setup {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SynlinError(`Invalid setup file at ${filePath}: expected a JSON object`);
  }
  const candidate = parsed as { name?: unknown; items?: unknown; targets?: unknown; savedAt?: unknown };
  if (!Array.isArray(candidate.items) || !candidate.items.every((item): item is string => typeof item === 'string')) {
    throw new SynlinError(`Invalid setup file at ${filePath}: "items" must be an array of item ids`);
  }
  if (!Array.isArray(candidate.targets) || !candidate.targets.every((tool): tool is ToolId => typeof tool === 'string' && isToolId(tool))) {
    throw new SynlinError(`Invalid setup file at ${filePath}: "targets" must be an array of tool ids`);
  }
  return {
    name,
    items: candidate.items,
    targets: candidate.targets,
    savedAt: typeof candidate.savedAt === 'string' ? candidate.savedAt : '',
  };
}
