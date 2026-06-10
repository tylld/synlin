import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertInside,
  assertSafeInstallTarget,
  assertWritable,
  findLibraryRoot,
  findPackageRoot,
  findProjectRoot,
  projectWriteEnvelope,
} from '../src/lib/paths.js';
import { makeTmpDir } from './helpers/tmp.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tmp(): string {
  const { dir, cleanup } = makeTmpDir();
  cleanups.push(cleanup);
  return dir;
}

describe('findPackageRoot / findLibraryRoot', () => {
  it('locates the synlin repo root', () => {
    const root = findPackageRoot();
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string };
    expect(pkg.name).toBe('synlin');
  });

  it('honors SYNLIN_LIBRARY override and validates existence', () => {
    const dir = tmp();
    expect(findLibraryRoot({ SYNLIN_LIBRARY: dir })).toBe(dir);
    expect(() => findLibraryRoot({ SYNLIN_LIBRARY: path.join(dir, 'missing') })).toThrow(/Library directory not found/);
  });
});

describe('findProjectRoot', () => {
  it('finds the nearest ancestor with .claude', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'proj', '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'proj', 'src', 'deep'), { recursive: true });
    expect(findProjectRoot(path.join(dir, 'proj', 'src', 'deep'), '/nonexistent-home')).toBe(path.join(dir, 'proj'));
  });

  it('returns null when nothing matches', () => {
    const dir = tmp();
    expect(findProjectRoot(dir, '/nonexistent-home')).toBeNull();
  });

  it('skips the home directory even though ~/.claude exists', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'home', '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'home', 'code'), { recursive: true });
    expect(findProjectRoot(path.join(dir, 'home', 'code'), path.join(dir, 'home'))).toBeNull();
  });

  it('finds projects anchored by any tool config dir', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'proj', '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'proj', 'src'), { recursive: true });
    expect(findProjectRoot(path.join(dir, 'proj', 'src'), '/nonexistent-home')).toBe(path.join(dir, 'proj'));
  });

  it('prefers a .synlin.json ancestor over a closer tool dir (nested-package case)', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'repo', 'packages', 'sub', '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'repo', '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'repo', '.synlin.json'), '{"version":2,"targets":["claude"],"items":{}}');
    expect(findProjectRoot(path.join(dir, 'repo', 'packages', 'sub'), '/nonexistent-home')).toBe(path.join(dir, 'repo'));
  });
});

describe('projectWriteEnvelope / assertWritable', () => {
  it('allows tool dirs, declared shared files and the manifest; rejects everything else', () => {
    const dir = tmp();
    const envelope = projectWriteEnvelope(dir);

    expect(() => assertWritable(envelope, path.join(dir, '.claude', 'skills', 'x', 'SKILL.md'))).not.toThrow();
    expect(() => assertWritable(envelope, path.join(dir, '.cursor', 'rules', 'common', 'style.mdc'))).not.toThrow();
    expect(() => assertWritable(envelope, path.join(dir, '.opencode', 'agents', 'a.md'))).not.toThrow();
    expect(() => assertWritable(envelope, path.join(dir, '.codex', 'skills', 'x'))).not.toThrow();
    expect(() => assertWritable(envelope, path.join(dir, 'AGENTS.md'))).not.toThrow();
    expect(() => assertWritable(envelope, path.join(dir, '.synlin.json'))).not.toThrow();

    expect(() => assertWritable(envelope, path.join(dir, 'src', 'index.ts'))).toThrow(/write envelope/);
    expect(() => assertWritable(envelope, path.join(dir, 'README.md'))).toThrow(/write envelope/);
    expect(() => assertWritable(envelope, path.join(dir, 'sub', 'AGENTS.md'))).toThrow(/write envelope/);
    expect(() => assertWritable(envelope, '/etc/passwd')).toThrow(/write envelope/);
    expect(() => assertWritable(envelope, path.join(dir, '..', '.claude', 'x'))).toThrow(/write envelope/);
  });
});

describe('install target guard', () => {
  it('refuses home and the synlin checkout, accepts real projects', () => {
    const dir = tmp();
    const home = path.join(dir, 'home');
    const pkgRoot = path.join(dir, 'synlin-repo');
    const project = path.join(dir, 'project');
    for (const d of [home, pkgRoot, project]) fs.mkdirSync(d, { recursive: true });

    expect(() => assertSafeInstallTarget(home, { homeDir: home, packageRoot: pkgRoot })).toThrow(/home directory/);
    expect(() => assertSafeInstallTarget(pkgRoot, { homeDir: home, packageRoot: pkgRoot })).toThrow(/synlin checkout/);
    expect(() =>
      assertSafeInstallTarget(path.join(pkgRoot, 'library'), { homeDir: home, packageRoot: pkgRoot }),
    ).toThrow(/synlin checkout/);
    expect(() => assertSafeInstallTarget(project, { homeDir: home, packageRoot: pkgRoot })).not.toThrow();
  });
});

describe('assertInside', () => {
  it('allows children and rejects escapes', () => {
    const dir = tmp();
    expect(() => assertInside(dir, path.join(dir, 'child', 'file.md'))).not.toThrow();
    expect(() => assertInside(dir, dir)).not.toThrow();
    expect(() => assertInside(dir, path.join(dir, '..', 'sibling'))).toThrow(/outside of/);
    expect(() => assertInside(dir, '/etc/passwd')).toThrow(/outside of/);
  });
});
