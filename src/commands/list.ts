import pc from 'picocolors';
import type { Category } from '../lib/categories.js';
import { CATEGORIES, isCategory } from '../lib/categories.js';
import { SynlinError } from '../lib/errors.js';
import { computeStatus, installedEntryHash } from '../lib/installer.js';
import type { CatalogItem } from '../lib/library.js';
import type { Manifest } from '../lib/manifest.js';
import { getToolEntry, installedTools, readManifest } from '../lib/manifest.js';
import type { Runtime } from './context.js';
import { defaultRuntime, loadCatalog, optionalProjectRoot, statusLabel } from './context.js';

export interface ListOptions {
  readonly category?: string;
  readonly installed?: boolean;
}

export async function listCommand(options: ListOptions, runtime: Runtime = defaultRuntime()): Promise<void> {
  const { catalog } = loadCatalog(runtime);
  const projectRoot = optionalProjectRoot(runtime);

  if (options.installed === true) {
    listInstalled(catalog.items, projectRoot, runtime);
    return;
  }

  const filter = parseCategoryFilter(options.category);
  const manifest = projectRoot !== null ? readManifest(projectRoot) : null;

  for (const category of CATEGORIES) {
    if (filter !== null && category !== filter) continue;
    const items = catalog.items.filter((item) => item.category === category);
    if (items.length === 0) continue;

    console.log(pc.bold(`\n${category}`));
    for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
      const annotation = projectRoot !== null && manifest !== null ? statusAnnotation(projectRoot, manifest, item) : '';
      const description = item.description !== undefined ? pc.dim(`  ${item.description}`) : '';
      console.log(`  ${item.name.padEnd(28)}${annotation}${description}`);
    }
  }
  if (projectRoot === null) {
    console.log(pc.dim('\nRun inside a project to see install status.'));
  }
  console.log('');
}

/** Per-tool status tags for an item, e.g. "[claude: installed] [cursor: update available]". */
function statusAnnotation(projectRoot: string, manifest: Manifest, item: CatalogItem): string {
  const tags = installedTools(manifest, item.id)
    .map((tool) => {
      const status = computeStatus(projectRoot, manifest, item.id, item, tool);
      return status === 'not-installed' ? null : `[${tool}: ${statusLabel(status)}]`;
    })
    .filter((tag): tag is string => tag !== null);
  return tags.length > 0 ? `  ${tags.join(' ')}` : '';
}

function listInstalled(catalogItems: readonly CatalogItem[], projectRoot: string | null, _runtime: Runtime): void {
  if (projectRoot === null) {
    throw new SynlinError('Not inside a project — --installed needs a project with a tool config dir (.claude, .codex, .cursor, .opencode).');
  }
  const manifest = readManifest(projectRoot);
  const ids = Object.keys(manifest.items).sort();
  if (ids.length === 0) {
    console.log('No synlin-managed items installed in this project.');
    return;
  }
  console.log(pc.bold(`Installed in ${projectRoot}:`));
  for (const id of ids) {
    const libraryItem = catalogItems.find((item) => item.id === id) ?? null;
    for (const tool of installedTools(manifest, id)) {
      const status = computeStatus(projectRoot, manifest, id, libraryItem, tool);
      const entry = getToolEntry(manifest, id, tool);
      const filesMissing = status === 'gone-from-library' && entry !== undefined && installedEntryHash(projectRoot, entry.outputs) === null;
      const extra = filesMissing ? `${statusLabel(status)} + files missing` : statusLabel(status);
      console.log(`  ${id.padEnd(36)} ${pc.dim(`[${tool}]`.padEnd(11))} [${extra}]`);
    }
  }
}

function parseCategoryFilter(category: string | undefined): Category | null {
  if (category === undefined) return null;
  if (!isCategory(category)) {
    throw new SynlinError(`Unknown category "${category}". Valid categories: ${CATEGORIES.join(', ')}`);
  }
  return category;
}
