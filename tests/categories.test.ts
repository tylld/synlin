import { describe, expect, it } from 'vitest';
import {
  isCategory,
  isDirectoryCategory,
  isJunkDir,
  isJunkFile,
  isValidItemName,
  itemId,
  libraryRelativePath,
  parseItemId,
} from '../src/lib/categories.js';
import { claudeProjectRelativePath as projectRelativePath } from '../src/lib/tools/claude.js';

describe('parseItemId', () => {
  it('parses qualified ids', () => {
    expect(parseItemId('skills/nodejs')).toEqual({ category: 'skills', name: 'nodejs' });
    expect(parseItemId('rules/common/coding-style')).toEqual({ category: 'rules', name: 'common/coding-style' });
    expect(parseItemId('templates/hooks.json')).toEqual({ category: 'templates', name: 'hooks.json' });
  });

  it('rejects bare names, bad categories and traversal attempts', () => {
    expect(parseItemId('nodejs')).toBeNull();
    expect(parseItemId('gadgets/nodejs')).toBeNull();
    expect(parseItemId('skills/')).toBeNull();
    expect(parseItemId('skills/../etc')).toBeNull();
    expect(parseItemId('agents/foo/bar')).toBeNull();
    expect(parseItemId('rules/a/b/c')).toBeNull();
  });
});

describe('isValidItemName', () => {
  it('accepts realistic names', () => {
    expect(isValidItemName('skills', 'ui-ux-pro-max')).toBe(true);
    expect(isValidItemName('templates', 'settings.local.json')).toBe(true);
    expect(isValidItemName('rules', 'common/coding-style')).toBe(true);
    expect(isValidItemName('rules', 'logging-standards')).toBe(true);
  });

  it('rejects traversal and malformed names', () => {
    expect(isValidItemName('skills', '../evil')).toBe(false);
    expect(isValidItemName('skills', 'a..b')).toBe(false);
    expect(isValidItemName('agents', 'a/b')).toBe(false);
    expect(isValidItemName('skills', '')).toBe(false);
    expect(isValidItemName('skills', '.hidden')).toBe(false);
    expect(isValidItemName('skills', 'UPPER')).toBe(false);
  });
});

describe('path mapping', () => {
  it('maps library and project paths per category', () => {
    expect(libraryRelativePath({ category: 'skills', name: 'nodejs' })).toBe('skills/nodejs');
    expect(libraryRelativePath({ category: 'agents', name: 'tech-lead' })).toBe('agents/tech-lead.md');
    expect(libraryRelativePath({ category: 'rules', name: 'common/testing' })).toBe('rules/common/testing.md');
    expect(libraryRelativePath({ category: 'templates', name: 'hooks.json' })).toBe('templates/hooks.json');

    expect(projectRelativePath({ category: 'skills', name: 'nodejs' })).toBe('.claude/skills/nodejs');
    expect(projectRelativePath({ category: 'commands', name: 'spec' })).toBe('.claude/commands/spec.md');
    expect(projectRelativePath({ category: 'rules', name: 'common/testing' })).toBe('.claude/rules/common/testing.md');
    expect(projectRelativePath({ category: 'templates', name: 'hooks.json' })).toBe('.claude/hooks.json');
  });

  it('throws on invalid refs', () => {
    expect(() => libraryRelativePath({ category: 'agents', name: '../escape' })).toThrow(/Invalid item name/);
  });
});

describe('junk filters and misc', () => {
  it('identifies junk', () => {
    expect(isJunkFile('.DS_Store')).toBe(true);
    expect(isJunkFile('module.pyc')).toBe(true);
    expect(isJunkFile('SKILL.md')).toBe(false);
    expect(isJunkDir('__pycache__')).toBe(true);
    expect(isJunkDir('data')).toBe(false);
  });

  it('category helpers', () => {
    expect(isCategory('skills')).toBe(true);
    expect(isCategory('gadgets')).toBe(false);
    expect(isDirectoryCategory('skills')).toBe(true);
    expect(isDirectoryCategory('agents')).toBe(false);
    expect(itemId({ category: 'rules', name: 'common/testing' })).toBe('rules/common/testing');
  });
});
