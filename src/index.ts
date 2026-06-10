import { Command } from 'commander';
import pc from 'picocolors';
import { addCommand } from './commands/add.js';
import { importCommand } from './commands/import.js';
import { initCommand } from './commands/init.js';
import { LAUNCH_TARGETS, launchCommand } from './commands/launch.js';
import { listCommand } from './commands/list.js';
import { libraryCommand } from './commands/library.js';
import { removeCommand } from './commands/remove.js';
import { setupCommand } from './commands/setup.js';
import { statusCommand } from './commands/status.js';
import { targetsCommand } from './commands/targets.js';
import { updateCommand } from './commands/update.js';
import { isSynlinError } from './lib/errors.js';

const program = new Command();

program
  .name('synlin')
  .description('Manage a personal library of Claude Code config items and install them into projects')
  .version('0.1.0')
  .enablePositionalOptions();

program
  .command('init')
  .description('Interactively pick library items and install them into the current project')
  .option('-f, --force', 'overwrite existing unmanaged files and adopt them')
  .action(async (options: { force?: boolean }) => initCommand(options));

program
  .command('list')
  .description('Show the library catalog (with install status when inside a project)')
  .argument('[category]', 'filter by category: skills, agents, commands, rules, templates')
  .option('-i, --installed', 'show only items installed in the current project')
  .action(async (category: string | undefined, options: { installed?: boolean }) =>
    listCommand({ ...(category !== undefined ? { category } : {}), ...(options.installed === true ? { installed: true } : {}) }),
  );

program
  .command('add')
  .description('Install items by name (e.g. "synlin add nodejs skills/design rules/common/testing")')
  .argument('<items...>', 'item names or qualified ids')
  .option('-f, --force', 'overwrite existing unmanaged files / discard local modifications')
  .option('-t, --tool <tool...>', 'limit to specific configured targets (claude, codex, cursor, opencode)')
  .action(async (items: string[], options: { force?: boolean; tool?: string[] }) => addCommand(items, options));

program
  .command('remove')
  .description('Remove synlin-managed items from the current project')
  .argument('<items...>', 'item names or qualified ids')
  .option('-f, --force', 'remove even when locally modified')
  .option('-t, --tool <tool...>', 'limit to specific configured targets')
  .action(async (items: string[], options: { force?: boolean; tool?: string[] }) => removeCommand(items, options));

program
  .command('update')
  .description('Refresh installed items from the library')
  .argument('[items...]', 'item names or qualified ids (default: everything installed)')
  .option('-f, --force', 'overwrite local modifications and refresh templates')
  .option('-n, --dry-run', 'show what would change without writing')
  .option('-t, --tool <tool...>', 'limit to specific configured targets')
  .action(async (items: string[], options: { force?: boolean; dryRun?: boolean; tool?: string[] }) => updateCommand(items, options));

program
  .command('targets')
  .description('Show or change which tools this project installs for (claude, codex, cursor, opencode)')
  .argument('[action]', '"add" or "remove" (bare: show current targets)')
  .argument('[tools...]', 'tool ids')
  .option('--install', 'targets add: also install already-managed items for the new tools')
  .option('--keep-files', 'targets remove: drop manifest entries but keep files on disk')
  .option('-f, --force', 'skip confirmations')
  .action(async (action: string | undefined, tools: string[], options: { install?: boolean; keepFiles?: boolean; force?: boolean }) =>
    targetsCommand(action, tools, options),
  );

program
  .command('import')
  .description('Copy an item from a project into the library (the way library items get updated)')
  .argument('<path>', 'path to a skill directory, agent/command/rule .md file, or template file')
  .option('-c, --category <category>', 'category when it cannot be inferred from the path')
  .option('-a, --as <name>', 'name (or group/name for rules) to import as')
  .option('-f, --force', 'overwrite an existing differing library item without confirmation')
  .action(async (sourcePath: string, options: { category?: string; as?: string; force?: boolean }) =>
    importCommand(sourcePath, options),
  );

program
  .command('status')
  .description('Overview of the synlin setup in the current project (or globally with --global)')
  .option('-g, --global', 'show the global (~/) agent config overview instead')
  .action(async (options: { global?: boolean }) => statusCommand(options));

program
  .command('setup')
  .description('Save the current project\'s item set as a named setup, or apply one ("synlin setup add backend-node")')
  .argument('[action]', '"save", "add"/"apply", or "remove" (bare: list setups)')
  .argument('[name]', 'setup name')
  .option('-f, --force', 'overwrite existing setup / skip confirmations / force installs')
  .action(async (action: string | undefined, name: string | undefined, options: { force?: boolean }) =>
    setupCommand(action, name, options),
  );

program
  .command('library')
  .description('Browse and manage the library itself; "library init [path]" bootstraps a new one')
  .argument('[action]', '"init" to create a new library (bare: browse the current one)')
  .argument('[path]', 'where to create the library (default: configured or ~/.synlin/library)')
  .option('--git', 'library init: also run git init in the new library')
  .action(async (action: string | undefined, pathArg: string | undefined, options: { git?: boolean }) =>
    libraryCommand(action, pathArg, options),
  );

program
  .command('claude')
  .description('Launch a Claude Code session with --dangerously-skip-permissions')
  .argument('[args...]', 'extra arguments forwarded to claude')
  .passThroughOptions()
  .allowUnknownOption()
  .action(async (args: string[]) => {
    process.exitCode = await launchCommand(LAUNCH_TARGETS.claude, args);
  });

program
  .command('codex')
  .description('Launch a Codex session with --dangerously-bypass-approvals-and-sandbox')
  .argument('[args...]', 'extra arguments forwarded to codex')
  .passThroughOptions()
  .allowUnknownOption()
  .action(async (args: string[]) => {
    process.exitCode = await launchCommand(LAUNCH_TARGETS.codex, args);
  });

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  if (isSynlinError(error)) {
    if (error.message.length > 0) {
      console.error(error.exitCode === 0 ? error.message : pc.red(error.message));
    }
    process.exit(error.exitCode);
  }
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(pc.red(`synlin: unexpected error\n${message}`));
  process.exit(1);
});
