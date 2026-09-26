/**
 * `taskflow export` — write the (filtered) task list to CSV, JSON or Markdown.
 *
 * Output goes to stdout by default, or to `--out <file>` (parent directories
 * are created automatically). When `--format` is omitted the format is
 * guessed from the `--out` extension and defaults to CSV.
 *
 * Examples:
 *
 * ```
 * taskflow export --format json
 * taskflow export --format markdown --out backup.md
 * taskflow export +api --due week --format csv --out api-week.csv
 * ```
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Task } from '../types.ts';
import { CliError, EXIT_USAGE, normalizeExportFormat, type ExportFormat } from '../types.ts';
import { applyFilter, parseFilter, sortTasks, FILTER_FLAGS } from '../query.ts';
import { listAllTasks } from '../storage.ts';
import { fromCSV, fromJSON, fromMarkdown, toCSV, toJSON, toMarkdown } from '../serialize.ts';
import { dim } from '../ui/colors.ts';
import { emit, emitError } from './base.ts';
import { hasFlag, parseFlags, type FlagSpec } from '../args.ts';

/** Extra flags understood on top of the shared filter flags. */
const EXPORT_FLAGS: FlagSpec[] = [
  { name: 'format', short: 'f', kind: 'value' },
  { name: 'out', short: 'o', kind: 'value' },
  { name: 'title', kind: 'value' },
  { name: 'fail-empty', kind: 'flag' },
];

/** Convert parsed rows into the target format. */
export function serializeFor(format: ExportFormat, tasks: Task[], now: Date, title?: string): string {
  switch (format) {
    case 'csv':
      return toCSV(tasks);
    case 'json':
      return toJSON(tasks, now);
    case 'markdown':
      return toMarkdown(tasks, { now, title });
    default: {
      const exhaustive: never = format;
      throw new CliError('DEV_ERROR', `unhandled format ${String(exhaustive)}`);
    }
  }
}

/** Parse text in the given format (shared by import; exported for tests). */
export function parseFor(format: ExportFormat, text: string, now: Date) {
  switch (format) {
    case 'csv':
      return fromCSV(text, now);
    case 'json':
      return fromJSON(text, now);
    case 'markdown':
      return fromMarkdown(text, now);
    default: {
      const exhaustive: never = format;
      throw new CliError('DEV_ERROR', `unhandled format ${String(exhaustive)}`);
    }
  }
}

/**
 * Run `taskflow export`.
 *
 * @returns Process exit code.
 */
export function runExport(dir: string, argv: readonly string[]): number {
  // One parse over the merged vocabulary: filter flags + export flags.
  const allSpecs: FlagSpec[] = [...EXPORT_FLAGS, ...FILTER_FLAGS];
  const parsed = parseFlags(argv, allSpecs);
  const { filter } = parseFilter(argv, new Date(), EXPORT_FLAGS);

  // Exports default to *every* task; the open-only list default would
  // silently drop completed history from backups.
  const statusPinned =
    hasFlag(parsed, 'all') || hasFlag(parsed, 'done') || parsed.flags.get('status') !== undefined || parsed.flags.get('preset') !== undefined;
  if (!statusPinned) filter.statuses = [];

  const outPath = typeof parsed.flags.get('out') === 'string' ? (parsed.flags.get('out') as string) : undefined;
  const formatRaw = parsed.flags.get('format');
  let format: ExportFormat;
  if (typeof formatRaw === 'string' && formatRaw.trim() !== '') {
    format = normalizeExportFormat(formatRaw);
  } else if (outPath !== undefined) {
    const ext = path.extname(outPath).toLowerCase();
    format = ext === '.json' ? 'json' : ext === '.md' || ext === '.markdown' ? 'markdown' : 'csv';
  } else {
    format = 'csv';
  }

  const now = new Date();
  const all = listAllTasks(dir, now);
  const tasks = sortTasks(applyFilter(all, filter, now), filter.sort, filter.dir);
  const title = typeof parsed.flags.get('title') === 'string' ? (parsed.flags.get('title') as string) : 'Taskflow export';

  if (tasks.length === 0 && hasFlag(parsed, 'fail-empty')) {
    throw new CliError('EMPTY_EXPORT', 'nothing matched the filters — export aborted (--fail-empty)', EXIT_USAGE);
  }

  const payload = serializeFor(format, tasks, now, title);

  if (outPath === undefined) {
    process.stdout.write(payload);
    if (process.stdout.isTTY) emitError(dim(`· exported ${tasks.length} task${tasks.length === 1 ? '' : 's'} as ${format} to stdout`));
    return 0;
  }

  const parent = path.dirname(outPath);
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(outPath, payload, 'utf8');
  emit([`✓ Exported ${tasks.length} task${tasks.length === 1 ? '' : 's'} → ${outPath} ${dim(`(${format})`)}`]);
  return 0;
}
