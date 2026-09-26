/**
 * `taskflow list` — the daily driver view.
 *
 * Renders filtered, sorted, optionally grouped task tables with colored due
 * dates and inline `#tag` / `+project` annotations. All filtering power comes
 * from {@link parseFilter} (flags + inline query tokens + presets).
 *
 * Examples:
 *
 * ```
 * taskflow list
 * taskflow list --due week --sort priority
 * taskflow list +api #bug p0
 * taskflow list --all --group project
 * taskflow list --preset overdue
 * ```
 *
 * @packageDocumentation
 */

import type { Filter, Task } from '../types.ts';
import { describeDue, formatISODateTime } from '../dateparse.ts';
import { dueStateOf, isOverdue, shortIdOf } from '../task.ts';
import { applyFilter, describeFilter, groupTasks, paginate, parseFilter, sortTasks } from '../query.ts';
import { listAllTasks } from '../storage.ts';
import { blue, bold, count, cyan, dim, dueStyle, heading, magenta, priorityStyle, statusGlyph, white } from '../ui/colors.ts';
import { percent } from '../ui/progress.ts';
import { renderTable, type CellInput, type Column } from '../ui/table.ts';
import { clipTitle, emit } from './base.ts';

/** Render one task row (already filtered) into table cells. */
export function taskRow(task: Task, now: Date, compact: boolean): CellInput[] {
  const glyph = statusGlyph(task.status);
  const glyphColor = task.status === 'done' ? dim : task.status === 'doing' ? blue : white;
  const dueLabel = task.due === null ? dim('—') : dueStyle(dueStateOf(task, now), describeDue(task.due, now));
  const title = task.status === 'done' ? dim(clipTitle(task.title, 46)) : clipTitle(task.title, 46);
  const meta: string[] = [];
  if (task.tags.length > 0) meta.push(cyan(task.tags.map((t) => `#${t}`).join(' ')));
  if (task.project !== null) meta.push(magenta(`+${task.project}`));
  const rec = task.recurrence !== null ? cyan(' ↻') : '';
  const est = task.estimateMinutes !== null ? dim(` ~${task.estimateMinutes}m`) : '';
  const metaText = (meta.join(' ') + rec + est).trim();

  const cells: CellInput[] = [
    { text: shortIdOf(task), style: dim },
    { text: glyph, style: glyphColor },
    { text: priorityStyle(task.priority) },
    dueLabel,
    title,
  ];
  if (!compact) cells.push(metaText.length > 0 ? metaText : dim(''));
  return cells;
}

/** Build the column layout (kept in sync with {@link taskRow}). */
export function columnsFor(compact: boolean): Column[] {
  const cols: Column[] = [
    { header: 'ID' },
    { header: '•', width: 1 },
    { header: 'PRI' },
    { header: 'DUE', width: 14 },
    { header: 'TITLE', maxWidth: 46 },
  ];
  if (!compact) cols.push({ header: 'TAGS / PROJECT', maxWidth: 30 });
  return cols;
}

/** Render a single group (optional heading + table). */
export function renderGroup(key: string, tasks: Task[], filter: Filter, now: Date, compact: boolean): string[] {
  const lines: string[] = [];
  if (filter.group !== 'none') {
    lines.push(`${bold(key)} ${count(`(${tasks.length})`)}`);
  }
  const rows = tasks.map((task) => taskRow(task, now, compact));
  lines.push(...renderTable(columnsFor(compact), rows, { indent: '  ' }));
  return lines;
}

/**
 * Run `taskflow list`.
 *
 * @returns Process exit code (0, even when nothing matches).
 */
export function runList(dir: string, argv: readonly string[]): number {
  const { filter } = parseFilter(argv);
  const now = new Date();
  const all = listAllTasks(dir, now);
  const matched = sortTasks(applyFilter(all, filter, now), filter.sort, filter.dir);
  const page = paginate(matched, filter);
  const groups = groupTasks(page.items, filter.group);

  const lines: string[] = [];
  lines.push(
    `${heading('Tasks')} ${count(`· ${describeFilter(filter)} · ${matched.length} match${matched.length === 1 ? '' : 'es'}`)}`,
  );

  if (page.items.length === 0) {
    lines.push('');
    lines.push(dim('  (no matching tasks — try `taskflow list --all` or loosen the filters)'));
  } else {
    for (const group of groups) {
      if (filter.group !== 'none') lines.push('');
      lines.push(...renderGroup(group.key, group.tasks, filter, now, false));
    }
  }

  // Footer: counts + pagination hint.
  const open = matched.filter((t) => t.status !== 'done').length;
  const overdue = matched.filter((t) => isOverdue(t, now)).length;
  lines.push('');
  lines.push(
    `  shown ${page.items.length} of ${matched.length} matched ${count('·')} open ${open} ${count('·')} overdue ${overdue} ${count(
      '·',
    )} completion ${percent(matched.length - open, matched.length)}`,
  );
  if (filter.limit !== null && page.offset + page.items.length < matched.length) {
    lines.push(dim(`  more available — retry with --offset ${page.offset + page.items.length}`));
  }
  lines.push(dim(`  updated ${formatISODateTime(now)} · data: ${dir}`));
  emit(lines);
  return 0;
}
