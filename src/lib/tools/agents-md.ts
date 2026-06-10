import fs from 'node:fs';
import { SynlinError } from '../errors.js';
import type { CatalogItem } from '../library.js';
import type { ManagedBlockOutput } from './types.js';
import { frontmatterData, shiftHeadingsDown, stripFrontmatter } from './markdown.js';

/**
 * Render a synlin rule as an AGENTS.md managed block, shared by every
 * AGENTS.md-consuming tool (codex, opencode): same blockId (the item id) and
 * identical body, so the physical block exists once however many tools use it.
 *
 * Transform (invertible for import):
 * 1. strip YAML frontmatter
 * 2. demote headings one level so the rule's H1 doesn't compete with the file's
 * 3. a `_Applies to: ..._` line preserves the frontmatter `paths` globs
 */
export function renderRuleBlock(item: CatalogItem): ManagedBlockOutput {
  const content = fs.readFileSync(item.sourcePath, 'utf8');
  return {
    kind: 'managed-block',
    filePath: 'AGENTS.md',
    blockId: item.id,
    body: ruleBlockBody(item.id, content),
  };
}

export function ruleBlockBody(itemId: string, ruleContent: string): string {
  const paths = rulePaths(itemId, ruleContent);
  const body = shiftHeadingsDown(stripFrontmatter(ruleContent));
  const lines = body.split('\n');
  if (paths.length > 0) {
    const appliesTo = `_Applies to: ${paths.map((glob) => `\`${glob}\``).join(', ')}_`;
    const headingIndex = lines.findIndex((line) => /^#{1,6}\s/.test(line));
    const insertAt = headingIndex === -1 ? 0 : headingIndex + 1;
    lines.splice(insertAt, 0, '', appliesTo);
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function rulePaths(itemId: string, ruleContent: string): readonly string[] {
  const data = frontmatterData(ruleContent);
  const paths = data['paths'];
  if (paths === undefined) return [];
  if (!Array.isArray(paths) || !paths.every((glob): glob is string => typeof glob === 'string')) {
    throw new SynlinError(`Rule ${itemId} has an invalid "paths" frontmatter field — expected a list of glob strings.`);
  }
  return paths;
}
