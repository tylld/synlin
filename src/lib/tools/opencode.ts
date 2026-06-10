import type { Category } from '../categories.js';
import { SynlinError } from '../errors.js';
import type { CatalogItem } from '../library.js';
import { renderRuleBlock } from './agents-md.js';
import { frontmatterData, stripFrontmatter } from './markdown.js';
import { readItemText, singleFileTree, verbatimTree } from './render.js';
import { claudeToolsToOpencodePermission, parseToolsCsv } from './tool-names.js';
import type { RenderedItem, SupportLevel, ToolAdapter } from './types.js';
import { withFrontmatter } from './yaml.js';

const UNSUPPORTED_REASONS: Partial<Record<Category, string>> = {
  templates: 'templates are Claude Code settings files with no OpenCode equivalent',
};

export const opencodeAdapter: ToolAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',
  configDirName: '.opencode',
  sharedFiles: ['AGENTS.md'],
  supports(category: Category): SupportLevel {
    return category === 'templates' ? 'unsupported' : 'supported';
  },
  unsupportedReason(category: Category): string | undefined {
    return UNSUPPORTED_REASONS[category];
  },
  render(item: CatalogItem): RenderedItem {
    switch (item.category) {
      case 'skills':
        // Same SKILL.md standard; OpenCode ignores unknown frontmatter.
        return { outputs: [verbatimTree(item, `.opencode/skills/${item.name}`)] };
      case 'agents':
        return { outputs: [singleFileTree(`.opencode/agents/${item.name}.md`, renderAgent(item))] };
      case 'commands':
        return { outputs: [singleFileTree(`.opencode/commands/${item.name}.md`, renderCommand(item))] };
      case 'rules':
        // Same blockId + body as codex: the physical AGENTS.md block is shared.
        return { outputs: [renderRuleBlock(item)] };
      case 'templates':
        throw new SynlinError(`Cannot render ${item.id} for OpenCode: ${UNSUPPORTED_REASONS.templates ?? 'unsupported'}`, 1);
    }
  },
};

/**
 * Claude subagent → OpenCode agent: `mode: subagent` (that's what Claude
 * agents are); the agent's name comes from the filename so `name` is dropped;
 * `model` (Claude alias) dropped — absent means inherit; `tools` CSV becomes
 * the OpenCode permission object (listed → allow, rest → deny, mcp__* dropped).
 */
function renderAgent(item: CatalogItem): string {
  const source = readItemText(item);
  const data = frontmatterData(source);
  const tools = typeof data['tools'] === 'string' ? parseToolsCsv(data['tools']) : [];
  return withFrontmatter(
    [
      ['description', typeof data['description'] === 'string' ? data['description'] : undefined],
      ['mode', 'subagent'],
      ['permission', tools.length > 0 ? claudeToolsToOpencodePermission(tools) : undefined],
    ],
    stripFrontmatter(source),
  );
}

/** Claude command → OpenCode command: description kept, $ARGUMENTS semantics identical. */
function renderCommand(item: CatalogItem): string {
  const source = readItemText(item);
  const data = frontmatterData(source);
  return withFrontmatter(
    [['description', typeof data['description'] === 'string' ? data['description'] : undefined]],
    stripFrontmatter(source),
  );
}
