import path from 'node:path';
import type { Category, ItemRef } from '../categories.js';
import { isValidItemName } from '../categories.js';
import { SynlinError } from '../errors.js';
import type { CatalogItem } from '../library.js';
import { verbatimTree } from './render.js';
import type { RenderedItem, SupportLevel, ToolAdapter } from './types.js';

/**
 * Path of an installed item relative to the project root, for Claude Code.
 * This is the canonical (identity) mapping — the library stores items in
 * Claude format, so rendering is a verbatim copy.
 */
export function claudeProjectRelativePath(ref: ItemRef): string {
  if (!isValidItemName(ref.category, ref.name)) {
    throw new SynlinError(`Invalid item name "${ref.name}" for category "${ref.category}"`);
  }
  switch (ref.category) {
    case 'skills':
      return path.join('.claude', 'skills', ref.name);
    case 'agents':
      return path.join('.claude', 'agents', `${ref.name}.md`);
    case 'commands':
      return path.join('.claude', 'commands', `${ref.name}.md`);
    case 'rules':
      return path.join('.claude', 'rules', `${ref.name}.md`);
    case 'templates':
      return path.join('.claude', ref.name);
  }
}

export const claudeAdapter: ToolAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  configDirName: '.claude',
  sharedFiles: [],
  supports(_category: Category): SupportLevel {
    return 'supported';
  },
  unsupportedReason(_category: Category): string | undefined {
    return undefined;
  },
  render(item: CatalogItem): RenderedItem {
    return { outputs: [verbatimTree(item, claudeProjectRelativePath(item))] };
  },
};
