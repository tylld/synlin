# synlin

Personal CLI for managing a library of AI coding-agent configuration items —
skills, agents, commands, rules, and config templates — and installing them
selectively into projects, for **Claude Code, Codex CLI, Cursor, and OpenCode**.

**The CLI ships no content.** Your library is your own directory (ideally its
own git repo), stored in canonical Claude Code format; per-tool converters
render items into each tool's native format at install time. synlin finds it
via `SYNLIN_LIBRARY` → `libraryRoot` in `~/.config/synlin/config.json` →
`~/.synlin/library`. Cross-machine sync is just `git push` / `git pull` of
your library repo.

## Install

```bash
npm install
npm run build
npm link        # makes the `synlin` command available globally

synlin library init ~/my-synlin-library --git   # bootstrap your personal library
```

## Usage

```bash
cd ~/code/my-new-project
synlin init                 # pick install targets + items interactively
```

| Command | What it does |
| --- | --- |
| `synlin init [--force]` | Target multiselect (fresh projects) + item picker; creates config dirs as needed |
| `synlin list [category] [--installed]` | Show the catalog; inside a project, annotates per-tool install status |
| `synlin add <items...> [--force] [--tool <t...>]` | Non-interactive install by name (`nodejs`) or qualified id (`skills/nodejs`) for every configured target |
| `synlin remove <items...> [--force] [--tool <t...>]` | Remove synlin-managed items; prunes empty dirs; refuses unmanaged files |
| `synlin update [items...] [--force] [--dry-run] [--tool <t...>]` | Refresh installed items from the library, per (item, tool) |
| `synlin targets [add\|remove <tools...>]` | Show or change which tools this project installs for |
| `synlin status [--global]` | Project health overview (targets, per-tool item status, AGENTS.md blocks); `--global` scans `~/` agent config and matches it against the library |
| `synlin setup [save\|add\|remove <name>]` | Save the current project's item set as a named setup, or apply one elsewhere in a single command; setups live in `<library>/setups/` and sync via git |
| `synlin library` | Browse and manage the library itself (view/delete items; `import` adds new ones); `library init [path] [--git]` bootstraps a new library |
| `synlin import <path> [--category] [--as] [--force]` | Copy an item from a project back into the library (reverse-converting non-Claude formats) |
| `synlin claude` / `synlin codex` | Launch an agent session with permission prompts disabled |

Ambiguous bare names (`design` is both a skill and a command) prompt a picker in
a terminal, or list the qualified ids in non-interactive contexts.

## Tool support matrix

| Category | claude | codex | cursor | opencode |
| --- | --- | --- | --- | --- |
| skills | `.claude/skills/<n>/` | `.codex/skills/<n>/` | `.cursor/skills/<n>/` | `.opencode/skills/<n>/` |
| agents | `.claude/agents/<n>.md` | — ¹ | `.cursor/agents/<n>.md` ² | `.opencode/agents/<n>.md` ³ |
| commands | `.claude/commands/<n>.md` | — ⁴ | `.cursor/commands/<n>.md` ⁵ | `.opencode/commands/<n>.md` |
| rules | `.claude/rules/<g>/<n>.md` | `AGENTS.md` block ⁶ | `.cursor/rules/<g>/<n>.mdc` ⁷ | `AGENTS.md` block ⁶ |
| templates | `.claude/<file>` | — | — | — |

1. Codex agents are TOML config without a place for the agent prompt body.
2. `tools`/`model` dropped; `readonly` synthesized when the tool set is read-only.
3. `mode: subagent` synthesized; `tools` CSV mapped to a `permission` object.
4. Codex custom prompts are user-level only and deprecated.
5. Frontmatter stripped — Cursor commands are plain markdown.
6. One marker-delimited block in the project-root `AGENTS.md`, shared by codex
   and opencode (removed only when the last referencing tool uninstalls it).
   synlin never touches content outside its own blocks.
7. `description`/`globs`/`alwaysApply` synthesized from the rule's frontmatter.

Unsupported (tool, category) pairs are skipped with the reason printed; an item
supported by none of the configured targets is an error.

Templates (`hooks.json`, `settings.local.json`) are **copy-if-absent**: once
installed they are locally owned and `synlin update` never touches them
(`--force` refreshes them explicitly).

## How state is tracked

Each project gets a `.synlin.json` manifest at the project root (version 2)
recording, per item and per tool, a content hash plus the installed output
locations. (Legacy `.claude/.synlin.json` v1 manifests migrate automatically.)
That enables, per (item, tool):

- **Local modification detection** — `update` skips items you edited and tells
  you to either `synlin import` the edits into the library or `--force` discard them.
- **Upstream change detection** — items changed in the library show as
  `update available` in `synlin list`.
- **Safe removal** — `remove` only deletes files synlin installed; every write
  stays inside the tool config dirs, the project-root `AGENTS.md`, and the manifest.

## Editing the library

Two equivalent workflows:

1. **Edit in place**: change files under `library/`, commit, then run
   `synlin update` in consuming projects.
2. **Import from a project**: iterate on an installed copy inside a real
   project, then `synlin import .claude/agents/foo.md` to push it back to the
   library (shows a file-level diff before overwriting), then commit here.
   Importing from converted formats reverse-converts where the conversion is
   clean: `.cursor/rules/*.mdc`, cursor/opencode commands and agents, and any
   tool's skills. AGENTS.md rule blocks are not importable — edit the library
   rule instead.

## Development

```bash
npm run dev -- list      # run from source (tsx)
npm test                 # vitest suite
npm run typecheck
npm run build
```

`npm run seed` is a one-time personal migration script that populated the
original library from existing `.claude/` directories (it refuses to overwrite
a non-empty library without `--force`). New users don't need it — start with
`synlin library init` and `synlin import`.
