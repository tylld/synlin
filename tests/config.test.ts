import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/commands/context.js';
import { initLibrary } from '../src/commands/library.js';
import { configPath, defaultLibraryRoot, readConfig, writeConfig } from '../src/lib/config.js';
import { findLibraryRoot, resolveLibraryRoot } from '../src/lib/paths.js';
import { makeTmpDir } from './helpers/tmp.js';

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

function tmp(): string {
  const { dir, cleanup } = makeTmpDir();
  cleanups.push(cleanup);
  return dir;
}

describe('config', () => {
  it('round-trips and validates', () => {
    const home = tmp();
    expect(readConfig(home)).toEqual({});
    writeConfig({ libraryRoot: '/somewhere/library' }, home);
    expect(readConfig(home)).toEqual({ libraryRoot: '/somewhere/library' });

    fs.writeFileSync(configPath(home), '{ nope');
    expect(() => readConfig(home)).toThrow(/Corrupt config/);
    fs.writeFileSync(configPath(home), JSON.stringify({ libraryRoot: 42 }));
    expect(() => readConfig(home)).toThrow(/must be a string path/);
  });
});

describe('resolveLibraryRoot precedence', () => {
  it('env override > config > ~/.synlin/library default', () => {
    const home = tmp();
    expect(resolveLibraryRoot({}, home)).toBe(defaultLibraryRoot(home));

    writeConfig({ libraryRoot: path.join(home, 'my-lib') }, home);
    expect(resolveLibraryRoot({}, home)).toBe(path.join(home, 'my-lib'));

    expect(resolveLibraryRoot({ SYNLIN_LIBRARY: path.join(home, 'override') }, home)).toBe(path.join(home, 'override'));
  });

  it('findLibraryRoot guides to "library init" when nothing exists', () => {
    const home = tmp();
    expect(() => findLibraryRoot({}, home)).toThrow(/synlin library init/);
  });
});

describe('library init', () => {
  function runtime(cwd: string): Runtime {
    return { cwd, env: {}, interactive: false };
  }

  it('creates the category skeleton and saves the location to config', () => {
    const home = tmp();
    const target = path.join(home, 'repos', 'my-library');
    initLibrary(target, {}, runtime(home), home);

    for (const dir of ['skills', 'agents', 'commands', 'rules', 'templates']) {
      expect(fs.statSync(path.join(target, dir)).isDirectory()).toBe(true);
    }
    expect(fs.existsSync(path.join(target, 'README.md'))).toBe(true);
    expect(readConfig(home)).toEqual({ libraryRoot: target });
    expect(findLibraryRoot({}, home)).toBe(target);
  });

  it('defaults to ~/.synlin/library without writing config', () => {
    const home = tmp();
    initLibrary(undefined, {}, runtime(home), home);
    expect(fs.statSync(path.join(defaultLibraryRoot(home), 'skills')).isDirectory()).toBe(true);
    expect(readConfig(home)).toEqual({});
  });

  it('refuses to re-init an existing library', () => {
    const home = tmp();
    const target = path.join(home, 'lib');
    initLibrary(target, {}, runtime(home), home);
    expect(() => initLibrary(target, {}, runtime(home), home)).toThrow(/already looks like a synlin library/);
  });
});
