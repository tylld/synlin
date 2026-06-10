import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SynlinError } from './errors.js';

/**
 * User-level synlin configuration (~/.config/synlin/config.json).
 * Currently just the library location; the CLI ships no library of its own.
 */
export interface SynlinConfig {
  readonly libraryRoot?: string;
}

export function configPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.config', 'synlin', 'config.json');
}

export function defaultLibraryRoot(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.synlin', 'library');
}

/** Missing file → empty config. Corrupt files are hard errors (they are user-edited). */
export function readConfig(homeDir: string = os.homedir()): SynlinConfig {
  const filePath = configPath(homeDir);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SynlinError(`Corrupt config at ${filePath}: ${reason}. Fix or delete the file.`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SynlinError(`Invalid config at ${filePath}: expected a JSON object`);
  }
  const candidate = parsed as { libraryRoot?: unknown };
  if (candidate.libraryRoot !== undefined && typeof candidate.libraryRoot !== 'string') {
    throw new SynlinError(`Invalid config at ${filePath}: "libraryRoot" must be a string path`);
  }
  return candidate.libraryRoot !== undefined ? { libraryRoot: candidate.libraryRoot } : {};
}

export function writeConfig(config: SynlinConfig, homeDir: string = os.homedir()): void {
  const filePath = configPath(homeDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`);
}
