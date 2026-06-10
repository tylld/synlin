import type { Category } from '../categories.js';
import { SynlinError } from '../errors.js';
import type { CatalogItem } from '../library.js';
import { renderRuleBlock } from './agents-md.js';
import { verbatimTree } from './render.js';
import type { RenderedItem, SupportLevel, ToolAdapter } from './types.js';

const UNSUPPORTED_REASONS: Partial<Record<Category, string>> = {
  agents: 'Codex agents are TOML config without a place for the agent prompt body — no faithful conversion exists',
  commands: 'Codex custom prompts are user-level only and deprecated; there is no project-level command mechanism',
  templates: 'templates are Claude Code settings files with no Codex equivalent',
};

export const codexAdapter: ToolAdapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  configDirName: '.codex',
  sharedFiles: ['AGENTS.md'],
  supports(category: Category): SupportLevel {
    return category === 'rules' || category === 'skills' ? 'supported' : 'unsupported';
  },
  unsupportedReason(category: Category): string | undefined {
    return UNSUPPORTED_REASONS[category];
  },
  render(item: CatalogItem): RenderedItem {
    if (item.category === 'skills') {
      // Open agent skills standard — SKILL.md dirs copy verbatim; never emit
      // agents/openai.yaml (UI metadata, not derivable from Claude format).
      return { outputs: [verbatimTree(item, `.codex/skills/${item.name}`)] };
    }
    if (item.category === 'rules') {
      return { outputs: [renderRuleBlock(item)] };
    }
    throw new SynlinError(`Cannot render ${item.id} for Codex CLI: ${UNSUPPORTED_REASONS[item.category] ?? 'unsupported'}`, 1);
  },
};
