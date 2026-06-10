import { isCancel, select } from '@clack/prompts';
import pc from 'picocolors';
import { SynlinError } from '../lib/errors.js';
import type { InstallResult } from '../lib/installer.js';
import { installItem } from '../lib/installer.js';
import type { CatalogItem } from '../lib/library.js';
import type { Manifest } from '../lib/manifest.js';
import { readManifest, writeManifest } from '../lib/manifest.js';
import { resolveName } from '../lib/resolve.js';
import { getAdapter } from '../lib/tools/registry.js';
import { TOOL_IDS } from '../lib/tools/types.js';
import type { Runtime } from './context.js';
import { defaultRuntime, ensureProjectRoot, loadCatalog, nowIso, resolveTargets } from './context.js';

export interface AddOptions {
  readonly force?: boolean;
  readonly tool?: readonly string[];
}

export async function addCommand(queries: readonly string[], options: AddOptions, runtime: Runtime = defaultRuntime()): Promise<void> {
  const { catalog } = loadCatalog(runtime);
  const projectRoot = await ensureProjectRoot(runtime);

  let manifest = readManifest(projectRoot);
  const targets = resolveTargets(manifest, options.tool);
  const results: InstallResult[] = [];
  const failures: string[] = [];

  for (const query of queries) {
    const item = await pickItem(catalog.items, query, runtime, failures);
    if (item === null) continue;

    const rows: InstallResult[] = [];
    for (const tool of targets) {
      const outcome = installItem({
        projectRoot,
        item,
        manifest,
        tool,
        force: options.force === true,
        now: nowIso(),
      });
      manifest = outcome.manifest;
      rows.push(outcome.result);
    }
    if (rows.length > 0 && rows.every((row) => row.action === 'skipped-unsupported')) {
      const supporting = TOOL_IDS.filter((tool) => getAdapter(tool).supports(item.category) === 'supported');
      failures.push(
        `${item.id} is not supported by any configured target (${targets.join(', ')}). ` +
          `Supported by: ${supporting.length > 0 ? supporting.join(', ') : 'none'}.`,
      );
    }
    results.push(...rows);
  }

  writeManifest(projectRoot, manifest);
  printResults(results);
  if (failures.length > 0) {
    throw new SynlinError(failures.join('\n'));
  }
}

async function pickItem(
  items: readonly CatalogItem[],
  query: string,
  runtime: Runtime,
  failures: string[],
): Promise<CatalogItem | null> {
  const resolution = resolveName(items, query);
  if (resolution.kind === 'found') {
    return resolution.matches[0] ?? null;
  }
  if (resolution.kind === 'ambiguous') {
    if (!runtime.interactive) {
      const ids = resolution.matches.map((match) => match.id).join(', ');
      failures.push(`"${query}" is ambiguous — use a qualified id: ${ids}`);
      return null;
    }
    const choice = await select({
      message: `"${query}" matches several items — which one?`,
      options: resolution.matches.map((match) => ({ value: match.id, label: match.id })),
    });
    if (isCancel(choice)) return null;
    return items.find((item) => item.id === choice) ?? null;
  }
  const hint = resolution.suggestions.length > 0 ? ` Did you mean: ${resolution.suggestions.join(', ')}?` : '';
  failures.push(`Unknown item "${query}".${hint}`);
  return null;
}

export function printResults(results: readonly InstallResult[]): void {
  for (const result of results) {
    const detail = result.detail !== undefined ? pc.dim(` — ${result.detail}`) : '';
    console.log(`  ${actionLabel(result.action)} ${result.id} ${pc.dim(`[${result.tool}]`)}${detail}`);
  }
}

function actionLabel(action: InstallResult['action']): string {
  switch (action) {
    case 'installed':
      return pc.green('installed       ');
    case 'updated':
      return pc.cyan('updated         ');
    case 'overwritten':
      return pc.cyan('overwritten     ');
    case 'up-to-date':
      return pc.dim('up to date      ');
    case 'skipped-exists':
    case 'skipped-modified':
    case 'skipped-template-exists':
      return pc.yellow('skipped         ');
    case 'skipped-unsupported':
      return pc.dim('unsupported     ');
  }
}
