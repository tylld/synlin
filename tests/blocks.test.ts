import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashBlock, readBlockBody, removeBlock, upsertBlock } from '../src/lib/blocks.js';
import { computeStatus, installItem, removeItem } from '../src/lib/installer.js';
import type { CatalogItem } from '../src/lib/library.js';
import { scanLibrary } from '../src/lib/library.js';
import type { Manifest } from '../src/lib/manifest.js';
import { emptyManifest } from '../src/lib/manifest.js';
import { ruleBlockBody } from '../src/lib/tools/agents-md.js';
import { makeFixtureLibrary, makeFixtureProject, makeTmpDir, writeFileDeep } from './helpers/tmp.js';

const NOW = '2026-06-10T12:00:00.000Z';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('block primitives', () => {
  const ID = 'rules/common/coding-style';

  it('upserts idempotently and replaces in place', () => {
    const created = upsertBlock(null, ID, 'First version\n', 'html');
    expect(created).toContain('# Project Rules');
    expect(created).toContain(`<!-- synlin:begin ${ID} -->`);
    expect(readBlockBody(created, ID, 'html')).toBe('First version\n');

    const withUserContent = `${created}\n## My own notes\n\nhand-written\n`;
    const updated = upsertBlock(withUserContent, ID, 'Second version\n', 'html');
    expect(readBlockBody(updated, ID, 'html')).toBe('Second version\n');
    expect(updated).toContain('hand-written');
    expect(updated.indexOf('synlin:begin')).toBeLessThan(updated.indexOf('My own notes'));
    expect(upsertBlock(updated, ID, 'Second version\n', 'html')).toBe(updated);
  });

  it('appends new blocks at EOF without touching existing content', () => {
    const existing = '# My AGENTS.md\n\nProject notes.\n';
    const result = upsertBlock(existing, ID, 'Rule body\n', 'html');
    expect(result.startsWith('# My AGENTS.md')).toBe(true);
    expect(result.indexOf('Project notes.')).toBeLessThan(result.indexOf('synlin:begin'));
  });

  it('removes blocks, preserving user content; returns null when nothing remains', () => {
    const userFile = upsertBlock('# Mine\n\ncontent\n', ID, 'Body\n', 'html');
    const cleaned = removeBlock(userFile, ID, 'html');
    expect(cleaned).toBe('# Mine\n\ncontent\n');

    const synlinOnly = upsertBlock(null, ID, 'Body\n', 'html');
    expect(removeBlock(synlinOnly, ID, 'html')).toBeNull();
  });

  it('throws on a begin marker without an end marker', () => {
    const corrupt = `<!-- synlin:begin ${ID} -->\nBody\n`;
    expect(() => readBlockBody(corrupt, ID, 'html')).toThrow(/without a matching end marker/);
  });

  it('hashes bodies independent of trailing-newline noise', () => {
    expect(hashBlock('Body\n')).toBe(hashBlock('Body\n\n\n'));
    expect(hashBlock('Body\n')).not.toBe(hashBlock('Other\n'));
  });
});

describe('ruleBlockBody', () => {
  it('strips frontmatter, demotes headings, and preserves paths as an Applies-to line', () => {
    const source = '---\npaths:\n  - "**/*.ts"\n  - "**/*.tsx"\n---\n# TS Style\n\nText.\n\n```md\n# not a heading\n```\n';
    const body = ruleBlockBody('rules/typescript/coding-style', source);
    expect(body).toContain('## TS Style');
    expect(body).toContain('_Applies to: `**/*.ts`, `**/*.tsx`_');
    expect(body).toContain('# not a heading');
    expect(body).not.toContain('paths:');
  });
});

interface Fixture {
  readonly projectRoot: string;
  readonly items: readonly CatalogItem[];
}

function fixture(): Fixture {
  const { dir, cleanup } = makeTmpDir();
  cleanups.push(cleanup);
  const libraryRoot = makeFixtureLibrary(dir);
  const projectRoot = makeFixtureProject(dir);
  return { projectRoot, items: scanLibrary(libraryRoot).items };
}

function item(fx: Fixture, id: string): CatalogItem {
  const found = fx.items.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`fixture is missing ${id}`);
  return found;
}

describe('rules → AGENTS.md install lifecycle', () => {
  const ID = 'rules/common/coding-style';

  function agentsMd(fx: Fixture): string {
    return fs.readFileSync(path.join(fx.projectRoot, 'AGENTS.md'), 'utf8');
  }

  it('installs a rule as a managed block and tracks three-way status', () => {
    const fx = fixture();
    const { result, manifest } = installItem({ projectRoot: fx.projectRoot, item: item(fx, ID), manifest: emptyManifest(), tool: 'codex', now: NOW });

    expect(result.action).toBe('installed');
    expect(agentsMd(fx)).toContain(`<!-- synlin:begin ${ID} -->`);
    expect(agentsMd(fx)).toContain('## Coding Style');
    expect(computeStatus(fx.projectRoot, manifest, ID, item(fx, ID), 'codex')).toBe('up-to-date');

    // edit INSIDE the block → modified
    const edited = agentsMd(fx).replace('Immutability first.', 'Mutability everywhere!');
    fs.writeFileSync(path.join(fx.projectRoot, 'AGENTS.md'), edited);
    expect(computeStatus(fx.projectRoot, manifest, ID, item(fx, ID), 'codex')).toBe('modified');

    // edits OUTSIDE the block are invisible
    installItem({ projectRoot: fx.projectRoot, item: item(fx, ID), manifest, tool: 'codex', force: true, now: NOW });
    fs.appendFileSync(path.join(fx.projectRoot, 'AGENTS.md'), '\nUser notes at the end.\n');
    expect(computeStatus(fx.projectRoot, manifest, ID, item(fx, ID), 'codex')).toBe('up-to-date');

    // markers deleted → files-missing
    fs.writeFileSync(path.join(fx.projectRoot, 'AGENTS.md'), '# Empty\n');
    expect(computeStatus(fx.projectRoot, manifest, ID, item(fx, ID), 'codex')).toBe('files-missing');
  });

  it('shares one physical block between codex and opencode, removed only at refcount zero', () => {
    const fx = fixture();
    let manifest: Manifest = emptyManifest();
    manifest = installItem({ projectRoot: fx.projectRoot, item: item(fx, ID), manifest, tool: 'codex', now: NOW }).manifest;
    const afterFirst = agentsMd(fx);
    manifest = installItem({ projectRoot: fx.projectRoot, item: item(fx, ID), manifest, tool: 'opencode', now: NOW }).manifest;

    expect(agentsMd(fx)).toBe(afterFirst);
    expect(agentsMd(fx).match(/synlin:begin/g)).toHaveLength(1);
    expect(computeStatus(fx.projectRoot, manifest, ID, item(fx, ID), 'opencode')).toBe('up-to-date');

    manifest = removeItem(fx.projectRoot, manifest, ID, 'codex').manifest;
    expect(fs.existsSync(path.join(fx.projectRoot, 'AGENTS.md'))).toBe(true);
    expect(agentsMd(fx)).toContain('synlin:begin');

    manifest = removeItem(fx.projectRoot, manifest, ID, 'opencode').manifest;
    expect(fs.existsSync(path.join(fx.projectRoot, 'AGENTS.md'))).toBe(false);
    expect(manifest.items[ID]).toBeUndefined();
  });

  it('keeps user content when removing the last block from a user-owned AGENTS.md', () => {
    const fx = fixture();
    writeFileDeep(path.join(fx.projectRoot, 'AGENTS.md'), '# My instructions\n\nKeep me.\n');
    let manifest: Manifest = emptyManifest();
    manifest = installItem({ projectRoot: fx.projectRoot, item: item(fx, ID), manifest, tool: 'codex', now: NOW }).manifest;
    removeItem(fx.projectRoot, manifest, ID, 'codex');

    const remaining = fs.readFileSync(path.join(fx.projectRoot, 'AGENTS.md'), 'utf8');
    expect(remaining).toContain('Keep me.');
    expect(remaining).not.toContain('synlin:begin');
  });

  it('update flow repairs a deleted block', () => {
    const fx = fixture();
    const installed = installItem({ projectRoot: fx.projectRoot, item: item(fx, ID), manifest: emptyManifest(), tool: 'codex', now: NOW });
    fs.rmSync(path.join(fx.projectRoot, 'AGENTS.md'));

    const repaired = installItem({ projectRoot: fx.projectRoot, item: item(fx, ID), manifest: installed.manifest, tool: 'codex', now: NOW });
    expect(repaired.result.action).toBe('updated');
    expect(agentsMd(fx)).toContain('synlin:begin');
  });
});
