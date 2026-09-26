# taskflow

**A zero-dependency task management engine and CLI — priorities, tags, projects, natural-language due dates, recurring tasks, streaks, velocity stats and rich terminal reporting.**

![version](https://img.shields.io/badge/version-1.0.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%E2%89%A524.x-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-success)
![tests](https://img.shields.io/badge/tests-66%20passing-success)
![language](https://img.shields.io/badge/TypeScript-strict%20%2B%20type--stripping-3178c6)

---

## Overview

`taskflow` is a command-line task tracker for people who live in the terminal.
It stores your work as a single readable JSON file, understands due dates the
way you type them (`tomorrow`, `fri 3pm`, `+3d`, `in 2 weeks`, `jan 15`),
keeps recurring chores alive on their own, and answers the two questions that
matter — *what should I do now?* and *how am I actually doing?* — through a
schedule board, ASCII gantt/burndown charts and a stats engine with streaks
and weekly velocity.

Everything is implemented with the Node.js standard library only. There is no
`npm install` step, no build step, and no runtime beyond Node itself: the
TypeScript source runs directly through Node's native type stripping
(`erasableSyntaxOnly` — the code contains no enums, namespaces, decorators or
parameter properties, only erasable type annotations).

## Features

- **Natural-language due dates** — `today`, `tomorrow`, `eod`, weekdays
  (`fri`, `friday 3pm`), offsets (`+3d`, `-1w`, `+4h`), relative phrases
  (`in 2 weeks`, `5 days ago`), calendar dates (`2026-01-15`, `jan 20`,
  `15.01.2026`) and bare day-of-month with roll-forward.
- **Priorities, tags and projects** — `P0..P3` levels, up to 16 tags per task,
  project slugs, plus inline query tokens (`#tag`, `+project`, `p0..p3`,
  `is:done`, each negatable with `!`).
- **Recurring tasks** — `daily`, `weekly`, `biweekly`, `monthly`,
  `every 3 days`, … Completing a recurring task automatically spawns the next
  open occurrence so the cycle never drops.
- **Filtered, sorted, grouped lists** — combine flags freely, sort by due /
  priority / created / updated / completed / title / status, paginate with
  `--limit`/`--offset`, group by project, tag, status or priority.
- **Relevance-ranked search** — full-text across title, notes, tags and
  projects; title hits weigh 3, tag/project 2, notes 1.
- **Reporting** — completion streaks, weekly velocity sparkline, per-priority
  / per-project / per-tag breakdown tables, ASCII timeline (`gantt`) and
  trailing-window burndown chart.
- **Round-trip import/export** — CSV, JSON and Markdown (a checklist that
  reads back); merge, replace or dry-run imports.
- **Resilient storage** — atomic writes (temp file + `rename`), rotating
  `.bak.1..3` backups, corruption recovery with quarantine, and a `doctor`
  command that audits and optionally repairs the store.
- **Ergonomics** — short ids with unique prefixes, Levenshtein "did you mean"
  suggestions on typos, ANSI color that auto-disables when piped, detailed
  per-command help, consistent exit codes.

## Requirements

| Requirement | Detail |
| --- | --- |
| Runtime | Node.js ≥ 24.x (type stripping on by default); 22.6+ also works with `--experimental-strip-types` |
| npm scripts / `npm link` | npm ≥ 10 (optional — you can always call `node bin/taskflow.ts` directly) |
| Operating system | Linux, macOS, Windows (paths use `node:path`; colors need a terminal) |
| Disk | One JSON file, typically a few KB |
| Dependencies | **None** — zero npm packages at runtime, build time or test time |

## Installation

No packages to install — the repo *is* the program.

```bash
# clone / copy the project anywhere
cd taskflow

# run directly (works on Node ≥ 24 out of the box)
node bin/taskflow.ts --help

# or register a global `taskflow` command
npm link
taskflow --help
```

On Node 22.6–23.5 add the type-stripping flag (or alias it):

```bash
node --experimental-strip-types bin/taskflow.ts --help
alias taskflow='node --experimental-strip-types /path/to/taskflow/bin/taskflow.ts'
```

Verify the toolchain with the bundled test suite and the doctor:

```bash
npm test                 # 66 tests, all four suites
node bin/taskflow.ts doctor
```

## Quick Start

```bash
$ node bin/taskflow.ts add "Fix login redirect" -p P0 -t bug,api -j auth --due tomorrow
✓ Added Fix login redirect
  id: 01M3CY1HC5Y7A95WMPA5R1Z01Y (short: 01M3CY1HC5Y7)
  priority P0 · project +auth · tags #bug #api
  due tomorrow
  inspect: taskflow show 01M3CY1HC5Y7 · complete: taskflow done 01M3CY1HC5Y7

$ node bin/taskflow.ts add "Water the plants" -r weekly --due sunday -p P3
✓ Added Water the plants
  id: 01M3CY1J46Q6GCV8SF59Y7M6Q2 (short: 01M3CY1J46Q6)
  priority P3
  due sunday · repeats weekly
  inspect: taskflow show 01M3CY1J46Q6 · complete: taskflow done 01M3CY1J46Q6

$ node bin/taskflow.ts list
Tasks · open · sorted by due (asc) · 2 matches
  ID            •  PRI  DUE       TITLE               TAGS / PROJECT
  ────────────  ─  ───  ────────  ──────────────────  ──────────────
  01M3CY1HC5Y7  ○  P0   tomorrow  Fix login redirect  #bug #api +auth
  01M3CY1J46Q6  ○  P3   sunday    Water the plants    ↻

  shown 2 of 2 matched · open 2 · overdue 0 · completion 0.0%
  updated 2026-09-25T18:43 · data: ~/.taskflow

$ node bin/taskflow.ts done 01M3CY1J46Q6
✓ Done Water the plants 01M3CY1J46Q6
  ↻ next occurrence Water the plants due in 9d 01M3CY1XRDK2
· completed 1 task · 1 recurring occurrence spawned
```

That is the whole loop: **add → list → done**, with the recurring task
rescheduling itself.

## Usage

Every command accepts `-h/--help` (or `taskflow help <command>`) for flags,
examples and cross-references. Global flags come *before* the command:
`taskflow --data /tmp/box list --all`.

### Command reference

| Command | Aliases | What it does |
| --- | --- | --- |
| `add` | `a`, `new` | Create a task: title, `-p/--priority P0..P3`, `-t/--tag`, `-j/--project`, `--due`, `-r/--recurrence`, `--estimate`, `--notes`, `--status` |
| `list` | `ls`, `l` | List and filter tasks; flags, inline tokens and `--preset` names combine freely |
| `show` | — | Full detail view for one task (id or unique prefix) |
| `done` | `complete`, `x` | Complete one or more tasks (all-or-nothing); `--at` backfills the timestamp; recurring tasks spawn their next occurrence |
| `reopen` | `undo` | Send completed tasks back to todo and clear the completion stamp |
| `edit` | `e` | Change any field of an existing task; `none`/`clear` removes dates, tags, projects, recurrence or estimate |
| `rm` | `remove`, `delete` | Permanently delete tasks (rotating backups still hold the last states) |
| `search` | `s`, `find` | Relevance-ranked full-text search across title, notes, tags and projects |
| `stats` | — | Overview counters, streaks, weekly velocity sparkline, per-priority/project/tag tables; `--json` for machines |
| `schedule` | `today` | What needs attention now: overdue, due today, rest of week, next 7 days, recurring rules |
| `gantt` | `timeline` | ASCII timeline of the next days with due markers and due-load histogram |
| `burndown` | `burn` | ASCII burndown of the trailing window (ideal line vs actual remaining) |
| `export` | — | Write tasks to CSV, JSON or Markdown (stdout or `--out` file); all list filters supported |
| `import` | — | Load tasks from CSV, JSON or Markdown; `--replace`, `--replace-existing`, `--dry-run` |
| `projects` | `proj` | Per-project breakdown and management (`rename`, `drop`) |
| `tags` | `tag` | Tag vocabulary breakdown and management |
| `doctor` | — | Store health check with optional auto-repair |
| `help` | — | General help or `help <command>` |
| `version` | — | Print the version |

Exit codes: **0** success · **1** runtime error (task not found, store
unwritable, …) · **2** usage error (unknown flag, invalid value, ambiguous
prefix).

### Filters — flags and inline tokens

```
taskflow list -p P0,P1 -t bug --due week --sort priority --desc
taskflow list +backend #api            # inline project/tag tokens
taskflow list is:done                  # completed work
taskflow list "!#someday" --all        # negated token, every status
taskflow list --preset "urgent overdue"
taskflow list -g project --limit 10 --offset 20
taskflow stats +backend                # scope stats to one project
```

Presets: `open`, `todo`, `doing`, `done`, `today`, `tomorrow`, `week`,
`overdue`, `undated`, `urgent`, `p0`, `p1` — combinable
(`--preset "urgent done"`) and flag-pinnable.

### Concrete examples (real output)

Completion, with the recurring spawn:

```bash
$ taskflow done 01M3CY1HJ30N 01M3CY1HY6VY
✓ Done Write release notes 01M3CY1HJ30N
✓ Done Team retro agenda 01M3CY1HY6VY
· completed 2 tasks
```

Relevance-ranked search (notes hits included, `SCORE` column on the right):

```bash
$ taskflow search repro
Search · "repro" · 1 hit
  ID            •  PRI  TITLE               DUE    META             CONTEXT          SCORE
  ────────────  ─  ───  ──────────────────  ─────  ───────────────  ───────────────  ─────
  01M3CY1HC5Y7  ○  P1   Fix login redirect  —      #bug #api +auth  needs repro steps      1

  best: Fix login redirect (score 1) · haystack: fix login redirect  bug api auth  needs repro steps
```

Stats: streaks, velocity sparkline and breakdowns:

```bash
$ taskflow stats
Overview
  total 6 · open 3 · done 3 · in progress 0
  0 overdue · 0 due today · 2 due this week
  completion ████████████░░░░░░░░░░░░ 50% 3/6 (50%)
  avg time to complete 1m

Streak
  current 1 day · longest 1 · last completion 2026-09-25

Velocity (completions per week)
  ▁▁▁▁▁▁▁█  ↑ +1
  08-03: 08-10: 08-17: 08-24: 08-31: 09-07: 09-14: 09-21:
  0  0  0  0  0  0  0  1

By priority
  KEY  TOTAL  OPEN  LATE  DONE %  PROGRESS
  ───  ─────  ────  ────  ──────  ────────────
  P0       1     1     0    0.0%  ░░░░░░░░░░░░
  P1       1     0     0    100%  ████████████
  ...
```

Timeline and burndown:

```bash
$ taskflow gantt
Timeline 2026-09-25 → 2026-10-08 (14 days)
             Sep               Oct
             F  S  S  M  T  W  T  F  S  S  M  T  W  T
             25 26 27 28 29 30 1  2  3  4  5  6  7  8
01M3CY1HC5Y7 ░  ◆  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·   Fix login redirect
01M3CY1XRDK2 ░  ░  ░  ░  ░  ░  ░  ░  ░  ◆  ·  ·  ·  ·   Water the plants

legend: ░ span  ◆ due  ! overdue  ✔ done  · idle — rows capped at 24
```

Export → import round trip:

```bash
$ taskflow export -f markdown -o tasks.md
✓ Exported 6 tasks → tasks.md (markdown)

$ TASKFLOW_DATA=/tmp/fresh taskflow import tasks.md
Import · 1 file · 6 tasks parsed
  ✓ merged — 6 added · 0 updated · 0 skipped (existing kept)
```

Health check:

```bash
$ taskflow doctor
Doctor · ~/.taskflow
  ✓ store found (2853 bytes, 3 backups, schema v1)
  ✓ parsed 6 tasks (savedAt 2026-09-25T18:51)
  ✓ structure check passed — no duplicates, dangling references or inconsistent lifecycle states
  all systems nominal
```

## Configuration

`taskflow` needs no config file. Behavior is controlled by three layers:

| Layer | Meaning | Example |
| --- | --- | --- |
| `--data/-D <dir>` flag | Highest precedence; directory that holds `tasks.json` | `taskflow -D /tmp/box list --all` |
| `TASKFLOW_DATA` env var | Same, for shells/CI where flags are awkward | `export TASKFLOW_DATA=~/boxes/work` |
| `$HOME/.taskflow` | Default data directory | `~/.taskflow/tasks.json` |

Environment and terminal behavior:

- `NO_COLOR` (or piping output) disables ANSI styling; `--no-color` /
  `--color` force it per invocation.
- A special value of `-` for `--data` is not treated specially — use real
  paths.
- The store file is `tasks.json` (pretty-printed JSON, schema versioned).
  Next to it live `tasks.json.bak.1..3` (rotating backups) and, after a
  crash, `tasks.json.corrupt-<millis>` (quarantined original).
- Windows/POSIX both supported; writes are atomic within the data directory.

## Project Structure

Annotated tree — matches the repository files exactly (line counts as of
v1.0.0; ~9,000 lines of TypeScript overall):

```
taskflow/
├── LICENSE                      # MIT license
├── README.md                    # this file
├── package.json                 # name, bin entry, npm test script (zero deps)
├── tsconfig.json                # strict, noEmit, erasableSyntaxOnly, NodeNext
├── examples/                    # reserved for future sample scripts
├── bin/
│   └── taskflow.ts        259   # entry point: global flags, dispatch, help,
│                                #   CliError → exit-code translation, suggestions
├── src/
│   ├── args.ts            222   # dependency-free flag parser (long/short/bundled/
│   │                            #   inline values, -- terminator, positional words)
│   ├── burndown.ts        272   # trailing-window burndown data + ASCII chart
│   ├── dateparse.ts       655   # calendar primitives + natural-language due dates
│   │                            #   and recurrence vocabulary parsing
│   ├── gantt.ts           199   # timeline layout model + ASCII rendering
│   ├── id.ts              147   # ULID-style sortable ids + unique short prefixes
│   ├── query.ts           577   # filters, inline tokens, presets, matching, sorting,
│   │                            #   grouping, pagination, filter descriptions
│   ├── scheduler.ts       259   # "what needs attention now" board model
│   ├── serialize.ts       415   # CSV / JSON / Markdown round-trip codecs
│   ├── stats.ts           338   # overview, streaks, velocity, breakdown tables
│   ├── storage.ts         410   # data-dir resolution, atomic saves, rotating
│   │                            #   backups, corruption recovery, CRUD helpers
│   ├── task.ts            564   # domain model: create/edit/complete/reopen,
│   │                            #   recurrence arithmetic, urgency, sanitizing
│   ├── types.ts           420   # Task/Filter/etc. types, CliError, vocabularies
│   ├── commands/                # one thin module per command (parse + render)
│   │   ├── add.ts         104
│   │   ├── base.ts         68   # emit/emitError output helpers
│   │   ├── burndown.ts     60
│   │   ├── doctor.ts      222   # audit + optional auto-repair
│   │   ├── done.ts        110
│   │   ├── edit.ts        175
│   │   ├── export.ts      121
│   │   ├── gantt.ts        48
│   │   ├── import.ts      120
│   │   ├── list.ts        122
│   │   ├── projects.ts    137
│   │   ├── registry.ts    450   # command table: help metadata, aliases,
│   │   │                        #   typo suggestions (Levenshtein)
│   │   ├── reopen.ts       75
│   │   ├── rm.ts           30
│   │   ├── schedule.ts     95
│   │   ├── search.ts      187
│   │   ├── show.ts        110
│   │   ├── stats.ts        57
│   │   └── tags.ts        138
│   └── ui/
│       ├── colors.ts      187   # ANSI palette, NO_COLOR/piped detection
│       ├── filter-builder.ts 428# FilterBuilder chain, spec builder, presets,
│       │                        #   filter intersection (AND semantics)
│       ├── progress.ts    152   # bar/sparkline rendering
│       └── table.ts       187   # column-aligned tables with header rules
└── tests/
    ├── test_dateparse.ts  206   # 17 tests: calendars, expressions, recurrence
    ├── test_query.ts      274   # 20 tests: flags, filters, tokens, sort, paging
    ├── test_storage.ts    243   # 15 tests: atomic save, backups, recovery, sanitize
    └── test_task.ts       233   # 14 tests: create/edit/complete, ids, sanitize
```

## Architecture

The code is layered so that every piece is testable in isolation and no
command contains business logic:

1. **Entry & dispatch** — `bin/taskflow.ts` scans leading global flags
   (`--data`, `--no-color`, `--version`, `--help`), looks the command up in
   the registry, and translates `CliError`s into `error:` lines plus exit
   codes (0/1/2). Unknown commands get Levenshtein suggestions.
2. **Command layer** (`src/commands/*`) — thin adapters: parse argv with
   `src/args.ts`, call the domain, render through `src/ui/*`. The registry
   holds help metadata (usage, flags, examples, see-also) used by both
   `--help` and `help <command>`.
3. **Domain layer** (`src/*.ts`, pure functions) —
   `task.ts` (lifecycle + recurrence), `dateparse.ts` (all date math),
   `query.ts` (filters/sort/group/paginate), `stats.ts`, `scheduler.ts`,
   `gantt.ts`, `burndown.ts`, `serialize.ts` (CSV/JSON/Markdown),
   `id.ts` (sortable unique ids). No filesystem access here except through
   storage.
4. **Persistence** (`src/storage.ts`) — resolves the data directory
   (flag → env → `~/.taskflow`), loads with sanitizing, saves atomically
   (temp file + `rename`) after rotating the previous state into
   `tasks.json.bak.1..3`; corrupt main files recover from the newest valid
   backup or get quarantined.
5. **Presentation** (`src/ui/*`) — colors, tables, progress bars, and the
   composable `FilterBuilder` with named presets and strict AND-intersection.

Key flows:

- **Filtering** — flags and positionals merge into one `Filter` record;
  positive inline tokens fold into their dimensions (`#api` ≡ `-t api`,
  `is:done` lifts the open default), negated tokens stay for `!` semantics;
  presets combine via `combineFilters` (empty intersection ⇒ explicit
  `CONFLICTING_FILTER` usage error).
- **Recurrence** — completing a task with a rule computes
  `nextOccurrence(due, rule)` (daily/weekly add days; monthly clamps
  day-of-month) and inserts a fresh `todo` copy with a new id and a
  `recurringParent` back-reference.
- **Type stripping** — the codebase sticks to *erasable* TypeScript
  (annotations only): no enums/namespaces/decorators/parameter properties,
  relative imports end in `.ts`, so Node executes it directly and
  `tsc --noEmit` only type-checks.

## Testing

The suite uses Node's built-in `node:test` runner — no test framework to
install.

```bash
npm test                      # runs all four suites sequentially
node tests/test_query.ts      # run a single suite
node --test tests/            # alternative: runner discovery
```

| Suite | Tests | Covers |
| --- | --- | --- |
| `tests/test_dateparse.ts` | 17 | calendar primitives, expression parsing, weekday/time combos, offsets, recurrence, relative labels |
| `tests/test_task.ts` | 14 | createTask defaults/validation, applyEdit lifecycle, nextOccurrence clamping, complete/reopen, id uniqueness, sanitizing |
| `tests/test_query.ts` | 20 | parseFlags (long/short/bundled/inline/`--`), query tokens, due buckets, sort/paginate/group, presets, FilterBuilder, combineFilters |
| `tests/test_storage.ts` | 15 | data-dir precedence, atomic saves, backup rotation, corruption recovery, storeInfo, hostile-record sanitizing |

**66/66 tests passing.** Tests pin `now` with fixed dates, so they are
deterministic and timezone-safe; they use temporary directories and clean up
after themselves.

## FAQ

**Why zero dependencies?**
Portability and auditability. The entire CLI is ~9,000 lines of readable
TypeScript with nothing to `npm install`, nothing to CVE-scan, and instant
startup. Node's standard library (fs, path, crypto, os, test runner) covers
everything the tool needs.

**How does it run TypeScript without a build step?**
Node ≥ 23.6 (and 22.6+ behind a flag) strips type annotations natively. The
code is constrained to *erasable* syntax only — `tsconfig.json` enforces it
with `erasableSyntaxOnly` — so `node bin/taskflow.ts` *is* the production
runtime. `tsc --noEmit` remains available for editor/type checking.

**Where is my data?**
In the resolved data directory: `--data` flag → `TASKFLOW_DATA` env →
`~/.taskflow`. The store is a single pretty-printed `tasks.json` you can open
in any editor, plus rotating `.bak.1..3` backups.

**Can I edit `tasks.json` by hand?**
Yes. Records are sanitized on load (invalid fields are repaired or defaulted,
never crash), and `taskflow doctor` audits structure, duplicate ids, dangling
recurring-parent references and lifecycle consistency.

**What happens if the store gets corrupted?**
On the next load, taskflow restores the newest valid `tasks.json.bak.N`
automatically (with a warning). If all backups are unreadable, the broken
file is quarantined as `tasks.json.corrupt-<millis>` and a fresh store
starts — nothing is silently deleted.

**How do id prefixes work?**
Every id is ULID-style (sortable, unique even within the same millisecond).
Any unique prefix is accepted: `taskflow done 01M3CY1H` — and ambiguous
prefixes produce a helpful error listing the candidates instead of guessing.

**Is Windows supported?**
Yes — paths go through `node:path`, and every write is atomic within the data
directory. ANSI colors work in Windows Terminal / VS Code's terminal and are
auto-disabled when piped.

**Does `--preset today` include completed tasks?**
Presets constrain only the dimension they document (`today` = due date).
Combine with `--preset "today done"` or add `is:done` / `--done` to scope by
status; `overdue` already excludes done tasks by definition.

## Roadmap

- [ ] Subtasks and task dependencies (blocked-by chains on the gantt)
- [ ] `taskflow note <id>` — append timestamped notes
- [ ] Due **times** in the schedule board with a lightweight reminder loop
- [ ] Shell completions (bash/zsh/fish) generated from the registry metadata
- [ ] Themes and a `--theme` flag on top of `src/ui/colors.ts`
- [ ] Optional hooks (run a command when a task completes)
- [ ] Multi-store profiles (`taskflow --profile work …`)

Ideas and bug reports are welcome — `doctor` output plus the failing command
and `--data` directory make reproducing issues fast.

## License

Released under the [MIT License](./LICENSE). Copyright © 2026 Bui Bao Khanh.

---
**by Bui Bao Khanh**
