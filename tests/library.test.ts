import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanLibrary } from '../src/lib/library.js';
import { makeFixtureLibrary, makeTmpDir, writeFileDeep } from './helpers/tmp.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fixtureLibrary(): string {
  const { dir, cleanup } = makeTmpDir();
  cleanups.push(cleanup);
  return makeFixtureLibrary(dir);
}

describe('scanLibrary', () => {
  it('catalogs every category with ids, paths and descriptions', () => {
    const root = fixtureLibrary();
    const { items, warnings } = scanLibrary(root);
    expect(warnings).toEqual([]);
    expect(items.map((item) => item.id).sort()).toEqual([
      'agents/code-reviewer',
      'agents/tech-lead',
      'commands/design',
      'rules/common/coding-style',
      'rules/typescript/coding-style',
      'skills/design',
      'skills/nodejs',
      'templates/hooks.json',
      'templates/settings.local.json',
    ]);

    const nodejs = items.find((item) => item.id === 'skills/nodejs');
    expect(nodejs?.description).toBe('Node.js backend patterns');
    expect(nodejs?.sourcePath).toBe(path.join(root, 'skills', 'nodejs'));

    const rule = items.find((item) => item.id === 'rules/common/coding-style');
    expect(rule?.description).toBe('Coding Style');
    expect(rule?.name).toBe('common/coding-style');
  });

  it('picks up ungrouped rules directly under rules/', () => {
    const root = fixtureLibrary();
    writeFileDeep(path.join(root, 'rules', 'logging-standards.md'), '# Logging Standards\n');
    const { items } = scanLibrary(root);
    const rule = items.find((item) => item.id === 'rules/logging-standards');
    expect(rule).toBeDefined();
    expect(rule?.description).toBe('Logging Standards');
  });

  it('warns on invalid entries instead of silently dropping them', () => {
    const root = fixtureLibrary();
    fs.mkdirSync(path.join(root, 'skills', 'broken-skill'));
    writeFileDeep(path.join(root, 'agents', 'notes.txt'), 'not markdown');
    const { items, warnings } = scanLibrary(root);
    expect(warnings).toContain('skills/broken-skill: missing SKILL.md — skipped');
    expect(warnings).toContain('agents/notes.txt: expected a .md file — skipped');
    expect(items.find((item) => item.name === 'broken-skill')).toBeUndefined();
  });

  it('handles missing category directories', () => {
    const { dir, cleanup } = makeTmpDir();
    cleanups.push(cleanup);
    const emptyRoot = path.join(dir, 'empty-library');
    fs.mkdirSync(emptyRoot, { recursive: true });
    expect(scanLibrary(emptyRoot)).toEqual({ items: [], warnings: [] });
  });
});
