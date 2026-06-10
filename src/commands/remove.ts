import { confirm, isCancel } from '@clack/prompts';
import pc from 'picocolors';
import { SynlinError } from '../lib/errors.js';
import { installedEntryHash, removeItem } from '../lib/installer.js';
import type { ToolEntry } from '../lib/manifest.js';
import { getToolEntry, installedTools, readManifest, writeManifest } from '../lib/manifest.js';
import { resolveName } from '../lib/resolve.js';
import type { ToolId } from '../lib/tools/types.js';
import type { Runtime } from './context.js';
import { defaultRuntime, requireProjectRoot, resolveTargets } from './context.js';

export interface RemoveOptions {
  readonly force?: boolean;
  readonly tool?: readonly string[];
}

export async function removeCommand(
  queries: readonly string[],
  options: RemoveOptions,
  runtime: Runtime = defaultRuntime(),
): Promise<void> {
  const projectRoot = requireProjectRoot(runtime);
  let manifest = readManifest(projectRoot);
  const toolFilter = options.tool !== undefined && options.tool.length > 0 ? resolveTargets(manifest, options.tool) : null;
  const failures: string[] = [];
  let removedCount = 0;

  for (const query of queries) {
    const id = resolveInstalledId(Object.keys(manifest.items), query, failures);
    if (id === null) continue;

    const tools = installedTools(manifest, id).filter((tool) => toolFilter === null || toolFilter.includes(tool));
    if (tools.length === 0) {
      failures.push(`${id} is not installed for ${toolFilter?.join(', ') ?? 'any tool'}.`);
      continue;
    }
    for (const tool of tools) {
      const entry = getToolEntry(manifest, id, tool);
      if (!(await confirmIfModified(projectRoot, entry, id, tool, options, runtime))) {
        console.log(pc.yellow(`  kept            ${id} ${pc.dim(`[${tool}]`)} (locally modified — not confirmed)`));
        continue;
      }
      const outcome = removeItem(projectRoot, manifest, id, tool);
      manifest = outcome.manifest;
      removedCount += 1;
      const note = outcome.retainedSharedBlock
        ? pc.dim(' — shared AGENTS.md block kept (still used by another tool)')
        : outcome.removedFiles
          ? ''
          : pc.dim(' — files were already gone; entry dropped');
      console.log(`  ${pc.green('removed         ')}${id} ${pc.dim(`[${tool}]`)}${note}`);
    }
  }

  writeManifest(projectRoot, manifest);
  if (removedCount === 0 && failures.length === 0) {
    console.log('Nothing removed.');
  }
  if (failures.length > 0) {
    throw new SynlinError(failures.join('\n'));
  }
}

function resolveInstalledId(installedIds: readonly string[], query: string, failures: string[]): string | null {
  const resolution = resolveName(
    installedIds.map((id) => ({ id })),
    query,
  );
  if (resolution.kind === 'found') {
    return resolution.matches[0]?.id ?? null;
  }
  if (resolution.kind === 'ambiguous') {
    failures.push(`"${query}" is ambiguous — use a qualified id: ${resolution.matches.map((m) => m.id).join(', ')}`);
    return null;
  }
  const hint = resolution.suggestions.length > 0 ? ` Did you mean: ${resolution.suggestions.join(', ')}?` : '';
  failures.push(`"${query}" is not synlin-managed in this project — refusing to delete.${hint}`);
  return null;
}

async function confirmIfModified(
  projectRoot: string,
  entry: ToolEntry | undefined,
  id: string,
  tool: ToolId,
  options: RemoveOptions,
  runtime: Runtime,
): Promise<boolean> {
  if (!entry) return true;
  const currentHash = installedEntryHash(projectRoot, entry.outputs);
  const isModified = currentHash !== null && currentHash !== entry.hash;
  if (!isModified || options.force === true) {
    return true;
  }
  if (!runtime.interactive) {
    throw new SynlinError(`${id} [${tool}] is locally modified. Use --force to remove it anyway.`);
  }
  const answer = await confirm({ message: `${id} [${tool}] is locally modified. Remove it anyway?` });
  return !isCancel(answer) && answer === true;
}
