import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Create a temp dir, removed automatically after the test via the returned cleanup. */
export function makeTmpDir(prefix = 'synlin-test-'): { readonly dir: string; readonly cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Write a file creating parent directories as needed. */
export function writeFileDeep(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

export interface FixtureLibraryOptions {
  readonly root: string;
}

/**
 * A small but representative library fixture:
 * - a skill (directory with SKILL.md + nested data file)
 * - two agents, one command
 * - a "design" skill AND "design" command (the real-world ambiguity case)
 * - rules in two groups with colliding bare names
 * - two templates
 */
export function makeFixtureLibrary(parentDir: string): string {
  const root = path.join(parentDir, 'library');
  writeFileDeep(
    path.join(root, 'skills', 'nodejs', 'SKILL.md'),
    '---\nname: nodejs\ndescription: Node.js backend patterns\n---\n# Node skill\n',
  );
  writeFileDeep(path.join(root, 'skills', 'nodejs', 'data', 'reference.md'), '# Reference data\n');
  writeFileDeep(
    path.join(root, 'skills', 'design', 'SKILL.md'),
    '---\nname: design\ndescription: Design pipeline skill\n---\n# Design skill\n',
  );
  writeFileDeep(
    path.join(root, 'agents', 'code-reviewer.md'),
    '---\nname: code-reviewer\ndescription: Reviews code\n---\n# Code reviewer\n',
  );
  writeFileDeep(
    path.join(root, 'agents', 'tech-lead.md'),
    '---\nname: tech-lead\ndescription: Plans implementations\n---\n# Tech lead\n',
  );
  writeFileDeep(
    path.join(root, 'commands', 'design.md'),
    '---\ndescription: Start a design session\n---\nRun a design session for $ARGUMENTS\n',
  );
  writeFileDeep(path.join(root, 'rules', 'common', 'coding-style.md'), '# Coding Style\n\nImmutability first.\n');
  writeFileDeep(path.join(root, 'rules', 'typescript', 'coding-style.md'), '# TS Coding Style\n\nStrict mode.\n');
  writeFileDeep(path.join(root, 'templates', 'hooks.json'), '{\n  "hooks": {}\n}\n');
  writeFileDeep(path.join(root, 'templates', 'settings.local.json'), '{\n  "permissions": {}\n}\n');
  return root;
}

/** A project dir with an empty .claude/ ready for installs. */
export function makeFixtureProject(parentDir: string): string {
  const root = path.join(parentDir, 'project');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  return root;
}
