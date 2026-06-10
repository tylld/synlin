import path from 'node:path';
import { SynlinError } from './errors.js';

export const CATEGORIES = ['skills', 'agents', 'commands', 'rules', 'templates'] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * A reference to a library item.
 * `name` is the bare item name; for rules it is "group/name" (e.g. "common/coding-style"),
 * for templates it is the full file name including extension (e.g. "hooks.json").
 */
export interface ItemRef {
  readonly category: Category;
  readonly name: string;
}

const NAME_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const JUNK_DIRS = new Set(['__pycache__', 'node_modules', '.git']);
const JUNK_EXTENSIONS = new Set(['.pyc']);

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/** Files/dirs that must never be copied or hashed. */
export function isJunkFile(fileName: string): boolean {
  return JUNK_FILES.has(fileName) || JUNK_EXTENSIONS.has(path.extname(fileName));
}

export function isJunkDir(dirName: string): boolean {
  return JUNK_DIRS.has(dirName);
}

function isValidSegment(segment: string): boolean {
  return NAME_SEGMENT.test(segment) && !segment.includes('..');
}

/** Validate an item name at the boundary (defense against path traversal). */
export function isValidItemName(category: Category, name: string): boolean {
  const segments = name.split('/');
  if (category === 'rules') {
    return segments.length <= 2 && segments.every(isValidSegment);
  }
  return segments.length === 1 && isValidSegment(name);
}

export function itemId(ref: ItemRef): string {
  return `${ref.category}/${ref.name}`;
}

/** Parse a qualified id like "skills/nodejs" or "rules/common/coding-style". Returns null if not qualified/valid. */
export function parseItemId(id: string): ItemRef | null {
  const slash = id.indexOf('/');
  if (slash === -1) return null;
  const category = id.slice(0, slash);
  const name = id.slice(slash + 1);
  if (!isCategory(category) || name.length === 0) return null;
  if (!isValidItemName(category, name)) return null;
  return { category, name };
}

/** True when items of this category are directories rather than single files. */
export function isDirectoryCategory(category: Category): boolean {
  return category === 'skills';
}

/** Path of an item relative to the library root. */
export function libraryRelativePath(ref: ItemRef): string {
  assertValidRef(ref);
  switch (ref.category) {
    case 'skills':
      return path.join('skills', ref.name);
    case 'agents':
      return path.join('agents', `${ref.name}.md`);
    case 'commands':
      return path.join('commands', `${ref.name}.md`);
    case 'rules':
      return path.join('rules', `${ref.name}.md`);
    case 'templates':
      return path.join('templates', ref.name);
  }
}

function assertValidRef(ref: ItemRef): void {
  if (!isValidItemName(ref.category, ref.name)) {
    throw new SynlinError(`Invalid item name "${ref.name}" for category "${ref.category}"`);
  }
}
