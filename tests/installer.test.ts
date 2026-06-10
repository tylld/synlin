import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashTree } from '../src/lib/hash.js';
import { computeStatus, installItem, removeItem } from '../src/lib/installer.js';
import { claudeProjectRelativePath } from '../src/lib/tools/claude.js';
import type { CatalogItem } from '../src/lib/library.js';
import { scanLibrary } from '../src/lib/library.js';
import type { Manifest } from '../src/lib/manifest.js';
import { emptyManifest } from '../src/lib/manifest.js';
import { makeFixtureLibrary, makeFixtureProject, makeTmpDir, writeFileDeep } from './helpers/tmp.js';

const NOW = '2026-06-09T12:00:00.000Z';
const LATER = '2026-06-09T13:00:00.000Z';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Fixture {
  readonly libraryRoot: string;
  readonly projectRoot: string;
  readonly items: readonly CatalogItem[];
}

function fixture(): Fixture {
  const { dir, cleanup } = makeTmpDir();
  cleanups.push(cleanup);
  const libraryRoot = makeFixtureLibrary(dir);
  const projectRoot = makeFixtureProject(dir);
  return { libraryRoot, projectRoot, items: scanLibrary(libraryRoot).items };
}

function itemById(fx: Fixture, id: string): CatalogItem {
  const item = fx.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`fixture is missing ${id}`);
  return item;
}

function install(fx: Fixture, id: string, manifest: Manifest, force = false, now = NOW) {
  return installItem({ projectRoot: fx.projectRoot, item: itemById(fx, id), manifest, force, now });
}

describe('installItem — fresh installs', () => {
  it('copies a skill directory with nested files and records the installed hash', () => {
    const fx = fixture();
    writeFileDeep(path.join(fx.libraryRoot, 'skills', 'nodejs', '.DS_Store'), 'junk');
    const { result, manifest } = install(fx, 'skills/nodejs', emptyManifest());

    expect(result.action).toBe('installed');
    const target = path.join(fx.projectRoot, '.claude', 'skills', 'nodejs');
    expect(fs.existsSync(path.join(target, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'data', 'reference.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.DS_Store'))).toBe(false);

    const entry = manifest.items['skills/nodejs']?.claude;
    expect(entry?.hash).toBe(hashTree(target));
    expect(entry?.installedAt).toBe(NOW);
    expect(entry?.updatedAt).toBe(NOW);
    expect(entry?.outputs).toEqual([{ kind: 'owned-tree', rootPath: '.claude/skills/nodejs' }]);
  });

  it('copies single-file items into their category folder', () => {
    const fx = fixture();
    const { manifest } = install(fx, 'agents/code-reviewer', emptyManifest());
    expect(fs.existsSync(path.join(fx.projectRoot, '.claude', 'agents', 'code-reviewer.md'))).toBe(true);

    const after = install(fx, 'rules/typescript/coding-style', manifest);
    expect(fs.existsSync(path.join(fx.projectRoot, '.claude', 'rules', 'typescript', 'coding-style.md'))).toBe(true);
    expect(Object.keys(after.manifest.items).sort()).toEqual(['agents/code-reviewer', 'rules/typescript/coding-style']);
  });

  it('skips unmanaged existing targets unless forced, then adopts', () => {
    const fx = fixture();
    const target = path.join(fx.projectRoot, '.claude', 'agents', 'code-reviewer.md');
    writeFileDeep(target, 'pre-existing local agent');

    const skipped = install(fx, 'agents/code-reviewer', emptyManifest());
    expect(skipped.result.action).toBe('skipped-exists');
    expect(fs.readFileSync(target, 'utf8')).toBe('pre-existing local agent');
    expect(skipped.manifest.items['agents/code-reviewer']).toBeUndefined();

    const forced = install(fx, 'agents/code-reviewer', emptyManifest(), true);
    expect(forced.result.action).toBe('overwritten');
    expect(fs.readFileSync(target, 'utf8')).toContain('Code reviewer');
    expect(forced.manifest.items['agents/code-reviewer']).toBeDefined();
  });
});

describe('installItem — templates are copy-if-absent', () => {
  it('installs when absent, skips when present, overwrites only with force', () => {
    const fx = fixture();
    const target = path.join(fx.projectRoot, '.claude', 'hooks.json');

    const first = install(fx, 'templates/hooks.json', emptyManifest());
    expect(first.result.action).toBe('installed');
    expect(fs.existsSync(target)).toBe(true);

    fs.writeFileSync(target, '{ "hooks": { "local": true } }');
    const second = install(fx, 'templates/hooks.json', first.manifest);
    expect(second.result.action).toBe('skipped-template-exists');
    expect(fs.readFileSync(target, 'utf8')).toContain('local');

    const forced = install(fx, 'templates/hooks.json', first.manifest, true);
    expect(forced.result.action).toBe('overwritten');
    expect(fs.readFileSync(target, 'utf8')).not.toContain('local');
  });
});

describe('computeStatus — three-way matrix', () => {
  it('covers every state', () => {
    const fx = fixture();
    const id = 'skills/nodejs';
    const item = itemById(fx, id);

    expect(computeStatus(fx.projectRoot, emptyManifest(), id, item)).toBe('not-installed');

    const { manifest } = install(fx, id, emptyManifest());
    expect(computeStatus(fx.projectRoot, manifest, id, item)).toBe('up-to-date');
    expect(computeStatus(fx.projectRoot, manifest, id, null)).toBe('gone-from-library');

    const libraryFile = path.join(fx.libraryRoot, 'skills', 'nodejs', 'SKILL.md');
    const installedFile = path.join(fx.projectRoot, '.claude', 'skills', 'nodejs', 'SKILL.md');

    fs.writeFileSync(libraryFile, 'upstream v2');
    expect(computeStatus(fx.projectRoot, manifest, id, item)).toBe('update-available');

    fs.writeFileSync(installedFile, 'local edit');
    expect(computeStatus(fx.projectRoot, manifest, id, item)).toBe('conflict');

    fs.writeFileSync(libraryFile, fs.readFileSync(installedFile, 'utf8'));
    const cleanLibrary = install(fx, id, emptyManifest(), true);
    fs.writeFileSync(installedFile, 'another local edit');
    expect(computeStatus(fx.projectRoot, cleanLibrary.manifest, id, item)).toBe('modified');

    fs.rmSync(path.join(fx.projectRoot, '.claude', 'skills', 'nodejs'), { recursive: true });
    expect(computeStatus(fx.projectRoot, cleanLibrary.manifest, id, item)).toBe('files-missing');
  });
});

describe('installItem — refresh of managed items', () => {
  it('updates clean installs when the library changed, removing upstream-deleted files', () => {
    const fx = fixture();
    const { manifest } = install(fx, 'skills/nodejs', emptyManifest());

    fs.writeFileSync(path.join(fx.libraryRoot, 'skills', 'nodejs', 'SKILL.md'), 'v2');
    fs.rmSync(path.join(fx.libraryRoot, 'skills', 'nodejs', 'data'), { recursive: true });

    const updated = install(fx, 'skills/nodejs', manifest, false, LATER);
    expect(updated.result.action).toBe('updated');
    const target = path.join(fx.projectRoot, '.claude', 'skills', 'nodejs');
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('v2');
    expect(fs.existsSync(path.join(target, 'data'))).toBe(false);

    const entry = updated.manifest.items['skills/nodejs']?.claude;
    expect(entry?.installedAt).toBe(NOW);
    expect(entry?.updatedAt).toBe(LATER);
  });

  it('is a no-op when already up to date', () => {
    const fx = fixture();
    const { manifest } = install(fx, 'agents/tech-lead', emptyManifest());
    const again = install(fx, 'agents/tech-lead', manifest, false, LATER);
    expect(again.result.action).toBe('up-to-date');
    expect(again.manifest.items['agents/tech-lead']?.claude?.updatedAt).toBe(NOW);
  });

  it('protects local modifications unless forced', () => {
    const fx = fixture();
    const { manifest } = install(fx, 'agents/tech-lead', emptyManifest());
    const target = path.join(fx.projectRoot, '.claude', 'agents', 'tech-lead.md');
    fs.writeFileSync(target, 'my local tweaks');

    const skipped = install(fx, 'agents/tech-lead', manifest, false, LATER);
    expect(skipped.result.action).toBe('skipped-modified');
    expect(fs.readFileSync(target, 'utf8')).toBe('my local tweaks');

    const forced = install(fx, 'agents/tech-lead', manifest, true, LATER);
    expect(forced.result.action).toBe('overwritten');
    expect(fs.readFileSync(target, 'utf8')).toContain('Tech lead');
  });

  it('repairs deleted files', () => {
    const fx = fixture();
    const { manifest } = install(fx, 'commands/design', emptyManifest());
    fs.rmSync(path.join(fx.projectRoot, '.claude', 'commands', 'design.md'));

    const repaired = install(fx, 'commands/design', manifest, false, LATER);
    expect(repaired.result.action).toBe('updated');
    expect(fs.existsSync(path.join(fx.projectRoot, '.claude', 'commands', 'design.md'))).toBe(true);
  });
});

describe('removeItem', () => {
  it('removes files, drops the entry and prunes empty group directories', () => {
    const fx = fixture();
    const { manifest } = install(fx, 'rules/typescript/coding-style', emptyManifest());

    const outcome = removeItem(fx.projectRoot, manifest, 'rules/typescript/coding-style');
    expect(outcome.removedFiles).toBe(true);
    expect(outcome.manifest.items['rules/typescript/coding-style']).toBeUndefined();
    expect(fs.existsSync(path.join(fx.projectRoot, '.claude', 'rules'))).toBe(false);
    expect(fs.existsSync(path.join(fx.projectRoot, '.claude'))).toBe(true);
  });

  it('keeps sibling rules when pruning', () => {
    const fx = fixture();
    let manifest = install(fx, 'rules/typescript/coding-style', emptyManifest()).manifest;
    manifest = install(fx, 'rules/common/coding-style', manifest).manifest;

    const outcome = removeItem(fx.projectRoot, manifest, 'rules/typescript/coding-style');
    expect(fs.existsSync(path.join(fx.projectRoot, '.claude', 'rules', 'typescript'))).toBe(false);
    expect(fs.existsSync(path.join(fx.projectRoot, '.claude', 'rules', 'common', 'coding-style.md'))).toBe(true);
    expect(Object.keys(outcome.manifest.items)).toEqual(['rules/common/coding-style']);
  });

  it('drops the entry even when files are already gone', () => {
    const fx = fixture();
    const { manifest } = install(fx, 'agents/tech-lead', emptyManifest());
    fs.rmSync(path.join(fx.projectRoot, '.claude', 'agents', 'tech-lead.md'));

    const outcome = removeItem(fx.projectRoot, manifest, 'agents/tech-lead');
    expect(outcome.removedFiles).toBe(false);
    expect(outcome.manifest.items['agents/tech-lead']).toBeUndefined();
  });
});

describe('claudeProjectRelativePath', () => {
  it('rejects traversal attempts in item names', () => {
    expect(() => claudeProjectRelativePath({ category: 'skills', name: '../evil' })).toThrow(/Invalid item name/);
  });
});
