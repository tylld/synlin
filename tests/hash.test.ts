import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashTree, hashTreeIfExists, walkFiles } from '../src/lib/hash.js';
import { makeTmpDir, writeFileDeep } from './helpers/tmp.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tmp(): string {
  const { dir, cleanup } = makeTmpDir();
  cleanups.push(cleanup);
  return dir;
}

describe('walkFiles', () => {
  it('lists files sorted by relative path, excluding junk', () => {
    const dir = tmp();
    writeFileDeep(path.join(dir, 'item', 'b.md'), 'b');
    writeFileDeep(path.join(dir, 'item', 'a', 'nested.md'), 'n');
    writeFileDeep(path.join(dir, 'item', '.DS_Store'), 'junk');
    writeFileDeep(path.join(dir, 'item', '__pycache__', 'x.pyc'), 'junk');
    writeFileDeep(path.join(dir, 'item', 'scripts', 'tool.pyc'), 'junk');
    expect(walkFiles(path.join(dir, 'item'))).toEqual(['a/nested.md', 'b.md']);
  });

  it('returns the basename for a single file', () => {
    const dir = tmp();
    writeFileDeep(path.join(dir, 'agent.md'), 'content');
    expect(walkFiles(path.join(dir, 'agent.md'))).toEqual(['agent.md']);
  });

  it('throws a clear error for missing paths', () => {
    expect(() => walkFiles(path.join(tmp(), 'nope'))).toThrow(/does not exist/);
  });
});

describe('hashTree', () => {
  it('is deterministic and junk-insensitive', () => {
    const dirA = tmp();
    const dirB = tmp();
    writeFileDeep(path.join(dirA, 'item', 'SKILL.md'), 'same');
    writeFileDeep(path.join(dirA, 'item', 'data', 'd.md'), 'data');
    writeFileDeep(path.join(dirB, 'item', 'SKILL.md'), 'same');
    writeFileDeep(path.join(dirB, 'item', 'data', 'd.md'), 'data');
    writeFileDeep(path.join(dirB, 'item', '.DS_Store'), 'junk');
    expect(hashTree(path.join(dirA, 'item'))).toBe(hashTree(path.join(dirB, 'item')));
  });

  it('changes when content changes', () => {
    const dir = tmp();
    writeFileDeep(path.join(dir, 'item', 'SKILL.md'), 'v1');
    const before = hashTree(path.join(dir, 'item'));
    fs.writeFileSync(path.join(dir, 'item', 'SKILL.md'), 'v2');
    expect(hashTree(path.join(dir, 'item'))).not.toBe(before);
  });

  it('changes when a file is renamed even with identical content', () => {
    const dir = tmp();
    writeFileDeep(path.join(dir, 'item', 'a.md'), 'same');
    const before = hashTree(path.join(dir, 'item'));
    fs.renameSync(path.join(dir, 'item', 'a.md'), path.join(dir, 'item', 'b.md'));
    expect(hashTree(path.join(dir, 'item'))).not.toBe(before);
  });

  it('hashes single files by basename so library and installed copies match', () => {
    const dir = tmp();
    writeFileDeep(path.join(dir, 'library', 'agents', 'reviewer.md'), 'agent body');
    writeFileDeep(path.join(dir, 'project', '.claude', 'agents', 'reviewer.md'), 'agent body');
    expect(hashTree(path.join(dir, 'library', 'agents', 'reviewer.md'))).toBe(
      hashTree(path.join(dir, 'project', '.claude', 'agents', 'reviewer.md')),
    );
  });

  it('hashTreeIfExists returns null for missing paths', () => {
    expect(hashTreeIfExists(path.join(tmp(), 'missing'))).toBeNull();
  });
});
