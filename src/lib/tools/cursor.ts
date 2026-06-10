import type { Category } from '../categories.js';
import { SynlinError } from '../errors.js';
import { firstHeading } from '../frontmatter.js';
import type { CatalogItem } from '../library.js';
import { frontmatterData, stripFrontmatter } from './markdown.js';
import { readItemText, singleFileTree, verbatimTree } from './render.js';
import { isReadonlyToolSet, parseToolsCsv } from './tool-names.js';
import type { RenderedItem, SupportLevel, ToolAdapter } from './types.js';
import { withFrontmatter } from './yaml.js';

const UNSUPPORTED_REASONS: Partial<Record<Category, string>> = {
  templates: 'templates are Claude Code settings files with no Cursor equivalent',
};

export const cursorAdapter: ToolAdapter = {
  id: 'cursor',
  displayName: 'Cursor',
  configDirName: '.cursor',
  sharedFiles: [],
  supports(category: Category): SupportLevel {
    return category === 'templates' ? 'unsupported' : 'supported';
  },
  unsupportedReason(category: Category): string | undefined {
    return UNSUPPORTED_REASONS[category];
  },
  render(item: CatalogItem): RenderedItem {
    switch (item.category) {
      case 'skills':
        // Cursor 2.4+ reads .cursor/skills/<name>/SKILL.md; unknown frontmatter is ignored.
        return { outputs: [verbatimTree(item, `.cursor/skills/${item.name}`)] };
      case 'agents':
        return { outputs: [singleFileTree(`.cursor/agents/${item.name}.md`, renderAgent(item))] };
      case 'commands':
        // Cursor commands are plain markdown without frontmatter.
        return { outputs: [singleFileTree(`.cursor/commands/${item.name}.md`, `${stripFrontmatter(readItemText(item)).replace(/\n+$/, '')}\n`)] };
      case 'rules':
        return { outputs: [singleFileTree(`.cursor/rules/${item.name}.mdc`, renderRuleMdc(item))] };
      case 'templates':
        throw new SynlinError(`Cannot render ${item.id} for Cursor: ${UNSUPPORTED_REASONS.templates ?? 'unsupported'}`, 1);
    }
  },
};

/**
 * Claude subagent → Cursor agent. Same format family; fields Cursor doesn't
 * know are dropped: `tools` (synthesized into `readonly` when the set is
 * read-only), `model` (Claude aliases like "opus" mean nothing to Cursor).
 */
function renderAgent(item: CatalogItem): string {
  const source = readItemText(item);
  const data = frontmatterData(source);
  const tools = typeof data['tools'] === 'string' ? parseToolsCsv(data['tools']) : [];
  return withFrontmatter(
    [
      ['name', typeof data['name'] === 'string' ? data['name'] : item.name],
      ['description', typeof data['description'] === 'string' ? data['description'] : undefined],
      ['readonly', isReadonlyToolSet(tools) ? true : undefined],
    ],
    stripFrontmatter(source),
  );
}

/**
 * Claude rule → Cursor .mdc: description from frontmatter or first heading;
 * `paths` globs become `globs` with alwaysApply false; rules without paths are
 * always-on guidance (alwaysApply true).
 */
function renderRuleMdc(item: CatalogItem): string {
  const source = readItemText(item);
  const data = frontmatterData(source);
  const paths = Array.isArray(data['paths']) ? data['paths'].filter((glob): glob is string => typeof glob === 'string') : [];
  return withFrontmatter(
    [
      ['description', item.description ?? firstHeading(source) ?? item.name],
      ['globs', paths.length > 0 ? paths.join(',') : undefined],
      ['alwaysApply', paths.length === 0],
    ],
    stripFrontmatter(source),
  );
}
