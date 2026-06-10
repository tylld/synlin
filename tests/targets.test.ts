import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { addCommand } from '../src/commands/add.js';
import type { Runtime } from '../src/commands/context.js';
import { resolveTargets } from '../src/commands/context.js';
import { targetsCommand } from '../src/commands/targets.js';
import { emptyManifest, readManifest, withTargets, writeManifest } from '../src/lib/manifest.js';
import { makeFixtureLibrary, makeFixtureProject, makeTmpDir } from './helpers/tmp.js';

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

function fixture(): { projectRoot: string; runtime: Runtime } {
  const { dir, cleanup } = makeTmpDir();
  cleanups.push(cleanup);
  const libraryRoot = makeFixtureLibrary(dir);
  const projectRoot = makeFixtureProject(dir);
  return {
    projectRoot,
    runtime: { cwd: projectRoot, env: { SYNLIN_LIBRARY: libraryRoot }, interactive: false },
  };
}

describe('resolveTargets', () => {
  it('defaults to claude and validates --tool flags', () => {
    const manifest = emptyManifest();
    expect(resolveTargets(manifest)).toEqual(['claude']);
    expect(() => resolveTargets(manifest, ['emacs'])).toThrow(/Unknown tool "emacs"/);
    expect(() => resolveTargets(manifest, ['codex'])).toThrow(/not a configured target/);

    const multi = withTargets(manifest, ['codex', 'claude']);
    expect(resolveTargets(multi)).toEqual(['claude', 'codex']);
    expect(resolveTargets(multi, ['codex'])).toEqual(['codex']);
  });
});

describe('targets command', () => {
  it('adds and removes targets in the manifest', async () => {
    const fx = fixture();
    await targetsCommand('add', ['codex'], {}, fx.runtime);
    expect(readManifest(fx.projectRoot).targets).toEqual(['claude', 'codex']);

    await targetsCommand('remove', ['codex'], { force: true }, fx.runtime);
    expect(readManifest(fx.projectRoot).targets).toEqual(['claude']);
  });

  it('refuses to remove the last target', async () => {
    const fx = fixture();
    writeManifest(fx.projectRoot, emptyManifest(['claude']));
    await expect(targetsCommand('remove', ['claude'], { force: true }, fx.runtime)).rejects.toThrow(/at least one/);
  });

  it('rejects unknown actions and tools', async () => {
    const fx = fixture();
    await expect(targetsCommand('frobnicate', ['claude'], {}, fx.runtime)).rejects.toThrow(/Unknown targets action/);
    await expect(targetsCommand('add', ['emacs'], {}, fx.runtime)).rejects.toThrow(/Unknown tool/);
  });
});

describe('multi-target add', () => {
  it('installs the same item for every configured target that supports it', async () => {
    const fx = fixture();
    writeManifest(fx.projectRoot, withTargets(emptyManifest(), ['claude', 'codex']));

    await addCommand(['skills/nodejs'], {}, fx.runtime);

    expect(fs.existsSync(path.join(fx.projectRoot, '.claude', 'skills', 'nodejs', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(fx.projectRoot, '.codex', 'skills', 'nodejs', 'SKILL.md'))).toBe(true);
    const manifest = readManifest(fx.projectRoot);
    expect(manifest.items['skills/nodejs']?.claude).toBeDefined();
    expect(manifest.items['skills/nodejs']?.codex).toBeDefined();
  });

  it('skips unsupported pairs without failing when another target supports the item', async () => {
    const fx = fixture();
    writeManifest(fx.projectRoot, withTargets(emptyManifest(), ['claude', 'codex']));

    await addCommand(['templates/hooks.json'], {}, fx.runtime);

    expect(fs.existsSync(path.join(fx.projectRoot, '.claude', 'hooks.json'))).toBe(true);
    const manifest = readManifest(fx.projectRoot);
    expect(manifest.items['templates/hooks.json']?.claude).toBeDefined();
    expect(manifest.items['templates/hooks.json']?.codex).toBeUndefined();
  });

  it('fails when no configured target supports the item', async () => {
    const fx = fixture();
    writeManifest(fx.projectRoot, withTargets(emptyManifest(), ['codex']));
    await expect(addCommand(['templates/hooks.json'], {}, fx.runtime)).rejects.toThrow(/not supported by any configured target/);
  });

  it('respects --tool narrowing', async () => {
    const fx = fixture();
    writeManifest(fx.projectRoot, withTargets(emptyManifest(), ['claude', 'codex']));
    await addCommand(['agents/tech-lead'], { tool: ['claude'] }, fx.runtime);
    const manifest = readManifest(fx.projectRoot);
    expect(manifest.items['agents/tech-lead']?.claude).toBeDefined();
  });
});
