import { confirm, isCancel } from '@clack/prompts';
import pc from 'picocolors';
import { SynlinError } from '../lib/errors.js';
import type { InstallResult } from '../lib/installer.js';
import { installItem, removeItem } from '../lib/installer.js';
import { installedTools, readManifest, withTargets, withoutToolEntry, writeManifest } from '../lib/manifest.js';
import { detectToolDirs, getAdapter } from '../lib/tools/registry.js';
import type { ToolId } from '../lib/tools/types.js';
import { TOOL_IDS, isToolId } from '../lib/tools/types.js';
import { printResults } from './add.js';
import type { Runtime } from './context.js';
import { defaultRuntime, loadCatalog, nowIso, requireProjectRoot, resolveTargets } from './context.js';

export interface TargetsOptions {
  /** targets add: also install already-managed items for the new tools. */
  readonly install?: boolean;
  /** targets remove: drop manifest entries but keep the files on disk. */
  readonly keepFiles?: boolean;
  readonly force?: boolean;
}

export async function targetsCommand(
  action: string | undefined,
  tools: readonly string[],
  options: TargetsOptions,
  runtime: Runtime = defaultRuntime(),
): Promise<void> {
  const projectRoot = requireProjectRoot(runtime);

  if (action === undefined) {
    showTargets(projectRoot);
    return;
  }
  const toolIds = parseTools(tools);
  if (action === 'add') {
    await addTargets(projectRoot, toolIds, options, runtime);
    return;
  }
  if (action === 'remove') {
    await removeTargets(projectRoot, toolIds, options, runtime);
    return;
  }
  throw new SynlinError(`Unknown targets action "${action}". Usage: synlin targets [add|remove] <tool...>`);
}

function showTargets(projectRoot: string): void {
  const manifest = readManifest(projectRoot);
  const configured = resolveTargets(manifest);
  const detected = detectToolDirs(projectRoot);

  console.log(pc.bold(`Targets in ${projectRoot}:`));
  for (const tool of TOOL_IDS) {
    const adapter = getAdapter(tool);
    const isConfigured = configured.includes(tool);
    const isDetected = detected.includes(tool);
    if (!isConfigured && !isDetected) continue;
    const flags = [
      isConfigured ? pc.green('configured') : pc.dim('not configured'),
      isDetected ? pc.dim(`${adapter.configDirName}/ present`) : pc.dim(`${adapter.configDirName}/ absent`),
    ];
    console.log(`  ${tool.padEnd(10)} ${flags.join('  ')}`);
  }
  const unconfigured = detected.filter((tool) => !configured.includes(tool));
  if (unconfigured.length > 0) {
    console.log(pc.dim(`\nDetected but not configured: ${unconfigured.join(', ')} — "synlin targets add <tool>" to enable.`));
  }
}

async function addTargets(projectRoot: string, tools: readonly ToolId[], options: TargetsOptions, runtime: Runtime): Promise<void> {
  let manifest = readManifest(projectRoot);
  const configured = resolveTargets(manifest);
  const added = tools.filter((tool) => !configured.includes(tool));
  if (added.length === 0) {
    console.log(`Already configured: ${tools.join(', ')}.`);
    return;
  }
  manifest = withTargets(manifest, [...configured, ...added]);

  const managedIds = Object.keys(manifest.items).sort();
  let backfill = options.install === true;
  if (!backfill && runtime.interactive && managedIds.length > 0) {
    const answer = await confirm({
      message: `Install the ${managedIds.length} managed item(s) for ${added.join(', ')} too?`,
    });
    backfill = !isCancel(answer) && answer === true;
  }

  if (backfill && managedIds.length > 0) {
    const { catalog } = loadCatalog(runtime);
    const results: InstallResult[] = [];
    for (const id of managedIds) {
      const item = catalog.items.find((candidate) => candidate.id === id);
      if (!item) continue;
      for (const tool of added) {
        const outcome = installItem({ projectRoot, item, manifest, tool, force: options.force === true, now: nowIso() });
        manifest = outcome.manifest;
        results.push(outcome.result);
      }
    }
    printResults(results);
  }

  writeManifest(projectRoot, manifest);
  console.log(`${pc.green('targets:')} ${resolveTargets(manifest).join(', ')}`);
}

async function removeTargets(projectRoot: string, tools: readonly ToolId[], options: TargetsOptions, runtime: Runtime): Promise<void> {
  let manifest = readManifest(projectRoot);
  const configured = resolveTargets(manifest);
  const removing = tools.filter((tool) => configured.includes(tool));
  if (removing.length === 0) {
    console.log(`Not configured: ${tools.join(', ')}.`);
    return;
  }
  if (configured.length === removing.length) {
    throw new SynlinError('Refusing to remove every target — a project needs at least one. Add another target first.');
  }

  for (const tool of removing) {
    const ids = Object.keys(manifest.items).filter((id) => installedTools(manifest, id).includes(tool));
    if (ids.length > 0 && options.keepFiles !== true && options.force !== true && runtime.interactive) {
      const answer = await confirm({
        message: `Remove ${ids.length} installed item(s) for ${tool} from this project?`,
      });
      if (isCancel(answer) || answer !== true) {
        console.log(pc.yellow(`Skipped ${tool} — target kept.`));
        continue;
      }
    }
    for (const id of ids) {
      if (options.keepFiles === true) {
        manifest = withoutToolEntry(manifest, id, tool);
      } else {
        const outcome = removeItem(projectRoot, manifest, id, tool);
        manifest = outcome.manifest;
      }
    }
    manifest = withTargets(
      manifest,
      resolveTargets(manifest).filter((t) => t !== tool),
    );
    console.log(`${pc.green('removed target:')} ${tool}${options.keepFiles === true ? pc.dim(' (files kept)') : ''}`);
  }

  writeManifest(projectRoot, manifest);
  console.log(`${pc.green('targets:')} ${resolveTargets(manifest).join(', ')}`);
}

function parseTools(tools: readonly string[]): readonly ToolId[] {
  if (tools.length === 0) {
    throw new SynlinError(`Specify at least one tool: ${TOOL_IDS.join(', ')}`);
  }
  return tools.map((tool) => {
    if (!isToolId(tool)) {
      throw new SynlinError(`Unknown tool "${tool}". Valid tools: ${TOOL_IDS.join(', ')}`);
    }
    return tool;
  });
}
