/** Claude tool-name conventions and their mappings to other tools' vocabularies. */

/** Claude tools that cannot modify the workspace (used to synthesize Cursor's `readonly`). */
const READONLY_CLAUDE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);

/** Claude tool → OpenCode permission key. mcp__* and unknown tools have no portable mapping. */
const CLAUDE_TO_OPENCODE: ReadonlyMap<string, string> = new Map([
  ['Read', 'read'],
  ['Grep', 'grep'],
  ['Glob', 'glob'],
  ['Bash', 'bash'],
  ['Edit', 'edit'],
  ['Write', 'edit'],
  ['WebFetch', 'webfetch'],
  ['WebSearch', 'websearch'],
  ['Task', 'task'],
  ['TodoWrite', 'todowrite'],
]);

/** OpenCode permission keys we emit, in fixed order (determinism). */
const OPENCODE_PERMISSION_KEYS = ['read', 'edit', 'bash', 'glob', 'grep', 'webfetch', 'websearch', 'task'] as const;

export function parseToolsCsv(tools: string): readonly string[] {
  return tools
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
}

/** True when every listed Claude tool is read-only (Cursor `readonly` synthesis). */
export function isReadonlyToolSet(tools: readonly string[]): boolean {
  return tools.length > 0 && tools.every((tool) => READONLY_CLAUDE_TOOLS.has(tool));
}

/**
 * Claude `tools:` CSV → OpenCode `permission` map: listed tools become allow,
 * the rest of the fixed key set becomes deny. mcp__* entries are dropped.
 */
export function claudeToolsToOpencodePermission(tools: readonly string[]): ReadonlyArray<readonly [string, string]> {
  const allowed = new Set<string>();
  for (const tool of tools) {
    const mapped = CLAUDE_TO_OPENCODE.get(tool);
    if (mapped !== undefined) allowed.add(mapped);
  }
  return OPENCODE_PERMISSION_KEYS.map((key) => [key, allowed.has(key) ? 'allow' : 'deny'] as const);
}

/** Reverse mapping for import: OpenCode permission allow-keys → Claude tools CSV. */
export function opencodePermissionToClaudeTools(permission: Record<string, unknown>): string | undefined {
  const tools: string[] = [];
  const reverse: ReadonlyMap<string, readonly string[]> = new Map([
    ['read', ['Read']],
    ['grep', ['Grep']],
    ['glob', ['Glob']],
    ['bash', ['Bash']],
    ['edit', ['Edit', 'Write']],
    ['webfetch', ['WebFetch']],
    ['websearch', ['WebSearch']],
    ['task', ['Task']],
    ['todowrite', ['TodoWrite']],
  ]);
  for (const [key, claudeNames] of reverse) {
    if (permission[key] === 'allow') tools.push(...claudeNames);
  }
  return tools.length > 0 ? tools.join(', ') : undefined;
}
