/**
 * One-time library seed from the user's existing Claude Code configuration.
 *
 * Sources:
 *  - lead-pipeline/.claude  → skills, agents, one pipeline rule, templates
 *  - ~/.claude              → commands, rules (common/, typescript/)
 *
 * Idempotent: refuses to overwrite a non-empty library/ without --force.
 * Prints a seed report (counts, skips with reasons, template pruning notes).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyPath } from '../src/lib/copy.js';
import { scanLibrary } from '../src/lib/library.js';
import { resolveLibraryRoot } from '../src/lib/paths.js';

const LEAD_PIPELINE_CLAUDE = '/Users/andrei/Documents/ai-playground/custify/lead-pipeline/.claude';
const GLOBAL_CLAUDE = path.join(os.homedir(), '.claude');
const DASHBOARD_HOOK_MARKER = 'localhost:3117';

/** Global agents intentionally not seeded — all contain hardcoded EdgeFrame platform text. */
const SKIPPED_GLOBAL_AGENTS: Readonly<Record<string, string>> = {
  'code-reviewer': 'EdgeFrame-specific; generic lead-pipeline code-reviewer seeded instead',
  'git-master': 'EdgeFrame-specific; generic lead-pipeline git-master seeded instead',
  'security-expert': 'EdgeFrame-specific; generic lead-pipeline security-expert seeded instead',
  'tech-lead': 'EdgeFrame-specific; generic lead-pipeline tech-lead seeded instead',
  'developer': 'EdgeFrame-specific; closest generic equivalent: software-developer',
  'doc-writer': 'EdgeFrame-specific; closest generic equivalent: technical-writer',
  'tester': 'EdgeFrame-specific; closest generic equivalent: qa-engineer',
  'ui-ux-designer': 'EdgeFrame-specific; closest generic equivalent: ux-ui-expert',
  'product-spec': 'EdgeFrame-specific; closest generic equivalents: product-manager / product-owner',
};

interface SeedCounts {
  readonly [category: string]: number;
}

function main(): void {
  const force = process.argv.includes('--force');
  const libraryRoot = resolveLibraryRoot(process.env);
  assertEmptyOrForced(libraryRoot, force);

  const counts: SeedCounts = {
    skills: seedSkills(libraryRoot),
    agents: seedAgents(libraryRoot),
    commands: seedCommands(libraryRoot),
    rules: seedRules(libraryRoot),
    templates: seedTemplates(libraryRoot),
  };
  report(libraryRoot, counts);
}

function assertEmptyOrForced(libraryRoot: string, force: boolean): void {
  if (!fs.existsSync(libraryRoot)) return;
  const entries = fs.readdirSync(libraryRoot).filter((name) => name !== '.DS_Store');
  if (entries.length > 0 && !force) {
    console.error(`library/ already contains ${entries.length} entries. Re-run with --force to overwrite.`);
    process.exit(2);
  }
  if (force) {
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  }
}

function listMarkdown(dir: string): readonly string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort();
}

const flattenedCollections: string[] = [];

/**
 * Seed skills. Directories with a SKILL.md are copied as-is. Directories
 * WITHOUT one (angular/, expo/) are collections of sub-skills — Claude Code
 * only discovers .claude/skills/<name>/SKILL.md one level deep, so each
 * sub-skill is flattened into an individual library skill.
 */
function seedSkills(libraryRoot: string): number {
  const sourceDir = path.join(LEAD_PIPELINE_CLAUDE, 'skills');
  let count = 0;
  for (const name of listDirs(sourceDir)) {
    if (fs.existsSync(path.join(sourceDir, name, 'SKILL.md'))) {
      copyPath(path.join(sourceDir, name), path.join(libraryRoot, 'skills', name));
      count += 1;
      continue;
    }
    const subSkills = listDirs(path.join(sourceDir, name)).filter((sub) =>
      fs.existsSync(path.join(sourceDir, name, sub, 'SKILL.md')),
    );
    for (const sub of subSkills) {
      copyPath(path.join(sourceDir, name, sub), path.join(libraryRoot, 'skills', sub));
      count += 1;
    }
    flattenedCollections.push(`${name} → ${subSkills.length} individual skills (${subSkills.join(', ')})`);
  }
  return count;
}

function listDirs(dir: string): readonly string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function seedAgents(libraryRoot: string): number {
  const files = listMarkdown(path.join(LEAD_PIPELINE_CLAUDE, 'agents'));
  for (const file of files) {
    copyPath(path.join(LEAD_PIPELINE_CLAUDE, 'agents', file), path.join(libraryRoot, 'agents', file));
  }
  return files.length;
}

function seedCommands(libraryRoot: string): number {
  const files = listMarkdown(path.join(GLOBAL_CLAUDE, 'commands'));
  for (const file of files) {
    copyPath(path.join(GLOBAL_CLAUDE, 'commands', file), path.join(libraryRoot, 'commands', file));
  }
  return files.length;
}

function seedRules(libraryRoot: string): number {
  let count = 0;
  for (const group of ['common', 'typescript'] as const) {
    for (const file of listMarkdown(path.join(GLOBAL_CLAUDE, 'rules', group))) {
      copyPath(path.join(GLOBAL_CLAUDE, 'rules', group, file), path.join(libraryRoot, 'rules', group, file));
      count += 1;
    }
  }
  // Documents the worklog/ run format that the seeded pipeline skills read and write.
  const loggingStandards = path.join(LEAD_PIPELINE_CLAUDE, 'rules', 'logging-standards.md');
  if (fs.existsSync(loggingStandards)) {
    copyPath(loggingStandards, path.join(libraryRoot, 'rules', 'pipeline', 'logging-standards.md'));
    count += 1;
  }
  return count;
}

function seedTemplates(libraryRoot: string): number {
  const prunedHooks = pruneDashboardHooks(path.join(LEAD_PIPELINE_CLAUDE, 'hooks.json'));
  fs.mkdirSync(path.join(libraryRoot, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(libraryRoot, 'templates', 'hooks.json'), prunedHooks);
  copyPath(path.join(LEAD_PIPELINE_CLAUDE, 'settings.local.json'), path.join(libraryRoot, 'templates', 'settings.local.json'));
  return 2;
}

interface HookCommand {
  readonly type: string;
  readonly command: string;
}
interface HookMatcherGroup {
  readonly matcher?: string;
  readonly hooks: readonly HookCommand[];
}

/**
 * Drop hooks that POST to the lead-pipeline dashboard (localhost:3117) —
 * they are project infrastructure, not a reusable template. The generic
 * guards (rm -rf block, push-to-main block) and worklog echoes stay.
 */
function pruneDashboardHooks(hooksJsonPath: string): string {
  const parsed = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8')) as {
    hooks: Record<string, readonly HookMatcherGroup[]>;
  };
  const prunedEvents: Record<string, readonly HookMatcherGroup[]> = {};
  for (const [event, groups] of Object.entries(parsed.hooks)) {
    const prunedGroups = groups
      .map((group) => ({
        ...group,
        hooks: group.hooks.filter((hook) => !hook.command.includes(DASHBOARD_HOOK_MARKER)),
      }))
      .filter((group) => group.hooks.length > 0);
    if (prunedGroups.length > 0) {
      prunedEvents[event] = prunedGroups;
    }
  }
  return `${JSON.stringify({ hooks: prunedEvents }, null, 2)}\n`;
}

function report(libraryRoot: string, counts: SeedCounts): void {
  console.log('Seed complete.\n');
  console.log('Imported:');
  for (const [category, count] of Object.entries(counts)) {
    console.log(`  ${category.padEnd(10)} ${count}`);
  }

  console.log(`\nSkipped (${Object.keys(SKIPPED_GLOBAL_AGENTS).length}) from ~/.claude/agents:`);
  for (const [name, reason] of Object.entries(SKIPPED_GLOBAL_AGENTS)) {
    console.log(`  ${name.padEnd(16)} ${reason}`);
  }
  console.log('  (also skipped: ~/.claude/skills/learned — empty, no SKILL.md; ~/.claude/CLAUDE.md — EdgeFrame-specific)');

  if (flattenedCollections.length > 0) {
    console.log('\nFlattened skill collections (Claude Code only discovers skills one level deep):');
    for (const note of flattenedCollections) {
      console.log(`  ${note}`);
    }
  }

  console.log('\nTemplate notes:');
  console.log(`  hooks.json — pruned ${DASHBOARD_HOOK_MARKER} dashboard hooks; kept rm-rf guard, push-to-main guard, worklog echoes`);
  console.log('  settings.local.json — env + permissions baseline copied as-is');

  const { items, warnings } = scanLibrary(libraryRoot);
  console.log(`\nLibrary integrity: ${items.length} items scanned, ${warnings.length} warnings`);
  for (const warning of warnings) {
    console.log(`  warning: ${warning}`);
  }
  console.log(`\nReview and commit:\n  git -C ${libraryRoot} add -A && git -C ${libraryRoot} status`);
}

main();
