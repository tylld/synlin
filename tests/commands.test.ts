import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { addCommand } from '../src/commands/add.js';
import type { Runtime } from '../src/commands/context.js';
import { importCommand, inferImport } from '../src/commands/import.js';
import { buildPickerOptions } from '../src/commands/init.js';
import { listCommand } from '../src/commands/list.js';
import { removeCommand } from '../src/commands/remove.js';
import { updateCommand } from '../src/commands/update.js';
import { scanLibrary } from '../src/lib/library.js';
import { readManifest } from '../src/lib/manifest.js';
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
    libraryRoot,
    projectRoot,
    runtime: { cwd: projectRoot, env: { SYNLIN_LIBRARY: libraryRoot }, interactive: false },
  };
}

describe('buildPickerOptions', () => {
  it('groups items by category with rules split per group', () => {
    const fx = fixture();
    const { items } = scanLibrary(fx.libraryRoot);
    const groups = buildPickerOptions(items);
    expect(Object.keys(groups).sort()).toEqual(['agents', 'commands', 'rules/common', 'rules/typescript', 'skills', 'templates']);
    expect(groups['rules/common']?.map((option) => option.label)).toEqual(['coding-style']);
    expect(groups['rules/common']?.map((option) => option.value)).toEqual(['rules/common/coding-style']);
    expect(groups['skills']?.find((option) => option.value === 'skills/nodejs')?.hint).toBe('Node.js backend patterns');
  });
});

describe('addCommand', () => {
  it('installs resolved items and writes the manifest', async () => {
    const fx = fixture();
    await addCommand(['nodejs', 'agents/code-reviewer', 'common/coding-style'], {}, fx.runtime);

    expect(fs.existsSync(path.join(fx.projectRoot, '.claude', 'skills', 'nodejs', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(fx.projectRoot, '.claude', 'agents', 'code-reviewer.md'))).toBe(true);
    expect(fs.existsSync(path.join(fx.projectRoot, '.claude', 'rules', 'common', 'coding-style.md'))).toBe(true);
    expect(Object.keys(readManifest(fx.projectRoot).items).sort()).toEqual([
      'agents/code-reviewer',
      'rules/common/coding-style',
      'skills/nodejs',
    ]);
  });

  it('fails with qualified ids for ambiguous names in non-interactive mode', async () => {
    const fx = fixture();
    await expect(addCommand(['design'], {}, fx.runtime)).rejects.toThrow(/commands\/design.*skills\/design|skills\/design.*commands\/design/);
  });

  it('fails with suggestions for unknown names but still installs the rest', async () => {
    const fx = fixture();
    await expect(addCommand(['nodjs', 'agents/tech-lead'], {}, fx.runtime)).rejects.toThrow(/Did you mean.*skills\/nodejs/);
    expect(fs.existsSync(path.join(fx.projectRoot, '.claude', 'agents', 'tech-lead.md'))).toBe(true);
  });

  it('refuses to run outside a project in non-interactive mode', async () => {
    const fx = fixture();
    const outside = path.join(path.dirname(fx.projectRoot), 'elsewhere');
    fs.mkdirSync(outside, { recursive: true });
    await expect(addCommand(['nodejs'], {}, { ...fx.runtime, cwd: outside })).rejects.toThrow(/No \.claude directory/);
  });
});

describe('removeCommand', () => {
  it('removes managed items and refuses unmanaged ones', async () => {
    const fx = fixture();
    await addCommand(['nodejs'], {}, fx.runtime);
    await removeCommand(['nodejs'], {}, fx.runtime);
    expect(fs.existsSync(path.join(fx.projectRoot, '.claude', 'skills', 'nodejs'))).toBe(false);
    expect(readManifest(fx.projectRoot).items).toEqual({});

    writeFileDeep(path.join(fx.projectRoot, '.claude', 'agents', 'handmade.md'), 'mine');
    await expect(removeCommand(['handmade'], {}, fx.runtime)).rejects.toThrow(/not synlin-managed/);
    expect(fs.existsSync(path.join(fx.projectRoot, '.claude', 'agents', 'handmade.md'))).toBe(true);
  });

  it('requires --force for locally modified items in non-interactive mode', async () => {
    const fx = fixture();
    await addCommand(['agents/tech-lead'], {}, fx.runtime);
    const installed = path.join(fx.projectRoot, '.claude', 'agents', 'tech-lead.md');
    fs.writeFileSync(installed, 'local edits');

    await expect(removeCommand(['tech-lead'], {}, fx.runtime)).rejects.toThrow(/locally modified/);
    expect(fs.existsSync(installed)).toBe(true);

    await removeCommand(['tech-lead'], { force: true }, fx.runtime);
    expect(fs.existsSync(installed)).toBe(false);
  });
});

describe('updateCommand', () => {
  it('refreshes changed items, protects modified ones, honors --dry-run', async () => {
    const fx = fixture();
    await addCommand(['nodejs', 'agents/tech-lead'], {}, fx.runtime);

    fs.writeFileSync(path.join(fx.libraryRoot, 'skills', 'nodejs', 'SKILL.md'), 'library v2');
    const installedAgent = path.join(fx.projectRoot, '.claude', 'agents', 'tech-lead.md');
    fs.writeFileSync(installedAgent, 'local agent edits');

    await updateCommand([], { dryRun: true }, fx.runtime);
    expect(fs.readFileSync(path.join(fx.projectRoot, '.claude', 'skills', 'nodejs', 'SKILL.md'), 'utf8')).not.toBe('library v2');

    await updateCommand([], {}, fx.runtime);
    expect(fs.readFileSync(path.join(fx.projectRoot, '.claude', 'skills', 'nodejs', 'SKILL.md'), 'utf8')).toBe('library v2');
    expect(fs.readFileSync(installedAgent, 'utf8')).toBe('local agent edits');

    await updateCommand(['agents/tech-lead'], { force: true }, fx.runtime);
    expect(fs.readFileSync(installedAgent, 'utf8')).toContain('Tech lead');
  });

  it('rejects names that are not installed', async () => {
    const fx = fixture();
    await addCommand(['nodejs'], {}, fx.runtime);
    await expect(updateCommand(['tech-lead'], {}, fx.runtime)).rejects.toThrow(/not installed/);
  });
});

describe('listCommand', () => {
  it('lists the catalog and validates category filters', async () => {
    const fx = fixture();
    await expect(listCommand({}, fx.runtime)).resolves.toBeUndefined();
    await expect(listCommand({ category: 'gadgets' }, fx.runtime)).rejects.toThrow(/Unknown category/);
  });

  it('requires a project for --installed', async () => {
    const fx = fixture();
    const outside = path.join(path.dirname(fx.projectRoot), 'nowhere');
    fs.mkdirSync(outside, { recursive: true });
    await expect(listCommand({ installed: true }, { ...fx.runtime, cwd: outside })).rejects.toThrow(/Not inside a project/);
  });
});

describe('inferImport', () => {
  it('infers categories, skill roots, rule groups and templates', () => {
    expect(inferImport('/p/.claude/skills/nodejs')).toEqual({
      ref: { category: 'skills', name: 'nodejs' },
      itemRoot: '/p/.claude/skills/nodejs',
      tool: 'claude',
    });
    expect(inferImport('/p/.claude/skills/nodejs/SKILL.md')?.itemRoot).toBe('/p/.claude/skills/nodejs');
    expect(inferImport('/p/.claude/agents/cto.md')?.ref).toEqual({ category: 'agents', name: 'cto' });
    expect(inferImport('/p/.claude/rules/common/testing.md')?.ref).toEqual({ category: 'rules', name: 'common/testing' });
    expect(inferImport('/p/.claude/rules/logging-standards.md')?.ref).toEqual({ category: 'rules', name: 'logging-standards' });
    expect(inferImport('/p/.claude/hooks.json')?.ref).toEqual({ category: 'templates', name: 'hooks.json' });
    expect(inferImport('/p/elsewhere/file.md')).toBeNull();
  });

  it('infers items from other tools, with reverse transforms for converted formats', () => {
    const codexSkill = inferImport('/p/.codex/skills/nodejs/SKILL.md');
    expect(codexSkill?.ref).toEqual({ category: 'skills', name: 'nodejs' });
    expect(codexSkill?.tool).toBe('codex');
    expect(codexSkill?.transform).toBeUndefined();

    const mdc = inferImport('/p/.cursor/rules/common/style.mdc');
    expect(mdc?.ref).toEqual({ category: 'rules', name: 'common/style' });
    expect(mdc?.transform).toBeDefined();
    const rule = mdc?.transform?.('---\ndescription: X\nglobs: "**/*.ts,**/*.tsx"\nalwaysApply: false\n---\n# Style\n\nBody.\n');
    expect(rule).toContain('paths:');
    expect(rule).toContain('  - "**/*.ts"');
    expect(rule).not.toContain('globs:');
    expect(rule).not.toContain('alwaysApply');

    const opencodeAgent = inferImport('/p/.opencode/agents/reviewer.md');
    expect(opencodeAgent?.transform).toBeDefined();
    const agent = opencodeAgent?.transform?.(
      '---\ndescription: Reviews\nmode: subagent\npermission:\n  read: allow\n  bash: allow\n  edit: deny\n---\n# Reviewer\n',
    );
    expect(agent).toContain('tools:');
    expect(agent).toContain('Read, Bash');
    expect(agent).not.toContain('mode:');
    expect(agent).not.toContain('permission:');

    // Codex agents are TOML-registered — nothing importable.
    expect(inferImport('/p/.codex/agents/foo.md')).toBeNull();
  });
});

describe('importCommand', () => {
  it('imports a new agent into the library and syncs the source manifest', async () => {
    const fx = fixture();
    await addCommand(['agents/tech-lead'], {}, fx.runtime);
    const newAgent = path.join(fx.projectRoot, '.claude', 'agents', 'cto.md');
    writeFileDeep(newAgent, '---\nname: cto\ndescription: Chief technical officer\n---\n# CTO\n');

    await importCommand(newAgent, {}, fx.runtime);

    expect(fs.readFileSync(path.join(fx.libraryRoot, 'agents', 'cto.md'), 'utf8')).toContain('# CTO');
    expect(readManifest(fx.projectRoot).items['agents/cto']).toBeDefined();
  });

  it('requires --force to overwrite a differing library item in non-interactive mode', async () => {
    const fx = fixture();
    await addCommand(['agents/tech-lead'], {}, fx.runtime);
    const installed = path.join(fx.projectRoot, '.claude', 'agents', 'tech-lead.md');
    fs.writeFileSync(installed, '---\nname: tech-lead\ndescription: improved\n---\n# Tech lead v2\n');

    await expect(importCommand(installed, {}, fx.runtime)).rejects.toThrow(/--force/);

    await importCommand(installed, { force: true }, fx.runtime);
    expect(fs.readFileSync(path.join(fx.libraryRoot, 'agents', 'tech-lead.md'), 'utf8')).toContain('Tech lead v2');
    const entry = readManifest(fx.projectRoot).items['agents/tech-lead'];
    expect(entry).toBeDefined();

    await updateCommand([], {}, fx.runtime);
    expect(fs.readFileSync(installed, 'utf8')).toContain('Tech lead v2');
  });

  it('rejects sources it cannot categorize without --category', async () => {
    const fx = fixture();
    const loose = path.join(path.dirname(fx.projectRoot), 'loose.md');
    fs.writeFileSync(loose, '# Loose rule\n');
    await expect(importCommand(loose, {}, fx.runtime)).rejects.toThrow(/--category/);

    await importCommand(loose, { category: 'rules', as: 'pipeline/loose' }, fx.runtime);
    expect(fs.existsSync(path.join(fx.libraryRoot, 'rules', 'pipeline', 'loose.md'))).toBe(true);
  });
});
