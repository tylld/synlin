import path from 'node:path';
import type { Category, ItemRef } from '../categories.js';
import { frontmatterData, stripFrontmatter } from './markdown.js';
import { opencodePermissionToClaudeTools } from './tool-names.js';
import type { ToolId } from './types.js';
import type { FrontmatterValue } from './yaml.js';
import { withFrontmatter } from './yaml.js';

export interface InferredImport {
  readonly ref: ItemRef;
  /** Absolute path of the item root (the skill directory, or the file itself). */
  readonly itemRoot: string;
  /** Tool config space the path was found in. */
  readonly tool: ToolId;
  /** Reverse conversion back to canonical (Claude) library format; absent = verbatim copy. */
  readonly transform?: (content: string) => string;
}

const TOOL_DIRS: ReadonlyMap<string, ToolId> = new Map([
  ['.claude', 'claude'],
  ['.codex', 'codex'],
  ['.cursor', 'cursor'],
  ['.opencode', 'opencode'],
]);

/**
 * Infer category/name from a path inside any tool's config dir. Returns null
 * when nothing can be inferred (caller falls back to --category/--as).
 */
export function inferImport(absolutePath: string): InferredImport | null {
  const segments = absolutePath.split(path.sep);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    const tool = TOOL_DIRS.get(segment);
    if (tool === undefined) continue;
    const toolDir = segments.slice(0, index + 1).join(path.sep);
    const rest = segments.slice(index + 1);
    if (rest.length === 0) return null;
    return inferForTool(tool, toolDir, rest, absolutePath);
  }
  return null;
}

function inferForTool(tool: ToolId, toolDir: string, rest: readonly string[], absolutePath: string): InferredImport | null {
  switch (tool) {
    case 'claude':
      return inferClaude(toolDir, rest, absolutePath);
    case 'codex':
      return skillImport(tool, toolDir, rest);
    case 'cursor':
      return inferCursor(toolDir, rest, absolutePath);
    case 'opencode':
      return inferOpencode(toolDir, rest, absolutePath);
  }
}

/** Skills are the only verbatim-importable category for codex. */
function skillImport(tool: ToolId, toolDir: string, rest: readonly string[]): InferredImport | null {
  const head = rest[0];
  if (head === 'skills' && rest.length >= 2 && rest[1] !== undefined) {
    return { ref: { category: 'skills', name: rest[1] }, itemRoot: path.join(toolDir, 'skills', rest[1]), tool };
  }
  return null;
}

function inferClaude(toolDir: string, rest: readonly string[], absolutePath: string): InferredImport | null {
  const head = rest[0];
  if (head === 'skills' && rest.length >= 2 && rest[1] !== undefined) {
    return { ref: { category: 'skills', name: rest[1] }, itemRoot: path.join(toolDir, 'skills', rest[1]), tool: 'claude' };
  }
  if ((head === 'agents' || head === 'commands') && rest.length === 2 && rest[1] !== undefined) {
    return markdownRef('claude', head, rest[1], absolutePath);
  }
  if (head === 'rules' && (rest.length === 2 || rest.length === 3)) {
    const file = rest[rest.length - 1];
    if (file === undefined || !file.endsWith('.md')) return null;
    const group = rest.length === 3 ? `${rest[1]}/` : '';
    return { ref: { category: 'rules', name: `${group}${file.slice(0, -3)}` }, itemRoot: absolutePath, tool: 'claude' };
  }
  if (rest.length === 1 && head !== undefined) {
    return { ref: { category: 'templates', name: head }, itemRoot: absolutePath, tool: 'claude' };
  }
  return null;
}

function inferCursor(toolDir: string, rest: readonly string[], absolutePath: string): InferredImport | null {
  const head = rest[0];
  if (head === 'skills' && rest.length >= 2 && rest[1] !== undefined) {
    return { ref: { category: 'skills', name: rest[1] }, itemRoot: path.join(toolDir, 'skills', rest[1]), tool: 'cursor' };
  }
  if (head === 'commands' && rest.length === 2 && rest[1] !== undefined) {
    // Cursor commands are plain markdown — already valid library command bodies.
    return markdownRef('cursor', 'commands', rest[1], absolutePath);
  }
  if (head === 'agents' && rest.length === 2 && rest[1] !== undefined) {
    const inferred = markdownRef('cursor', 'agents', rest[1], absolutePath);
    return inferred === null ? null : { ...inferred, transform: cursorAgentToClaude };
  }
  if (head === 'rules' && (rest.length === 2 || rest.length === 3)) {
    const file = rest[rest.length - 1];
    if (file === undefined || !file.endsWith('.mdc')) return null;
    const group = rest.length === 3 ? `${rest[1]}/` : '';
    return {
      ref: { category: 'rules', name: `${group}${file.slice(0, -4)}` },
      itemRoot: absolutePath,
      tool: 'cursor',
      transform: mdcToRule,
    };
  }
  return null;
}

function inferOpencode(toolDir: string, rest: readonly string[], absolutePath: string): InferredImport | null {
  const head = rest[0];
  // Accept both plural (standard) and singular (legacy) directory names.
  const normalized = head === 'agent' ? 'agents' : head === 'command' ? 'commands' : head === 'skill' ? 'skills' : head;
  if (normalized === 'skills' && rest.length >= 2 && rest[1] !== undefined) {
    return { ref: { category: 'skills', name: rest[1] }, itemRoot: path.join(toolDir, head ?? 'skills', rest[1]), tool: 'opencode' };
  }
  if (normalized === 'commands' && rest.length === 2 && rest[1] !== undefined) {
    const inferred = markdownRef('opencode', 'commands', rest[1], absolutePath);
    return inferred === null ? null : { ...inferred, transform: opencodeCommandToClaude };
  }
  if (normalized === 'agents' && rest.length === 2 && rest[1] !== undefined) {
    const inferred = markdownRef('opencode', 'agents', rest[1], absolutePath);
    return inferred === null ? null : { ...inferred, transform: opencodeAgentToClaude };
  }
  return null;
}

function markdownRef(tool: ToolId, category: Category, fileName: string, absolutePath: string): InferredImport | null {
  if (!fileName.endsWith('.md')) return null;
  return { ref: { category, name: fileName.slice(0, -3) }, itemRoot: absolutePath, tool };
}

/** Cursor .mdc rule → library rule: globs become paths frontmatter; description/alwaysApply are re-synthesized on render. */
function mdcToRule(content: string): string {
  const data = frontmatterData(content);
  const body = stripFrontmatter(content);
  const globs = typeof data['globs'] === 'string' ? data['globs'].split(',').map((glob) => glob.trim()).filter((g) => g.length > 0) : [];
  if (globs.length === 0) {
    return `${body.replace(/\n+$/, '')}\n`;
  }
  const pathsYaml = `---\npaths:\n${globs.map((glob) => `  - "${glob}"`).join('\n')}\n---\n`;
  return `${pathsYaml}\n${body.replace(/\n+$/, '')}\n`;
}

/** Cursor agent → Claude agent: keep name/description; drop cursor-only fields. */
function cursorAgentToClaude(content: string): string {
  const data = frontmatterData(content);
  return withFrontmatter(
    [
      ['name', stringField(data, 'name')],
      ['description', stringField(data, 'description')],
    ],
    stripFrontmatter(content),
  );
}

/** OpenCode command → Claude command: keep description; drop agent/model/subtask. */
function opencodeCommandToClaude(content: string): string {
  const data = frontmatterData(content);
  return withFrontmatter([['description', stringField(data, 'description')]], stripFrontmatter(content));
}

/** OpenCode agent → Claude agent: permission allow-keys back to a tools CSV; drop opencode-only fields. */
function opencodeAgentToClaude(content: string): string {
  const data = frontmatterData(content);
  const permission = data['permission'];
  const tools =
    typeof permission === 'object' && permission !== null ? opencodePermissionToClaudeTools(permission as Record<string, unknown>) : undefined;
  const fields: Array<readonly [string, FrontmatterValue | undefined]> = [
    ['description', stringField(data, 'description')],
    ['tools', tools],
  ];
  return withFrontmatter(fields, stripFrontmatter(content));
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' ? value : undefined;
}
