import pc from 'picocolors';
import { SynlinError } from '../lib/errors.js';
import type { ItemStatus } from '../lib/installer.js';
import { computeStatus, installItem } from '../lib/installer.js';
import type { CatalogItem } from '../lib/library.js';
import type { Manifest } from '../lib/manifest.js';
import { installedTools, readManifest, writeManifest } from '../lib/manifest.js';
import { resolveName } from '../lib/resolve.js';
import type { ToolId } from '../lib/tools/types.js';
import type { Runtime } from './context.js';
import { defaultRuntime, loadCatalog, nowIso, requireProjectRoot, resolveTargets, statusLabel } from './context.js';

export interface UpdateOptions {
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly tool?: readonly string[];
}

interface UpdatePlanEntry {
  readonly id: string;
  readonly tool: ToolId;
  readonly status: ItemStatus;
  readonly libraryItem: CatalogItem | null;
  readonly action: 'reinstall' | 'skip-modified' | 'skip-conflict' | 'skip-template' | 'gone' | 'none';
}

export async function updateCommand(
  queries: readonly string[],
  options: UpdateOptions,
  runtime: Runtime = defaultRuntime(),
): Promise<void> {
  const { catalog } = loadCatalog(runtime);
  const projectRoot = requireProjectRoot(runtime);
  let manifest = readManifest(projectRoot);

  const toolFilter = options.tool !== undefined && options.tool.length > 0 ? resolveTargets(manifest, options.tool) : null;
  const ids = selectIds(Object.keys(manifest.items).sort(), queries);
  if (ids.length === 0) {
    console.log('Nothing installed — nothing to update.');
    return;
  }

  const force = options.force === true;
  const plan: UpdatePlanEntry[] = [];
  for (const id of ids) {
    for (const tool of installedTools(manifest, id)) {
      if (toolFilter !== null && !toolFilter.includes(tool)) continue;
      plan.push(planFor(projectRoot, manifest, id, tool, catalog.items, force));
    }
  }

  for (const entry of plan) {
    report(entry, force);
    if (options.dryRun === true || entry.libraryItem === null) continue;
    if (entry.action === 'reinstall') {
      const outcome = installItem({ projectRoot, item: entry.libraryItem, manifest, tool: entry.tool, force, now: nowIso() });
      manifest = outcome.manifest;
    }
  }

  if (options.dryRun !== true) {
    writeManifest(projectRoot, manifest);
  }
  summarize(plan, options);
}

function selectIds(installedIds: readonly string[], queries: readonly string[]): readonly string[] {
  if (queries.length === 0) {
    return installedIds;
  }
  const failures: string[] = [];
  const selected: string[] = [];
  for (const query of queries) {
    const resolution = resolveName(
      installedIds.map((id) => ({ id })),
      query,
    );
    if (resolution.kind === 'found' && resolution.matches[0]) {
      selected.push(resolution.matches[0].id);
    } else if (resolution.kind === 'ambiguous') {
      failures.push(`"${query}" is ambiguous — use a qualified id: ${resolution.matches.map((m) => m.id).join(', ')}`);
    } else {
      failures.push(`"${query}" is not installed in this project.`);
    }
  }
  if (failures.length > 0) {
    throw new SynlinError(failures.join('\n'));
  }
  return selected;
}

function planFor(
  projectRoot: string,
  manifest: Manifest,
  id: string,
  tool: ToolId,
  catalogItems: readonly CatalogItem[],
  force: boolean,
): UpdatePlanEntry {
  const libraryItem = catalogItems.find((item) => item.id === id) ?? null;
  const status = computeStatus(projectRoot, manifest, id, libraryItem, tool);
  return { id, tool, status, libraryItem, action: actionFor(id, status, force) };
}

function actionFor(id: string, status: ItemStatus, force: boolean): UpdatePlanEntry['action'] {
  const isTemplate = id.startsWith('templates/');
  if (status === 'gone-from-library') return 'gone';
  if (isTemplate) {
    // Templates are locally owned after install; only --force refreshes them.
    if (status === 'up-to-date') return 'none';
    return force ? 'reinstall' : 'skip-template';
  }
  switch (status) {
    case 'up-to-date':
    case 'not-installed':
      return 'none';
    case 'update-available':
    case 'files-missing':
      return 'reinstall';
    case 'modified':
      return force ? 'reinstall' : 'skip-modified';
    case 'conflict':
      return force ? 'reinstall' : 'skip-conflict';
    default:
      return 'none';
  }
}

function report(entry: UpdatePlanEntry, force: boolean): void {
  const tagged = `${entry.id} ${pc.dim(`[${entry.tool}]`)}`;
  switch (entry.action) {
    case 'none':
      return;
    case 'reinstall':
      console.log(`  ${pc.cyan('update          ')}${tagged} [${statusLabel(entry.status)}]${force ? pc.dim(' (forced)') : ''}`);
      return;
    case 'skip-modified':
      console.log(
        `  ${pc.yellow('skip            ')}${tagged} — locally modified; \`synlin import\` to push your edits, or --force to discard`,
      );
      return;
    case 'skip-conflict':
      console.log(`  ${pc.red('conflict        ')}${tagged} — modified locally AND in library; --force takes the library version`);
      return;
    case 'skip-template':
      console.log(`  ${pc.dim('template        ')}${tagged} — locally owned, skipped (use --force to refresh)`);
      return;
    case 'gone':
      console.log(
        `  ${pc.red('gone            ')}${tagged} — no longer in the library; files kept (synlin remove, or synlin import to restore it)`,
      );
      return;
  }
}

function summarize(plan: readonly UpdatePlanEntry[], options: UpdateOptions): void {
  const count = (action: UpdatePlanEntry['action']): number => plan.filter((entry) => entry.action === action).length;
  const upToDate = plan.filter((entry) => entry.action === 'none').length;
  const parts = [
    `${count('reinstall')} updated${options.dryRun === true ? ' (dry run)' : ''}`,
    `${upToDate} up to date`,
    `${count('skip-modified') + count('skip-conflict')} skipped (modified)`,
    `${count('skip-template')} templates skipped`,
    `${count('gone')} gone from library`,
  ];
  console.log(`\n${parts.join(', ')}.`);
}
