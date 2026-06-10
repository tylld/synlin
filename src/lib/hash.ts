import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isJunkDir, isJunkFile } from './categories.js';
import { SynlinError } from './errors.js';

/**
 * List all files under rootPath as sorted POSIX relative paths, junk-filtered.
 * If rootPath is a single file, returns its basename — so a library file and its
 * installed copy produce identical file lists regardless of parent directory.
 */
export function walkFiles(rootPath: string): readonly string[] {
  const stat = fs.statSync(rootPath, { throwIfNoEntry: false });
  if (!stat) {
    throw new SynlinError(`Path does not exist: ${rootPath}`);
  }
  if (stat.isFile()) {
    return [path.basename(rootPath)];
  }
  const files: string[] = [];
  collectFiles(rootPath, '', files);
  return Object.freeze(files.sort());
}

function collectFiles(absoluteDir: string, relativeDir: string, accumulator: string[]): void {
  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!isJunkDir(entry.name)) {
        collectFiles(path.join(absoluteDir, entry.name), relative, accumulator);
      }
    } else if (!isJunkFile(entry.name)) {
      accumulator.push(relative);
    }
  }
}

/**
 * Deterministic content hash of a file or directory tree.
 * Format: "sha256:<hex>". Junk files are excluded so .DS_Store noise
 * never shows up as a local modification.
 */
export function hashTree(rootPath: string): string {
  const files = walkFiles(rootPath);
  const stat = fs.statSync(rootPath);
  const baseDir = stat.isFile() ? path.dirname(rootPath) : rootPath;
  const hash = createHash('sha256');
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(baseDir, relativePath.split('/').join(path.sep))));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** hashTree, but null when the path is missing (used for status detection). */
export function hashTreeIfExists(rootPath: string): string | null {
  const stat = fs.statSync(rootPath, { throwIfNoEntry: false });
  if (!stat) return null;
  return hashTree(rootPath);
}

/**
 * hashTree over in-memory rendered files instead of a directory on disk.
 * MUST stay byte-for-byte equivalent to hashTree for the same file set —
 * three-way status compares hashes from both sources.
 */
export function hashVirtualTree(files: ReadonlyArray<{ readonly relativePath: string; readonly content: Buffer }>): string {
  const sorted = [...files].sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  const hash = createHash('sha256');
  for (const file of sorted) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(file.content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}
