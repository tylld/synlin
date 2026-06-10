# synlin — Claude Code Instructions

CLI that manages a personal library of Claude Code config items (skills, agents,
commands, rules, templates) and installs them into projects' `.claude/` dirs.

## Layout

- `src/lib/` — pure core: catalog scan, manifest, tree hashing, installer,
  name resolution, tool adapters. All side-effect-light and unit-tested.
- `src/commands/` — thin command handlers over `src/lib/`; interactive prompts
  (@clack/prompts) stay at this layer only.
- **The library is NOT in this repo.** It is the user's own directory, resolved
  via `SYNLIN_LIBRARY` → `libraryRoot` in `~/.config/synlin/config.json` →
  `~/.synlin/library` (see `resolveLibraryRoot`). `synlin library init`
  bootstraps a new one. Andrei's personal library lives in the separate
  private repo `~/Documents/ai-playground/synlin-library`.
- `scripts/seed.ts` — one-time initial import into the resolved library; do not
  re-run casually (it refuses unless the library is empty or `--force` is passed).

## Rules

- Never modify library content as a side effect of CLI code changes — the
  library is user data, wherever it lives.
- Every file write/delete in a target project must stay inside the project's
  *write envelope*: the tool config dirs (`.claude/`, `.codex/`, `.cursor/`,
  `.opencode/`), adapter-declared shared files at the project root (currently
  `AGENTS.md`), and `<projectRoot>/.synlin.json`. Owned-tree writes for tool T
  must additionally stay inside T's own config dir (see `assertWritable` /
  `assertInside` in `src/lib/paths.ts`); keep that guarantee when touching the
  installer or adapters.
- The manifest format (`<projectRoot>/.synlin.json`, version 2) is a
  compatibility contract — bump `MANIFEST_VERSION` and add migration on
  breaking changes. Version 1 (`.claude/.synlin.json`) is migrated in memory on
  read and persisted (legacy file deleted) on the next write.
- Tool adapters (`src/lib/tools/`) must render deterministically: pure
  functions of library item content — no clocks, env, or fs beyond the item.
- Tests run against tmp-dir fixtures (`tests/helpers/tmp.ts`); command handlers
  accept an injectable `Runtime` (`cwd`, `env`, `interactive`) — never depend on
  `process.cwd()` inside `src/lib/`.

## Verify changes

```bash
npm run typecheck && npm test && npm run build
```

For CLI behavior: `npm link` once, then exercise `synlin` in a scratch dir under
`/tmp` (set `SYNLIN_LIBRARY` to a fixture library to avoid touching the real one).
