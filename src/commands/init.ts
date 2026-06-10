import { cancel, groupMultiselect, intro, isCancel, multiselect, note, outro } from '@clack/prompts';
import pc from 'picocolors';
import { SynlinError } from '../lib/errors.js';
import type { InstallResult } from '../lib/installer.js';
import { installItem } from '../lib/installer.js';
import type { CatalogItem } from '../lib/library.js';
import type { Manifest } from '../lib/manifest.js';
import { hasManifest, readManifest, withTargets, writeManifest } from '../lib/manifest.js';
import { detectToolDirs, getAdapter } from '../lib/tools/registry.js';
import type { ToolId } from '../lib/tools/types.js';
import { TOOL_IDS } from '../lib/tools/types.js';
import { printResults } from './add.js';
import type { Runtime } from './context.js';
import { defaultRuntime, ensureProjectRoot, loadCatalog, nowIso, resolveTargets, truncate } from './context.js';

export interface InitOptions {
  readonly force?: boolean;
}

interface PickerOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

/**
 * Group catalog items for the interactive picker: one group per category,
 * rules split per group (rules/common, rules/typescript, ...).
 */
export function buildPickerOptions(items: readonly CatalogItem[]): Record<string, PickerOption[]> {
  const groups: Record<string, PickerOption[]> = {};
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const groupName = pickerGroup(item);
    const option: PickerOption = {
      value: item.id,
      label: pickerLabel(item),
      ...(item.description !== undefined ? { hint: truncate(item.description) } : {}),
    };
    groups[groupName] = [...(groups[groupName] ?? []), option];
  }
  return groups;
}

function pickerGroup(item: CatalogItem): string {
  if (item.category !== 'rules') return item.category;
  const slash = item.name.indexOf('/');
  return slash === -1 ? 'rules' : `rules/${item.name.slice(0, slash)}`;
}

function pickerLabel(item: CatalogItem): string {
  if (item.category !== 'rules') return item.name;
  const slash = item.name.indexOf('/');
  return slash === -1 ? item.name : item.name.slice(slash + 1);
}

export async function initCommand(options: InitOptions, runtime: Runtime = defaultRuntime()): Promise<void> {
  if (!runtime.interactive) {
    throw new SynlinError('synlin init is interactive. In non-TTY contexts use "synlin add <item...>" instead.');
  }
  intro(pc.bold('synlin init'));

  const { catalog } = loadCatalog(runtime);
  if (catalog.items.length === 0) {
    throw new SynlinError('The library is empty. Run "npm run seed" in the synlin repo first.');
  }
  const projectRoot = await ensureProjectRoot(runtime);
  const fresh = !hasManifest(projectRoot);
  let manifest = readManifest(projectRoot);

  if (fresh) {
    const targets = await pickTargets(projectRoot);
    manifest = withTargets(manifest, targets);
  }
  const targets = resolveTargets(manifest);
  note(targets.join(', '), 'Install targets');

  const installedIds = new Set(Object.keys(manifest.items));
  const newItems = catalog.items.filter((item) => !installedIds.has(item.id));
  if (installedIds.size > 0) {
    note([...installedIds].sort().join('\n'), `Already installed (${installedIds.size})`);
  }
  if (newItems.length === 0) {
    outro('Everything in the library is already installed. Run "synlin update" to refresh.');
    return;
  }

  const selection = await groupMultiselect({
    message: `Pick items to install into ${projectRoot}`,
    options: buildPickerOptions(newItems),
    required: false,
  });
  if (isCancel(selection) || selection.length === 0) {
    cancel('Nothing installed.');
    return;
  }

  const { results, manifest: nextManifest } = installSelection(projectRoot, newItems, selection, manifest, targets, options);
  writeManifest(projectRoot, nextManifest);
  printResults(results);

  const installed = results.filter((result) => result.action === 'installed' || result.action === 'overwritten').length;
  const skipped = results.length - installed;
  outro(`${installed} installed, ${skipped} skipped.${skipped > 0 ? ' (--force overwrites existing files)' : ''}`);
}

/** Target multiselect for fresh projects, pre-checked from detected tool dirs. */
async function pickTargets(projectRoot: string): Promise<readonly ToolId[]> {
  const detected = detectToolDirs(projectRoot);
  const initialValues: ToolId[] = detected.length > 0 ? [...detected] : ['claude'];
  const selection = await multiselect({
    message: 'Which tools should synlin install for in this project?',
    options: TOOL_IDS.map((tool) => ({
      value: tool,
      label: getAdapter(tool).displayName,
      hint: getAdapter(tool).configDirName,
    })),
    initialValues,
    required: true,
  });
  if (isCancel(selection)) {
    throw new SynlinError('Aborted: no targets selected.', 0);
  }
  return selection;
}

function installSelection(
  projectRoot: string,
  items: readonly CatalogItem[],
  selectedIds: readonly string[],
  manifest: Manifest,
  targets: readonly ToolId[],
  options: InitOptions,
): { results: InstallResult[]; manifest: Manifest } {
  const results: InstallResult[] = [];
  let current = manifest;
  for (const id of selectedIds) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) continue;
    for (const tool of targets) {
      const outcome = installItem({ projectRoot, item, manifest: current, tool, force: options.force === true, now: nowIso() });
      current = outcome.manifest;
      results.push(outcome.result);
    }
  }
  return { results, manifest: current };
}
