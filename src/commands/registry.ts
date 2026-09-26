/**
 * Command registry for taskflow.
 *
 * Pairs every command's declarative help block with its runner and provides
 * the lookup used by the dispatcher. Adding a command means: write
 * `src/commands/<name>.ts`, then append one entry here — the dispatcher,
 * `--help`, `help <cmd>` and the did-you-mean suggestions all derive from
 * this table.
 *
 * @packageDocumentation
 */

import type { CommandHelp } from './base.ts';
import { runAdd } from './add.ts';
import { runList } from './list.ts';
import { runShow } from './show.ts';
import { runDone } from './done.ts';
import { runReopen } from './reopen.ts';
import { runEdit } from './edit.ts';
import { runRm } from './rm.ts';
import { runSearch } from './search.ts';
import { runStats } from './stats.ts';
import { runSchedule } from './schedule.ts';
import { runGantt } from './gantt.ts';
import { runBurndown } from './burndown.ts';
import { runExport } from './export.ts';
import { runImport } from './import.ts';
import { runProjects } from './projects.ts';
import { runTags } from './tags.ts';
import { runDoctor } from './doctor.ts';

/** A registry entry: declarative help plus the executable runner. */
export interface CommandEntry {
  readonly help: CommandHelp;
  readonly run: (dir: string, argv: readonly string[]) => number;
}

/** Every command, in help-table order. */
export const COMMANDS: readonly CommandEntry[] = [
  {
    help: {
      name: 'add',
      aliases: ['a', 'new'],
      summary: 'create a new task',
      usage: 'add <title…> [options]',
      details: [
        'Titles are everything that is not a flag; quote them when they contain',
        'dashes or special characters. Due dates accept natural language:',
        'tomorrow, fri, +3d, in 2 weeks, jan 15, fri 3pm, 2026-01-15.',
      ],
      flags: [
        ['-p, --priority <P0..P3>', 'priority level (also urgent/high/normal/low); default P2'],
        ['-t, --tag <list>', 'tags, comma separated or repeated'],
        ['-j, --project <slug>', 'project this task belongs to'],
        ['--due <when>', 'natural-language or ISO due date'],
        ['-r, --recurrence <rule>', 'daily, weekly, biweekly, monthly, every 3 days, …'],
        ['--estimate <size>', 'size estimate: 30m, 2h, 2h30m, 1d'],
        ['--notes <text>', 'long description stored with the task'],
        ['--status <status>', 'initial status: todo (default), doing, done'],
      ],
      examples: [
        'taskflow add Fix login redirect -p P0 --tags bug,api --project auth --due tomorrow',
        'taskflow add "Write release notes" --due "fri 3pm" --estimate 2h',
        'taskflow add Water the plants -r weekly --due sunday',
      ],
      seeAlso: ['list', 'edit'],
    },
    run: runAdd,
  },
  {
    help: {
      name: 'list',
      aliases: ['ls', 'l'],
      summary: 'list and filter tasks',
      usage: 'list [filters…] [options]',
      details: [
        'Default view shows open work (todo + doing) sorted by due date.',
        'Filters combine freely: flags, inline tokens (#tag, +project, p0..p3,',
        'is:done, each negatable with !) and --preset names.',
      ],
      flags: [
        ['-s, --status <list>', 'todo,doing,done (default: open work)'],
        ['-p, --priority <list>', 'P0..P3 subset'],
        ['-t, --tag <list>', 'tasks must carry ALL these tags'],
        ['-j, --project <list>', 'project slugs (OR), `none` for project-less'],
        ['--due <mode>', 'today, tomorrow, week, overdue, none, future or ISO date'],
        ['--overdue', 'shorthand for --due overdue'],
        ['--sort <field>', 'due, priority, created, updated, completed, title, status'],
        ['--asc / --desc', 'sort direction'],
        ['--limit N / --offset N', 'pagination window'],
        ['-g, --group <mode>', 'group rows: project, tag, status, priority'],
        ['--all', 'include done tasks'],
        ['--done', 'only completed tasks'],
        ['--preset <names>', 'named filters: open, todo, doing, done, today, tomorrow, week, overdue, undated, urgent, p0, p1'],
      ],
      examples: [
        'taskflow list',
        'taskflow list --due week --sort priority',
        'taskflow list +api #bug p0',
        'taskflow list --all --group project',
        'taskflow list --preset overdue --desc',
      ],
      seeAlso: ['search', 'show'],
    },
    run: runList,
  },
  {
    help: {
      name: 'show',
      aliases: [],
      summary: 'full detail view for one task',
      usage: 'show <id-prefix>',
      details: [
        'Accepts the full 26-character id or any unique prefix (the first 8',
        'characters shown in tables are usually enough). Lists related tasks in',
        'the same project and children spawned from a recurring template.',
      ],
      examples: ['taskflow show 01JT5Z9M', 'taskflow show 01JT5Z9M3K'],
      seeAlso: ['edit', 'done'],
    },
    run: runShow,
  },
  {
    help: {
      name: 'done',
      aliases: ['complete', 'x'],
      summary: 'complete one or more tasks',
      usage: 'done <id-prefix>… [--at <when>]',
      details: [
        'Completing a recurring task automatically spawns the next open',
        'occurrence so the cycle never drops. Batch completes are all-or-nothing:',
        'every id must resolve before anything is saved.',
      ],
      flags: [['--at <when>', 'backfill the completion timestamp (e.g. --at yesterday)']],
      examples: ['taskflow done 01JT5Z9M', 'taskflow done 01JT5Z9M 01JT6A1B', 'taskflow done 01JT5Z9M --at "2 days ago"'],
      seeAlso: ['reopen'],
    },
    run: runDone,
  },
  {
    help: {
      name: 'reopen',
      aliases: ['undo'],
      summary: 'send completed tasks back to todo',
      usage: 'reopen <id-prefix>…',
      details: ['Clears the completion timestamp and stamps updatedAt.'],
      examples: ['taskflow reopen 01JT5Z9M'],
      seeAlso: ['done'],
    },
    run: runReopen,
  },
  {
    help: {
      name: 'edit',
      aliases: ['e'],
      summary: 'change fields of an existing task',
      usage: 'edit <id-prefix> [new title…] [options]',
      details: [
        'Positional words after the id replace the title. Tags support three',
        'modes: --tag replaces the list, --add-tag appends, --rm-tag removes.',
        'Clear any field with the value `none` (--due none, --project none, …).',
      ],
      flags: [
        ['-p, --priority <P0..P3>', 'new priority'],
        ['-t, --tag <list>', 'replace the whole tag list'],
        ['--add-tag <list>', 'append tags'],
        ['--rm-tag <list>', 'remove tags'],
        ['-j, --project <slug>', 'new project; `none` detaches'],
        ['--due <when>', 'new due date; `none` clears it'],
        ['--notes <text>', 'replace notes'],
        ['-r, --recurrence <rule>', 'new recurrence; `none` removes it'],
        ['--estimate <size>', 'new estimate; `none` clears it'],
        ['--status <status>', 'todo, doing or done'],
      ],
      examples: [
        'taskflow edit 01JT5Z9M "Fix login redirect on mobile"',
        'taskflow edit 01JT5Z9M -p P0 --due fri',
        'taskflow edit 01JT5Z9M --add-tag urgent --rm-tag someday',
      ],
      seeAlso: ['add', 'show'],
    },
    run: runEdit,
  },
  {
    help: {
      name: 'rm',
      aliases: ['remove', 'delete'],
      summary: 'permanently delete tasks',
      usage: 'rm <id-prefix>…',
      details: [
        'All-or-nothing: every selector must resolve, otherwise nothing is',
        'deleted. Recent states remain recoverable from tasks.json.bak.* in the',
        'data directory.',
      ],
      examples: ['taskflow rm 01JT5Z9M', 'taskflow rm 01JT5Z9M 01JT6A1B'],
      seeAlso: ['done'],
    },
    run: runRm,
  },
  {
    help: {
      name: 'search',
      aliases: ['s', 'find'],
      summary: 'relevance-ranked full-text search',
      usage: 'search <query…> [filters…]',
      details: [
        'Scans every task (done included) across title, notes, tags and',
        'projects. Hits are ranked: title matches weigh 3, tag/project 2,',
        'notes 1. Inline tokens narrow the candidate set first.',
      ],
      examples: ['taskflow search login', 'taskflow search api retry --limit 5', 'taskflow search #bug is:open'],
      seeAlso: ['list'],
    },
    run: runSearch,
  },
  {
    help: {
      name: 'stats',
      aliases: [],
      summary: 'streaks, velocity and portfolio breakdowns',
      usage: 'stats [--weeks N] [--top N] [--json] [+project] [#tag]',
      details: [
        'Overview counters, completion streaks, weekly velocity sparkline and',
        'per-priority / per-project / per-tag tables. Scope the computation to',
        'one project or tag with --project / --tag.',
      ],
      flags: [
        ['--weeks <N>', 'velocity window length (1..52, default 8)'],
        ['--top <N>', 'rows per breakdown table (default 8)'],
        ['--json', 'machine-readable snapshot incl. store info'],
        ['-j, --project <list>', 'restrict the computation'],
        ['-t, --tag <list>', 'restrict the computation'],
      ],
      examples: ['taskflow stats', 'taskflow stats --weeks 12', 'taskflow stats +api --json'],
      seeAlso: ['burndown', 'schedule'],
    },
    run: runStats,
  },
  {
    help: {
      name: 'schedule',
      aliases: ['today'],
      summary: 'what needs attention now',
      usage: 'schedule [--catchup] [--horizon N]',
      details: [
        'Urgency board: overdue, today, tomorrow and the rest of the week, plus',
        'the upcoming horizon and recurring-rule health. --catchup materializes',
        'missed occurrences of recurring tasks whose due date slipped.',
      ],
      flags: [
        ['--catchup', 'spawn missed occurrences and save'],
        ['--horizon <N>', 'days in the upcoming section (1..90, default 7)'],
        ['--no-upcoming', 'skip the upcoming section'],
      ],
      examples: ['taskflow schedule', 'taskflow schedule --catchup', 'taskflow schedule --horizon 14'],
      seeAlso: ['gantt', 'stats'],
    },
    run: runSchedule,
  },
  {
    help: {
      name: 'gantt',
      aliases: ['timeline'],
      summary: 'ASCII timeline of the next days',
      usage: 'gantt [--days N] [+project] [#tag] [--all]',
      details: [
        'One row per relevant task across a day-by-day window with due markers,',
        'overdue flags and a per-day load histogram. Rows are capped at 24.',
      ],
      flags: [
        ['--days <N>', 'window width, 3..31 (default 14)'],
        ['-j, --project <list>', 'restrict to projects'],
        ['-t, --tag <list>', 'restrict to tags'],
        ['--all', 'include completed tasks'],
      ],
      examples: ['taskflow gantt', 'taskflow gantt --days 21 +api'],
      seeAlso: ['burndown', 'schedule'],
    },
    run: runGantt,
  },
  {
    help: {
      name: 'burndown',
      aliases: ['burn'],
      summary: 'ASCII burndown of the trailing window',
      usage: 'burndown [--days N] [+project] [#tag] [--csv]',
      details: [
        'Replays task history: open backlog per day versus the ideal even-burn',
        'line, with an on-track verdict. Scope to a project or tag to burndown',
        'a single initiative.',
      ],
      flags: [
        ['--days <N>', 'window width, 3..60 (default 14)'],
        ['-j, --project <list>', 'restrict to projects'],
        ['-t, --tag <list>', 'restrict to tags'],
        ['--csv', 'print day,actual,ideal rows instead of the chart'],
      ],
      examples: ['taskflow burndown', 'taskflow burndown --days 30 +migration'],
      seeAlso: ['stats', 'gantt'],
    },
    run: runBurndown,
  },
  {
    help: {
      name: 'export',
      aliases: [],
      summary: 'write tasks to CSV, JSON or Markdown',
      usage: 'export [filters…] [--format f] [--out file]',
      details: [
        'Defaults to exporting every task in CSV to stdout. --out picks the',
        'target file (format guessed from the extension); --format overrides.',
        'Markdown output is a checklist that `import` reads back.',
      ],
      flags: [
        ['-f, --format <fmt>', 'csv, json or markdown'],
        ['-o, --out <file>', 'write to a file instead of stdout'],
        ['--title <text>', 'Markdown document title'],
        ['--fail-empty', 'exit non-zero when nothing matches'],
        ['(all list filters)', '--status, --priority, --tag, --project, --due, --sort, …'],
      ],
      examples: [
        'taskflow export --format json',
        'taskflow export --format markdown --out backup.md',
        'taskflow export +api --due week -o api-week.csv',
      ],
      seeAlso: ['import'],
    },
    run: runExport,
  },
  {
    help: {
      name: 'import',
      aliases: [],
      summary: 'load tasks from CSV, JSON or Markdown',
      usage: 'import <file>… [--format f] [--replace|--replace-existing] [--dry-run]',
      details: [
        'Format is detected from the extension, then by sniffing. Rows are',
        'sanitized; broken rows are reported and skipped. Default merge adds',
        'new ids and keeps existing ones; --replace swaps the whole store.',
      ],
      flags: [
        ['-f, --format <fmt>', 'force csv, json or markdown'],
        ['--replace', 'replace the entire store with the file'],
        ['--replace-existing', 'merge, but incoming records overwrite'],
        ['--dry-run', 'validate and report without writing'],
      ],
      examples: [
        'taskflow import backup.md',
        'taskflow import tasks.csv --dry-run',
        'taskflow import snapshot.json --replace',
      ],
      seeAlso: ['export'],
    },
    run: runImport,
  },
  {
    help: {
      name: 'projects',
      aliases: ['proj'],
      summary: 'per-project breakdown and management',
      usage: 'projects [rename OLD NEW | drop OLD]',
      details: [
        'Without arguments: totals, open work, overdue exposure and completion',
        'progress per project slug. rename moves every task to a new slug,',
        'drop detaches them from the project.',
      ],
      examples: ['taskflow projects', 'taskflow projects rename api backend', 'taskflow projects drop archive'],
      seeAlso: ['tags'],
    },
    run: runProjects,
  },
  {
    help: {
      name: 'tags',
      aliases: ['tag'],
      summary: 'tag vocabulary breakdown and management',
      usage: 'tags [rename OLD NEW | drop OLD]',
      details: ['Same shape as `projects`, for tags. A task counts for every tag it carries.'],
      examples: ['taskflow tags', 'taskflow tags rename bug defect'],
      seeAlso: ['projects'],
    },
    run: runTags,
  },
  {
    help: {
      name: 'doctor',
      aliases: [],
      summary: 'store health check with optional auto-repair',
      usage: 'doctor [--fix]',
      details: [
        'Verifies the data directory and scans every task for duplicate or',
        'malformed ids, broken recurrence anchors, inconsistent lifecycle',
        'stamps and dangling recurring-parent references. --fix repairs what',
        'can be repaired automatically.',
      ],
      flags: [['--fix', 'apply automatic repairs and save']],
      examples: ['taskflow doctor', 'taskflow doctor --fix'],
      seeAlso: [],
    },
    run: runDoctor,
  },
];

/** Find a command by canonical name or alias (case-insensitive). */
export function findCommand(name: string): CommandEntry | null {
  const needle = name.trim().toLowerCase();
  if (needle === '') return null;
  for (const entry of COMMANDS) {
    if (entry.help.name === needle) return entry;
    if (entry.help.aliases.includes(needle)) return entry;
  }
  return null;
}

/** Levenshtein edit distance (small strings only — used for suggestions). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j += 1) prev[j] = curr[j];
  }
  return prev[n];
}

/** Closest known commands for a misspelled input. */
export function suggestCommands(input: string, max: number = 3): string[] {
  const scored = COMMANDS.flatMap((entry) => [
    { name: entry.help.name, distance: editDistance(input.toLowerCase(), entry.help.name) },
    ...entry.help.aliases.map((alias) => ({ name: alias, distance: editDistance(input.toLowerCase(), alias) })),
  ])
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .filter((s) => s.distance <= Math.max(2, Math.floor(input.length / 2)));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of scored) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(s.name);
    if (out.length >= max) break;
  }
  return out;
}
