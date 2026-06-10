import fs from 'node:fs';
import path from 'node:path';
import { walkFiles } from './hash.js';

/**
 * Copy a file or directory tree, junk-filtered, replacing any existing target.
 * The junk filter shares walkFiles with hashing, so what gets copied is
 * exactly what gets hashed.
 */
export function copyPath(sourcePath: string, targetPath: string): void {
  const stat = fs.statSync(sourcePath);
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (stat.isFile()) {
    fs.copyFileSync(sourcePath, targetPath);
    return;
  }
  for (const relativeFile of walkFiles(sourcePath)) {
    const segments = relativeFile.split('/');
    const destination = path.join(targetPath, ...segments);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(sourcePath, ...segments), destination);
  }
}

export interface TreeDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/** File-level diff between two trees (or single files), by content. */
export function diffTrees(sourcePath: string, targetPath: string): TreeDiff {
  const sourceFiles = new Set(walkFiles(sourcePath));
  const targetFiles = new Set(walkFiles(targetPath));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const file of [...sourceFiles].sort()) {
    if (!targetFiles.has(file)) {
      added.push(file);
    } else if (!sameContent(resolveIn(sourcePath, file), resolveIn(targetPath, file))) {
      changed.push(file);
    }
  }
  for (const file of [...targetFiles].sort()) {
    if (!sourceFiles.has(file)) {
      removed.push(file);
    }
  }
  return { added, removed, changed };
}

function resolveIn(rootPath: string, relativeFile: string): string {
  const stat = fs.statSync(rootPath);
  const baseDir = stat.isFile() ? path.dirname(rootPath) : rootPath;
  return path.join(baseDir, ...relativeFile.split('/'));
}

function sameContent(fileA: string, fileB: string): boolean {
  return fs.readFileSync(fileA).equals(fs.readFileSync(fileB));
}
