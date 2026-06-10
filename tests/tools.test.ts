import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashTree, hashVirtualTree } from '../src/lib/hash.js';
import type { CatalogItem } from '../src/lib/library.js';
import { scanLibrary } from '../src/lib/library.js';
import { claudeAdapter, claudeProjectRelativePath } from '../src/lib/tools/claude.js';
import { codexAdapter } from '../src/lib/tools/codex.js';
import { cursorAdapter } from '../src/lib/tools/cursor.js';
import { opencodeAdapter } from '../src/lib/tools/opencode.js';
import type { OwnedTreeOutput } from '../src/lib/tools/types.js';
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

function libraryItems(libraryRoot: string): readonly CatalogItem[] {
  return scanLibrary(libraryRoot).items;
}

function itemById(items: readonly CatalogItem[], id: string): CatalogItem {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`fixture is missing ${id}`);
  return item;
}

function ownedTree(item: CatalogItem, adapter: typeof cursorAdapter): OwnedTreeOutput {
  const output = adapter.render(item).outputs[0];
  if (output === undefined || output.kind !== 'owned-tree') throw new Error('expected owned-tree output');
  return output;
}

function fileText(output: OwnedTreeOutput): string {
  const file = output.files[0];
  if (!file) throw new Error('expected one file');
  return file.content.toString('utf8');
}

describe('claude adapter', () => {
  it('renders every category as a verbatim owned tree at the .claude path', () => {
    const { items } = scanLibrary(fixtureLibrary());
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const rendered = claudeAdapter.render(item);
      expect(rendered.outputs).toHaveLength(1);
      const output = rendered.outputs[0];
      if (output === undefined || output.kind !== 'owned-tree') throw new Error('expected owned-tree');
      expect(output.rootPath).toBe(claudeProjectRelativePath(item));
      expect(output.rootPath.startsWith('.claude')).toBe(true);
    }
  });

  /**
   * Load-bearing equivalence: manifest hashes recorded from disk (hashTree) must
   * match hashes of rendered output (hashVirtualTree) or every migrated project
   * would show phantom "modified" statuses.
   */
  it('hashVirtualTree(render(item)) equals hashTree(item.sourcePath) for all categories', () => {
    const { items } = scanLibrary(fixtureLibrary());
    const categories = new Set(items.map((item) => item.category));
    expect([...categories].sort()).toEqual(['agents', 'commands', 'rules', 'skills', 'templates']);
    for (const item of items) {
      const rendered = claudeAdapter.render(item);
      const output = rendered.outputs[0];
      if (output === undefined || output.kind !== 'owned-tree') throw new Error('expected owned-tree');
      expect(hashVirtualTree(output.files), item.id).toBe(hashTree(item.sourcePath));
    }
  });

  it('supports every category', () => {
    expect(claudeAdapter.supports('skills')).toBe('supported');
    expect(claudeAdapter.supports('templates')).toBe('supported');
  });
});

describe('cursor adapter', () => {
  it('renders skills verbatim under .cursor/skills', () => {
    const items = libraryItems(fixtureLibrary());
    const output = ownedTree(itemById(items, 'skills/nodejs'), cursorAdapter);
    expect(output.rootPath).toBe('.cursor/skills/nodejs');
    expect(hashVirtualTree(output.files)).toBe(hashTree(itemById(items, 'skills/nodejs').sourcePath));
  });

  it('converts agents: keeps name/description, drops tools/model, synthesizes readonly', () => {
    const libraryRoot = fixtureLibrary();
    writeFileDeep(
      path.join(libraryRoot, 'agents', 'auditor.md'),
      '---\nname: auditor\ndescription: Reads code\ntools: Read, Grep, Glob\nmodel: opus\n---\n# Auditor\n\nBody.\n',
    );
    const items = libraryItems(libraryRoot);

    const readonlyAgent = fileText(ownedTree(itemById(items, 'agents/auditor'), cursorAdapter));
    expect(readonlyAgent).toContain('name: auditor');
    expect(readonlyAgent).toContain('readonly: true');
    expect(readonlyAgent).not.toContain('tools:');
    expect(readonlyAgent).not.toContain('model:');
    expect(readonlyAgent).toContain('# Auditor');

    const plainAgent = fileText(ownedTree(itemById(items, 'agents/code-reviewer'), cursorAdapter));
    expect(plainAgent).not.toContain('readonly:');
  });

  it('strips frontmatter from commands entirely', () => {
    const items = libraryItems(fixtureLibrary());
    const command = fileText(ownedTree(itemById(items, 'commands/design'), cursorAdapter));
    expect(command).not.toContain('---');
    expect(command).toContain('Run a design session for $ARGUMENTS');
  });

  it('converts rules to .mdc with globs/alwaysApply synthesized from paths', () => {
    const libraryRoot = fixtureLibrary();
    writeFileDeep(
      path.join(libraryRoot, 'rules', 'typescript', 'testing.md'),
      '---\npaths:\n  - "**/*.ts"\n  - "**/*.tsx"\n---\n# TS Testing\n\nUse vitest.\n',
    );
    const items = libraryItems(libraryRoot);

    const scoped = ownedTree(itemById(items, 'rules/typescript/testing'), cursorAdapter);
    expect(scoped.rootPath).toBe('.cursor/rules/typescript/testing.mdc');
    const scopedText = fileText(scoped);
    expect(scopedText).toContain('globs: "**/*.ts,**/*.tsx"');
    expect(scopedText).toContain('alwaysApply: false');
    expect(scopedText).not.toContain('paths:');

    const alwaysOn = fileText(ownedTree(itemById(items, 'rules/common/coding-style'), cursorAdapter));
    expect(alwaysOn).toContain('alwaysApply: true');
    expect(alwaysOn).toContain('description: Coding Style');
    expect(alwaysOn).not.toContain('globs:');
  });
});

describe('opencode adapter', () => {
  it('maps agent tools to a permission object with mode subagent', () => {
    const libraryRoot = fixtureLibrary();
    writeFileDeep(
      path.join(libraryRoot, 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep, Glob, Bash, mcp__github__*\nmodel: opus\n---\n# Reviewer\n',
    );
    const items = libraryItems(libraryRoot);
    const agent = fileText(ownedTree(itemById(items, 'agents/reviewer'), opencodeAdapter));

    expect(agent).toContain('mode: subagent');
    expect(agent).toContain('read: allow');
    expect(agent).toContain('bash: allow');
    expect(agent).toContain('edit: deny');
    expect(agent).toContain('webfetch: deny');
    expect(agent).not.toContain('mcp__');
    expect(agent).not.toContain('name: reviewer');
    expect(agent).not.toContain('model:');
  });

  it('keeps command description and body verbatim', () => {
    const items = libraryItems(fixtureLibrary());
    const output = ownedTree(itemById(items, 'commands/design'), opencodeAdapter);
    expect(output.rootPath).toBe('.opencode/commands/design.md');
    const command = fileText(output);
    expect(command).toContain('description: Start a design session');
    expect(command).toContain('$ARGUMENTS');
  });
});

describe('codex adapter', () => {
  it('renders skills verbatim and refuses agents/commands with clear reasons', () => {
    const items = libraryItems(fixtureLibrary());
    const output = ownedTree(itemById(items, 'skills/nodejs'), codexAdapter);
    expect(output.rootPath).toBe('.codex/skills/nodejs');
    expect(hashVirtualTree(output.files)).toBe(hashTree(itemById(items, 'skills/nodejs').sourcePath));

    expect(codexAdapter.supports('agents')).toBe('unsupported');
    expect(codexAdapter.unsupportedReason('agents')).toMatch(/TOML/);
    expect(codexAdapter.supports('commands')).toBe('unsupported');
  });
});

describe('render determinism', () => {
  it('renders byte-identical output across repeated calls for every supported pair', () => {
    const items = libraryItems(fixtureLibrary());
    for (const adapter of [claudeAdapter, codexAdapter, cursorAdapter, opencodeAdapter]) {
      for (const item of items) {
        if (adapter.supports(item.category) !== 'supported') continue;
        const first = adapter.render(item);
        const second = adapter.render(item);
        expect(JSON.stringify(first), `${adapter.id}:${item.id}`).toBe(JSON.stringify(second));
      }
    }
  });
});
