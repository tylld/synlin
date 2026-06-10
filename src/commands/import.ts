import fs from 'node:fs';
import path from 'node:path';
import { confirm, isCancel } from '@clack/prompts';
import pc from 'picocolors';
import type { Category, ItemRef } from '../lib/categories.js';
import { isCategory, isValidItemName, itemId, libraryRelativePath } from '../lib/categories.js';
import { copyPath, diffTrees } from '../lib/copy.js';
import { SynlinError } from '../lib/errors.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { hashTree } from '../lib/hash.js';
import { getToolEntry, hasManifest, readManifest, withToolEntry, writeManifest } from '../lib/manifest.js';
import { findProjectRoot } from '../lib/paths.js';
import { claudeProjectRelativePath } from '../lib/tools/claude.js';
import type { InferredImport } from '../lib/tools/import-infer.js';
import { inferImport } from '../lib/tools/import-infer.js';
import type { Runtime } from './context.js';
import { defaultRuntime, loadCatalog, nowIso } from './context.js';

export interface ImportOptions {
  readonly category?: string;
  readonly as?: string;
  readonly force?: boolean;
}

export type { InferredImport } from '../lib/tools/import-infer.js';
export { inferImport } from '../lib/tools/import-infer.js';

export async function importCommand(sourceArg: string, options: ImportOptions, runtime: Runtime = defaultRuntime()): Promise<void> {
  const sourcePath = path.resolve(runtime.cwd, sourceArg);
  if (!fs.existsSync(sourcePath)) {
    throw new SynlinError(`Source path does not exist: ${sourcePath}`);
  }
  const { libraryRoot } = loadCatalog(runtime);
  if (sourcePath === libraryRoot || sourcePath.startsWith(libraryRoot + path.sep)) {
    throw new SynlinError('Source is inside the library itself — edit it directly and commit instead.');
  }
  const target = resolveImportTarget(sourcePath, options);
  const { ref, itemRoot } = target;
  const destination = path.join(libraryRoot, libraryRelativePath(ref));

  if (target.transform !== undefined) {
    await importConverted(target, destination, libraryRoot, options, runtime);
    return;
  }

  validateShape(ref, itemRoot);
  if (fs.existsSync(destination) && !(await confirmOverwrite(ref, itemRoot, destination, options, runtime))) {
    console.log(pc.yellow('Import aborted — library left untouched.'));
    return;
  }

  copyPath(itemRoot, destination);
  if (target.tool === 'claude') {
    syncSourceProjectManifest(ref, itemRoot, destination);
  }

  console.log(`${pc.green('imported')} ${itemId(ref)} → ${path.relative(libraryRoot, destination)}`);
  console.log(pc.dim(`Review and commit: git -C ${libraryRoot} diff`));
}

/** Import of a converted (non-canonical) format: reverse-convert in memory, then write. */
async function importConverted(
  target: InferredImport,
  destination: string,
  libraryRoot: string,
  options: ImportOptions,
  runtime: Runtime,
): Promise<void> {
  const { ref, itemRoot, tool, transform } = target;
  if (transform === undefined) throw new SynlinError(`Internal: importConverted without a transform for ${itemId(ref)}`, 1);
  if (!fs.statSync(itemRoot).isFile()) {
    throw new SynlinError(`${ref.category} items must be single files — ${itemRoot} is a directory.`);
  }
  const content = transform(fs.readFileSync(itemRoot, 'utf8'));

  if (fs.existsSync(destination)) {
    if (fs.readFileSync(destination, 'utf8') === content) {
      console.log(pc.dim(`${itemId(ref)} is already identical in the library — nothing to do.`));
      return;
    }
    if (options.force !== true) {
      if (!runtime.interactive) {
        throw new SynlinError('Library item exists and differs. Re-run with --force to overwrite it.');
      }
      const answer = await confirm({ message: `${itemId(ref)} exists in the library and differs. Overwrite with the converted ${tool} version?` });
      if (isCancel(answer) || answer !== true) {
        console.log(pc.yellow('Import aborted — library left untouched.'));
        return;
      }
    }
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
  console.log(`${pc.green('imported')} ${itemId(ref)} ${pc.dim(`(converted back from ${tool})`)} → ${path.relative(libraryRoot, destination)}`);
  console.log(pc.dim(`Review and commit: git -C ${libraryRoot} diff`));
}

function resolveImportTarget(sourcePath: string, options: ImportOptions): InferredImport {
  const inferred = inferImport(sourcePath);
  const category = parseCategoryOption(options.category) ?? inferred?.ref.category;
  if (category === undefined) {
    throw new SynlinError(
      `Cannot infer the category of ${sourcePath} (no tool config dir segment like .claude/<category>/). Pass --category <${'skills|agents|commands|rules|templates'}>.`,
    );
  }
  const sameCategory = inferred !== null && inferred.ref.category === category;
  const itemRoot = sameCategory ? inferred.itemRoot : sourcePath;
  const name = options.as ?? (sameCategory ? inferred.ref.name : defaultName(category, sourcePath));
  if (!isValidItemName(category, name)) {
    throw new SynlinError(`Invalid item name "${name}" for category "${category}" (lowercase, [a-z0-9._-], rules may have one group segment)`);
  }
  return {
    ref: { category, name },
    itemRoot,
    tool: sameCategory ? inferred.tool : 'claude',
    ...(sameCategory && inferred.transform !== undefined ? { transform: inferred.transform } : {}),
  };
}

function parseCategoryOption(category: string | undefined): Category | undefined {
  if (category === undefined) return undefined;
  if (!isCategory(category)) {
    throw new SynlinError(`Unknown category "${category}". Valid categories: skills, agents, commands, rules, templates`);
  }
  return category;
}

function defaultName(category: Category, sourcePath: string): string {
  const base = path.basename(sourcePath);
  const stripsMd = category === 'agents' || category === 'commands' || category === 'rules';
  return stripsMd && base.endsWith('.md') ? base.slice(0, -3) : base;
}

function validateShape(ref: ItemRef, itemRoot: string): void {
  const stat = fs.statSync(itemRoot);
  if (ref.category === 'skills') {
    if (!stat.isDirectory() || !fs.existsSync(path.join(itemRoot, 'SKILL.md'))) {
      throw new SynlinError(`A skill must be a directory containing SKILL.md — ${itemRoot} is not.`);
    }
    warnOnWeakFrontmatter(path.join(itemRoot, 'SKILL.md'), ref);
    return;
  }
  if (!stat.isFile()) {
    throw new SynlinError(`${ref.category} items must be single files — ${itemRoot} is a directory.`);
  }
  if (ref.category !== 'templates' && !itemRoot.endsWith('.md')) {
    throw new SynlinError(`${ref.category} items must be .md files.`);
  }
  if (ref.category === 'agents' || ref.category === 'commands') {
    warnOnWeakFrontmatter(itemRoot, ref);
  }
  if (ref.category === 'commands' && !fs.readFileSync(itemRoot, 'utf8').includes('$ARGUMENTS')) {
    console.warn(pc.yellow(`note: ${itemId(ref)} has no $ARGUMENTS placeholder — it will ignore arguments when invoked.`));
  }
}

function warnOnWeakFrontmatter(filePath: string, ref: ItemRef): void {
  const { name, description } = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
  if (name === undefined || description === undefined) {
    console.warn(pc.yellow(`note: ${itemId(ref)} is missing name/description frontmatter — picker hints will be empty.`));
  }
}

async function confirmOverwrite(
  ref: ItemRef,
  itemRoot: string,
  destination: string,
  options: ImportOptions,
  runtime: Runtime,
): Promise<boolean> {
  const diff = diffTrees(itemRoot, destination);
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    console.log(pc.dim(`${itemId(ref)} is already identical in the library — nothing to do.`));
    return false;
  }
  console.log(`${itemId(ref)} already exists in the library. Changes:`);
  for (const file of diff.changed) console.log(pc.yellow(`  ~ ${file}`));
  for (const file of diff.added) console.log(pc.green(`  + ${file}`));
  for (const file of diff.removed) console.log(pc.red(`  - ${file}`));

  if (options.force === true) return true;
  if (!runtime.interactive) {
    throw new SynlinError('Library item exists and differs. Re-run with --force to overwrite it.');
  }
  const answer = await confirm({ message: 'Overwrite the library version with these changes?' });
  return !isCancel(answer) && answer === true;
}

/**
 * When importing from a project that has a manifest, record the new hash there
 * too — the project copy and the library copy are now identical, so the next
 * `synlin update` must not report it as modified.
 */
function syncSourceProjectManifest(ref: ItemRef, itemRoot: string, destination: string): void {
  const projectRoot = findProjectRoot(path.dirname(itemRoot));
  if (projectRoot === null || !hasManifest(projectRoot)) return;
  const manifest = readManifest(projectRoot);
  const id = itemId(ref);
  const previous = getToolEntry(manifest, id, 'claude');
  const now = nowIso();
  const entry = {
    hash: hashTree(destination),
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
    outputs: previous?.outputs ?? [{ kind: 'owned-tree' as const, rootPath: claudeRelativePosix(ref) }],
  };
  writeManifest(projectRoot, withToolEntry(manifest, id, 'claude', entry));
  console.log(pc.dim(`Synced manifest entry ${id} in ${projectRoot}`));
}

function claudeRelativePosix(ref: ItemRef): string {
  return claudeProjectRelativePath(ref).split(path.sep).join('/');
}
