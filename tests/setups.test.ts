import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { addCommand } from '../src/commands/add.js';
import type { Runtime } from '../src/commands/context.js';
import { setupCommand } from '../src/commands/setup.js';
import { statusCommand, collectProjectStatus, scanGlobalSetup } from '../src/commands/status.js';
import { deleteLibraryItem } from '../src/commands/library.js';
import { scanLibrary } from '../src/lib/library.js';
import { readManifest } from '../src/lib/manifest.js';
import { listSetups, readSetup, writeSetup } from '../src/lib/setups.js';
import { makeFixtureLibrary, makeFixtureProject, makeTmpDir, writeFileDeep } from './helpers/tmp.js';

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterAll(() => {
  vi.restoreAllMocks();
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Fixture {
  readonly dir: string;
  readonly libraryRoot: string;
  readonly projectRoot: string;
  readonly runtime: Runtime;
}

function fixture(): Fixture {
  const { dir, cleanup } = makeTmpDir();
  cleanups.push(cleanup);
  const libraryRoot = makeFixtureLibrary(dir);
  const projectRoot = makeFixtureProject(dir);
  return {
    dir,
    libraryRoot,
    projectRoot,
    runtime: { cwd: projectRoot, env: { SYNLIN_LIBRARY: libraryRoot }, interactive: false },
  };
}

describe('setup save/apply/remove', () => {
  it('saves the installed set + targets, applies it to another project, removes it', async () => {
    const fx = fixture();
    await addCommand(['skills/nodejs', 'agents/tech-lead', 'rules/common/coding-style'], {}, fx.runtime);
    await setupCommand('save', 'backend', {}, fx.runtime);

    const saved = readSetup(fx.libraryRoot, 'backend');
    expect(saved.items).toEqual(['agents/tech-lead', 'rules/common/coding-style', 'skills/nodejs']);
    expect(saved.targets).toEqual(['claude']);

    // apply in a second, fresh project
    const otherRoot = path.join(fx.dir, 'other-project');
    fs.mkdirSync(path.join(otherRoot, '.claude'), { recursive: true });
    const otherRuntime: Runtime = { ...fx.runtime, cwd: otherRoot };
    await setupCommand('add', 'backend', {}, otherRuntime);

    expect(fs.existsSync(path.join(otherRoot, '.claude', 'skills', 'nodejs', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(otherRoot, '.claude', 'agents', 'tech-lead.md'))).toBe(true);
    const manifest = readManifest(otherRoot);
    expect(Object.keys(manifest.items).sort()).toEqual(['agents/tech-lead', 'rules/common/coding-style', 'skills/nodejs']);
    expect(manifest.targets).toEqual(['claude']);

    await setupCommand('remove', 'backend', { force: true }, fx.runtime);
    expect(listSetups(fx.libraryRoot)).toEqual([]);
  });

  it('refuses to overwrite an existing setup without --force (non-interactive)', async () => {
    const fx = fixture();
    await addCommand(['agents/tech-lead'], {}, fx.runtime);
    await setupCommand('save', 'mini', {}, fx.runtime);
    await expect(setupCommand('save', 'mini', {}, fx.runtime)).rejects.toThrow(/--force/);
    await setupCommand('save', 'mini', { force: true }, fx.runtime);
  });

  it('warns about items missing from the library instead of failing', async () => {
    const fx = fixture();
    writeSetup(fx.libraryRoot, { name: 'ghost', items: ['skills/nodejs', 'skills/vanished'], targets: ['claude'], savedAt: '' });
    await setupCommand('add', 'ghost', {}, fx.runtime);
    expect(fs.existsSync(path.join(fx.projectRoot, '.claude', 'skills', 'nodejs', 'SKILL.md'))).toBe(true);
    expect(Object.keys(readManifest(fx.projectRoot).items)).toEqual(['skills/nodejs']);
  });

  it('validates names and rejects unknown actions', async () => {
    const fx = fixture();
    await expect(setupCommand('save', '../evil', {}, fx.runtime)).rejects.toThrow(/Invalid setup name/);
    await expect(setupCommand('frobnicate', 'x', {}, fx.runtime)).rejects.toThrow(/Unknown setup action/);
    await expect(setupCommand('add', 'missing', {}, fx.runtime)).rejects.toThrow(/does not exist/);
  });
});

describe('status', () => {
  it('collects per-tool project status including shared blocks', async () => {
    const fx = fixture();
    fs.writeFileSync(
      path.join(fx.projectRoot, '.synlin.json'),
      JSON.stringify({ version: 2, targets: ['claude', 'codex'], items: {} }),
    );
    await addCommand(['rules/common/coding-style'], {}, fx.runtime);

    const status = collectProjectStatus(fx.projectRoot, scanLibrary(fx.libraryRoot).items);
    expect(status.targets).toEqual(['claude', 'codex']);
    expect(status.agentsMdBlocks).toEqual(['rules/common/coding-style']);
    const codexRow = status.items.find((row) => row.tool === 'codex');
    expect(codexRow?.status).toBe('up-to-date');
    expect(codexRow?.viaSharedBlock).toBe(true);
  });

  it('statusCommand runs without a project and with --global', async () => {
    const fx = fixture();
    const outside: Runtime = { ...fx.runtime, cwd: fx.dir };
    await expect(statusCommand({}, outside)).resolves.toBeUndefined();
    await expect(statusCommand({ global: true }, fx.runtime)).resolves.toBeUndefined();
  });

  it('scans a global home dir and matches items against the library', () => {
    const fx = fixture();
    const home = path.join(fx.dir, 'home');
    // identical skill: copy from library
    writeFileDeep(
      path.join(home, '.claude', 'skills', 'nodejs', 'SKILL.md'),
      fs.readFileSync(path.join(fx.libraryRoot, 'skills', 'nodejs', 'SKILL.md'), 'utf8'),
    );
    writeFileDeep(
      path.join(home, '.claude', 'skills', 'nodejs', 'data', 'reference.md'),
      fs.readFileSync(path.join(fx.libraryRoot, 'skills', 'nodejs', 'data', 'reference.md'), 'utf8'),
    );
    // diverged agent
    writeFileDeep(path.join(home, '.claude', 'agents', 'tech-lead.md'), 'totally different\n');
    // unmanaged command
    writeFileDeep(path.join(home, '.claude', 'commands', 'my-own.md'), 'mine\n');
    // global instructions + codex skill
    writeFileDeep(path.join(home, '.claude', 'CLAUDE.md'), 'global rules\n');
    writeFileDeep(path.join(home, '.codex', 'skills', 'design', 'SKILL.md'), 'not the library version\n');

    const status = scanGlobalSetup(home, scanLibrary(fx.libraryRoot).items);
    const byKey = (tool: string, name: string) => status.entries.find((entry) => entry.tool === tool && entry.name === name);
    expect(byKey('claude', 'nodejs')?.match).toBe('identical');
    expect(byKey('claude', 'tech-lead')?.match).toBe('diverged');
    expect(byKey('claude', 'my-own')?.match).toBe('unmanaged');
    expect(byKey('codex', 'design')?.match).toBe('diverged');
    expect(status.instructionFiles).toContainEqual(['claude', '~/.claude/CLAUDE.md']);
  });
});

describe('deleteLibraryItem', () => {
  it('deletes the item and prunes an emptied rules group', () => {
    const fx = fixture();
    const items = scanLibrary(fx.libraryRoot).items;
    const rule = items.find((candidate) => candidate.id === 'rules/typescript/coding-style');
    if (!rule) throw new Error('fixture is missing the rule');

    deleteLibraryItem(fx.libraryRoot, rule);
    expect(fs.existsSync(path.join(fx.libraryRoot, 'rules', 'typescript'))).toBe(false);
    expect(fs.existsSync(path.join(fx.libraryRoot, 'rules', 'common', 'coding-style.md'))).toBe(true);
  });
});
