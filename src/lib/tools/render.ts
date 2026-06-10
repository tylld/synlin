import fs from 'node:fs';
import path from 'node:path';
import type { CatalogItem } from '../library.js';
import { walkFiles } from '../hash.js';
import type { OwnedTreeOutput, RenderedFile } from './types.js';

/** Read a library item's files (junk-filtered, sorted) for rendering. */
export function readItemFiles(item: CatalogItem): { readonly isFile: boolean; readonly files: readonly RenderedFile[] } {
  const stat = fs.statSync(item.sourcePath);
  const isFile = stat.isFile();
  const files = walkFiles(item.sourcePath).map((relativePath) => ({
    relativePath,
    content: fs.readFileSync(isFile ? item.sourcePath : path.join(item.sourcePath, ...relativePath.split('/'))),
  }));
  return { isFile, files };
}

/** Verbatim owned-tree output rooted at rootPath (project-root-relative POSIX). */
export function verbatimTree(item: CatalogItem, rootPath: string): OwnedTreeOutput {
  const { isFile, files } = readItemFiles(item);
  return { kind: 'owned-tree', rootPath, isFile, files };
}

/** Single transformed text file as an owned tree (relativePath = basename, like walkFiles). */
export function singleFileTree(rootPath: string, content: string): OwnedTreeOutput {
  const basename = rootPath.split('/').at(-1) ?? rootPath;
  return {
    kind: 'owned-tree',
    rootPath,
    isFile: true,
    files: [{ relativePath: basename, content: Buffer.from(content, 'utf8') }],
  };
}

/** UTF-8 source of a single-file library item. */
export function readItemText(item: CatalogItem): string {
  return fs.readFileSync(item.sourcePath, 'utf8');
}
