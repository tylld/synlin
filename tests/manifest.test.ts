import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blockReferences,
  emptyManifest,
  getToolEntry,
  installedTools,
  legacyManifestPath,
  manifestPath,
  readManifest,
  withToolEntry,
  withoutToolEntry,
  writeManifest,
} from '../src/lib/manifest.js';
import { makeFixtureProject, makeTmpDir } from './helpers/tmp.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fixtureProject(): string {
  const { dir, cleanup } = makeTmpDir();
  cleanups.push(cleanup);
  return makeFixtureProject(dir);
}

const ENTRY = {
  hash: 'sha256:abc',
  installedAt: '2026-06-09T00:00:00Z',
  updatedAt: '2026-06-09T00:00:00Z',
  outputs: [{ kind: 'owned-tree' as const, rootPath: '.claude/skills/nodejs' }],
};

const V1_ENTRY = { hash: 'sha256:abc', installedAt: '2026-06-09T00:00:00Z', updatedAt: '2026-06-09T00:00:00Z' };

describe('manifest v2', () => {
  it('reads an empty manifest when no file exists', () => {
    expect(readManifest(fixtureProject())).toEqual({ version: 2, targets: ['claude'], items: {} });
  });

  it('round-trips entries with sorted keys and trailing newline at the project root', () => {
    const project = fixtureProject();
    const manifest = withToolEntry(withToolEntry(emptyManifest(), 'skills/zeta', 'claude', ENTRY), 'agents/alpha', 'claude', ENTRY);
    writeManifest(project, manifest);

    expect(manifestPath(project)).toBe(path.join(project, '.synlin.json'));
    const raw = fs.readFileSync(manifestPath(project), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.indexOf('agents/alpha')).toBeLessThan(raw.indexOf('skills/zeta'));
    expect(readManifest(project)).toEqual(manifest);
  });

  it('migrates a legacy v1 manifest in memory with claude-only entries', () => {
    const project = fixtureProject();
    fs.writeFileSync(
      legacyManifestPath(project),
      JSON.stringify({ version: 1, items: { 'skills/nodejs': V1_ENTRY, 'rules/common/coding-style': V1_ENTRY } }),
    );
    const manifest = readManifest(project);
    expect(manifest.version).toBe(2);
    expect(manifest.targets).toEqual(['claude']);
    expect(getToolEntry(manifest, 'skills/nodejs', 'claude')).toEqual({
      ...V1_ENTRY,
      outputs: [{ kind: 'owned-tree', rootPath: '.claude/skills/nodejs' }],
    });
    expect(getToolEntry(manifest, 'rules/common/coding-style', 'claude')?.outputs).toEqual([
      { kind: 'owned-tree', rootPath: '.claude/rules/common/coding-style.md' },
    ]);
    // read-only: legacy file untouched until a write happens
    expect(fs.existsSync(legacyManifestPath(project))).toBe(true);
  });

  it('writeManifest persists v2 at the root and deletes the legacy file', () => {
    const project = fixtureProject();
    fs.writeFileSync(legacyManifestPath(project), JSON.stringify({ version: 1, items: { 'skills/nodejs': V1_ENTRY } }));
    const migrated = readManifest(project);
    writeManifest(project, migrated);
    expect(fs.existsSync(legacyManifestPath(project))).toBe(false);
    expect(readManifest(project)).toEqual(migrated);
  });

  it('prefers a root v2 manifest over a stale legacy file', () => {
    const project = fixtureProject();
    fs.writeFileSync(legacyManifestPath(project), JSON.stringify({ version: 1, items: { 'skills/stale': V1_ENTRY } }));
    writeManifest(project, withToolEntry(emptyManifest(), 'skills/fresh', 'claude', ENTRY));
    const manifest = readManifest(project);
    expect(Object.keys(manifest.items)).toEqual(['skills/fresh']);
  });

  it('rejects corrupt JSON, future versions, and invalid entries', () => {
    const project = fixtureProject();
    fs.writeFileSync(manifestPath(project), '{ not json');
    expect(() => readManifest(project)).toThrow(/Corrupt manifest/);

    fs.writeFileSync(manifestPath(project), JSON.stringify({ version: 99, targets: [], items: {} }));
    expect(() => readManifest(project)).toThrow(/Unsupported manifest version 99/);

    fs.writeFileSync(manifestPath(project), JSON.stringify({ version: 2, targets: ['claude'], items: { 'skills/x': { claude: { hash: 5 } } } }));
    expect(() => readManifest(project)).toThrow(/Invalid manifest entry "skills\/x"/);

    fs.writeFileSync(manifestPath(project), JSON.stringify({ version: 2, targets: ['emacs'], items: {} }));
    expect(() => readManifest(project)).toThrow(/"targets" must be an array of tool ids/);

    fs.writeFileSync(manifestPath(project), JSON.stringify({ version: 2, targets: ['claude'], items: { 'skills/x': { emacs: ENTRY } } }));
    expect(() => readManifest(project)).toThrow(/unknown tool "emacs"/);
  });

  it('withToolEntry/withoutToolEntry are immutable and drop empty items', () => {
    const base = emptyManifest();
    const added = withToolEntry(base, 'skills/nodejs', 'claude', ENTRY);
    const both = withToolEntry(added, 'skills/nodejs', 'codex', ENTRY);
    expect(base.items).toEqual({});
    expect(installedTools(both, 'skills/nodejs')).toEqual(['claude', 'codex']);

    const oneLeft = withoutToolEntry(both, 'skills/nodejs', 'claude');
    expect(installedTools(oneLeft, 'skills/nodejs')).toEqual(['codex']);
    const empty = withoutToolEntry(oneLeft, 'skills/nodejs', 'codex');
    expect(empty.items).toEqual({});
    expect(installedTools(both, 'skills/nodejs')).toEqual(['claude', 'codex']);
  });

  it('counts managed-block references across tools for refcounting', () => {
    const block = {
      ...V1_ENTRY,
      outputs: [{ kind: 'managed-block' as const, filePath: 'AGENTS.md', blockId: 'rules/common/coding-style' }],
    };
    let manifest = emptyManifest();
    manifest = withToolEntry(manifest, 'rules/common/coding-style', 'codex', block);
    expect(blockReferences(manifest, 'AGENTS.md', 'rules/common/coding-style')).toBe(1);
    manifest = withToolEntry(manifest, 'rules/common/coding-style', 'opencode', block);
    expect(blockReferences(manifest, 'AGENTS.md', 'rules/common/coding-style')).toBe(2);
    manifest = withoutToolEntry(manifest, 'rules/common/coding-style', 'codex');
    expect(blockReferences(manifest, 'AGENTS.md', 'rules/common/coding-style')).toBe(1);
  });
});
