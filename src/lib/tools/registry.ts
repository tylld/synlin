import fs from 'node:fs';
import path from 'node:path';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { cursorAdapter } from './cursor.js';
import { opencodeAdapter } from './opencode.js';
import type { ToolAdapter, ToolId } from './types.js';
import { TOOL_IDS } from './types.js';

const ADAPTERS: Readonly<Record<ToolId, ToolAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  opencode: opencodeAdapter,
};

export function getAdapter(id: ToolId): ToolAdapter {
  return ADAPTERS[id];
}

export function allAdapters(): readonly ToolAdapter[] {
  return TOOL_IDS.map((id) => ADAPTERS[id]);
}

/** Tool ids whose project config dir exists at projectRoot, in TOOL_IDS order. */
export function detectToolDirs(projectRoot: string): readonly ToolId[] {
  return TOOL_IDS.filter((id) => {
    const stat = fs.statSync(path.join(projectRoot, ADAPTERS[id].configDirName), { throwIfNoEntry: false });
    return stat?.isDirectory() === true;
  });
}
