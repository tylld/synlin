import { afterEach, describe, expect, it } from 'vitest';
import { scanLibrary } from '../src/lib/library.js';
import { resolveName } from '../src/lib/resolve.js';
import { makeFixtureLibrary, makeTmpDir } from './helpers/tmp.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fixtureItems() {
  const { dir, cleanup } = makeTmpDir();
  cleanups.push(cleanup);
  return scanLibrary(makeFixtureLibrary(dir)).items;
}

describe('resolveName', () => {
  it('resolves exact qualified ids', () => {
    const items = fixtureItems();
    const result = resolveName(items, 'skills/design');
    expect(result.kind).toBe('found');
    expect(result.matches.map((m) => m.id)).toEqual(['skills/design']);
  });

  it('resolves unique bare names', () => {
    const items = fixtureItems();
    const result = resolveName(items, 'nodejs');
    expect(result.kind).toBe('found');
    expect(result.matches.map((m) => m.id)).toEqual(['skills/nodejs']);
  });

  it('reports the real-world design ambiguity (skill + command)', () => {
    const items = fixtureItems();
    const result = resolveName(items, 'design');
    expect(result.kind).toBe('ambiguous');
    expect(result.matches.map((m) => m.id).sort()).toEqual(['commands/design', 'skills/design']);
  });

  it('reports rule-group ambiguity for colliding bare rule names', () => {
    const items = fixtureItems();
    const result = resolveName(items, 'coding-style');
    expect(result.kind).toBe('ambiguous');
    expect(result.matches.map((m) => m.id).sort()).toEqual([
      'rules/common/coding-style',
      'rules/typescript/coding-style',
    ]);
  });

  it('resolves grouped rules by their full bare name', () => {
    const items = fixtureItems();
    const result = resolveName(items, 'common/coding-style');
    expect(result.kind).toBe('found');
    expect(result.matches.map((m) => m.id)).toEqual(['rules/common/coding-style']);
  });

  it('suggests close matches for unknown names', () => {
    const items = fixtureItems();
    const result = resolveName(items, 'nodjs');
    expect(result.kind).toBe('unknown');
    expect(result.suggestions).toContain('skills/nodejs');

    const substring = resolveName(items, 'review');
    expect(substring.kind).toBe('unknown');
    expect(substring.suggestions).toContain('agents/code-reviewer');
  });

  it('works against manifest-style id lists', () => {
    const ids = [{ id: 'skills/gone-from-library' }, { id: 'rules/common/testing' }];
    expect(resolveName(ids, 'gone-from-library').kind).toBe('found');
    expect(resolveName(ids, 'testing').matches.map((m) => m.id)).toEqual(['rules/common/testing']);
  });
});
