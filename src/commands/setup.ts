import { confirm, isCancel } from '@clack/prompts';
import pc from 'picocolors';
import { SynlinError } from '../lib/errors.js';
import type { InstallResult } from '../lib/installer.js';
import { installItem } from '../lib/installer.js';
import { hasManifest, readManifest, withTargets, writeManifest } from '../lib/manifest.js';
import { deleteSetup, isValidSetupName, listSetups, readSetup, setupExists, writeSetup } from '../lib/setups.js';
import { printResults } from './add.js';
import type { Runtime } from './context.js';
import { defaultRuntime, ensureProjectRoot, loadCatalog, nowIso, requireProjectRoot, resolveTargets } from './context.js';

export interface SetupOptions {
  readonly force?: boolean;
}

export async function setupCommand(
  action: string | undefined,
  name: string | undefined,
  options: SetupOptions,
  runtime: Runtime = defaultRuntime(),
): Promise<void> {
  if (action === undefined) {
    showSetups(runtime);
    return;
  }
  if (name === undefined) {
    throw new SynlinError(`Usage: synlin setup ${action} <name>`);
  }
  if (!isValidSetupName(name)) {
    throw new SynlinError(`Invalid setup name "${name}" (lowercase, [a-z0-9._-])`);
  }
  switch (action) {
    case 'save':
      await saveSetup(name, options, runtime);
      return;
    case 'add':
    case 'apply':
      await applySetup(name, options, runtime);
      return;
    case 'remove':
      await removeSetup(name, options, runtime);
      return;
    default:
      throw new SynlinError(`Unknown setup action "${action}". Usage: synlin setup [save|add|remove] <name>`);
  }
}

function showSetups(runtime: Runtime): void {
  const { libraryRoot } = loadCatalog(runtime);
  const setups = listSetups(libraryRoot);
  if (setups.length === 0) {
    console.log('No saved setups. Create one inside a project with "synlin setup save <name>".');
    return;
  }
  console.log(pc.bold('Saved setups:'));
  for (const setup of setups) {
    const saved = setup.savedAt !== '' ? pc.dim(`  saved ${setup.savedAt.slice(0, 10)}`) : '';
    console.log(`  ${setup.name.padEnd(24)} ${String(setup.items.length).padStart(3)} items  [${setup.targets.join(', ')}]${saved}`);
  }
  console.log(pc.dim('\n"synlin setup add <name>" applies one to the current project.'));
}

/** Snapshot the current project's installed item set (union across tools) + its targets. */
async function saveSetup(name: string, options: SetupOptions, runtime: Runtime): Promise<void> {
  const { libraryRoot } = loadCatalog(runtime);
  const projectRoot = requireProjectRoot(runtime);
  const manifest = readManifest(projectRoot);

  const items = Object.keys(manifest.items).sort();
  if (items.length === 0) {
    throw new SynlinError('Nothing installed in this project — nothing to save.');
  }

  if (setupExists(libraryRoot, name) && options.force !== true) {
    const existing = readSetup(libraryRoot, name);
    if (!runtime.interactive) {
      throw new SynlinError(`Setup "${name}" already exists (${existing.items.length} items). Re-run with --force to overwrite it.`);
    }
    const answer = await confirm({ message: `Setup "${name}" exists (${existing.items.length} items). Overwrite with the current ${items.length}?` });
    if (isCancel(answer) || answer !== true) {
      console.log(pc.yellow('Save aborted.'));
      return;
    }
  }

  writeSetup(libraryRoot, { name, items, targets: resolveTargets(manifest), savedAt: nowIso() });
  console.log(`${pc.green('saved')} setup "${name}" — ${items.length} items, targets [${resolveTargets(manifest).join(', ')}]`);
  console.log(pc.dim(`Commit it in the synlin repo to sync across machines.`));
}

/** Install every item of a setup into the current project. */
async function applySetup(name: string, options: SetupOptions, runtime: Runtime): Promise<void> {
  const { catalog, libraryRoot } = loadCatalog(runtime);
  const setup = readSetup(libraryRoot, name);
  const projectRoot = await ensureProjectRoot(runtime);

  const fresh = !hasManifest(projectRoot);
  let manifest = readManifest(projectRoot);
  if (fresh && setup.targets.length > 0) {
    // A fresh project adopts the setup's targets; configured projects keep their own.
    manifest = withTargets(manifest, setup.targets);
    console.log(pc.dim(`Adopted targets from setup: ${setup.targets.join(', ')}`));
  }
  const targets = resolveTargets(manifest);

  const results: InstallResult[] = [];
  const missing: string[] = [];
  for (const id of setup.items) {
    const item = catalog.items.find((candidate) => candidate.id === id);
    if (!item) {
      missing.push(id);
      continue;
    }
    for (const tool of targets) {
      const outcome = installItem({ projectRoot, item, manifest, tool, force: options.force === true, now: nowIso() });
      manifest = outcome.manifest;
      results.push(outcome.result);
    }
  }

  writeManifest(projectRoot, manifest);
  printResults(results);
  if (missing.length > 0) {
    console.warn(pc.yellow(`Skipped ${missing.length} item(s) no longer in the library: ${missing.join(', ')}`));
  }
  const installed = results.filter((result) => result.action === 'installed' || result.action === 'updated' || result.action === 'overwritten').length;
  console.log(`\nSetup "${name}": ${installed} installs, ${results.length - installed} skipped/up-to-date.`);
}

async function removeSetup(name: string, options: SetupOptions, runtime: Runtime): Promise<void> {
  const { libraryRoot } = loadCatalog(runtime);
  const setup = readSetup(libraryRoot, name);
  if (options.force !== true && runtime.interactive) {
    const answer = await confirm({ message: `Delete setup "${name}" (${setup.items.length} items) from the library?` });
    if (isCancel(answer) || answer !== true) {
      console.log(pc.yellow('Nothing deleted.'));
      return;
    }
  }
  deleteSetup(libraryRoot, name);
  console.log(`${pc.green('deleted')} setup "${name}" ${pc.dim('(installed projects are unaffected)')}`);
}
