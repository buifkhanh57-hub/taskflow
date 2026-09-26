/**
 * Text gantt/timeline view for taskflow.
 *
 * `renderGantt` draws one row per relevant task across a day-by-day window:
 *
 * ```
 *                Mo Tu We Th Fr Sa Su Mo
 * 01M3CXAEK2R4   ·  ░  ░  ◆  ·  ·  ·  ·
 * 01M3CXAFK9ZQ   !  ·  ·  ·  ·  ·  ·  ·
 * 01M3CXAFK8TT   ·  ·  ·  ·  ·  ·  ✔  ·
 * ```
 *
 * - `░` — the task is open between its creation day and its due day
 * - `◆` — the due day of an open task
 * - `!` — the task is overdue (due before the window starts)
 * - `✔` — completion day of a done task
 *
 * A per-day load histogram is appended below the timeline.
 *
 * @packageDocumentation
 */

import type { Task } from './types.ts';
import { addDays, formatISODate, MONTHS_SHORT, parseISODateTime, startOfDay, WEEKDAY_LETTERS } from './dateparse.ts';
import { bold, cyan, dim, green, heading, red, visibleWidth, dueStyle, yellow } from './ui/colors.ts';
import { bar, padEndVisible } from './ui/progress.ts';
import { SHORT_ID_LEN } from './id.ts';

/** Width of one day column, in cells. */
const DAY_CELL = 3;

/** Maximum number of task rows rendered. */
export const GANTT_MAX_ROWS = 24;

interface GanttRow {
  label: string;
  title: string;
  startIdx: number;
  endIdx: number;
  markIdx: number | null;
  mark: 'due' | 'done' | 'overdue';
  done: boolean;
}

/** Day index of a date inside the window, or -1 when outside. */
function dayIndex(windowStart: Date, date: Date, days: number): number {
  const idx = Math.round((startOfDay(date).getTime() - windowStart.getTime()) / 86_400_000);
  return idx >= 0 && idx < days ? idx : -1;
}

/** Build the rows shown on the timeline. */
function buildRows(tasks: Task[], windowStart: Date, days: number, now: Date): GanttRow[] {
  const windowEnd = addDays(windowStart, days - 1);
  const candidates: GanttRow[] = [];

  for (const task of tasks) {
    const created = parseISODateTime(task.createdAt);
    const completed = task.completedAt === null ? null : parseISODateTime(task.completedAt);
    const due = task.due === null ? null : parseISODateTime(task.due);

    const isDone = task.status === 'done';
    const dueIdx = due !== null ? dayIndex(windowStart, due, days) : -1;
    const doneIdx = completed !== null ? dayIndex(windowStart, completed, days) : -1;

    const overdue = !isDone && due !== null && due.getTime() < windowStart.getTime();
    const relevant =
      (!isDone && (dueIdx >= 0 || overdue)) ||
      (isDone && doneIdx >= 0);
    if (!relevant) continue;

    const createdIdx = created !== null ? dayIndex(windowStart, created, days) : -1;
    let startIdx = createdIdx >= 0 ? createdIdx : 0;
    let endIdx: number;
    let markIdx: number | null = null;
    let mark: GanttRow['mark'] = 'due';

    if (isDone) {
      endIdx = doneIdx >= 0 ? doneIdx : days - 1;
      startIdx = Math.min(startIdx, endIdx);
      markIdx = doneIdx;
      mark = 'done';
    } else if (overdue) {
      startIdx = 0;
      endIdx = 0;
      markIdx = 0;
      mark = 'overdue';
    } else {
      endIdx = dueIdx;
      markIdx = dueIdx;
      mark = 'due';
    }
    if (due !== null && due.getTime() > windowEnd.getTime() && !isDone) {
      // Due beyond the window: bar runs to the right edge with an open end.
      endIdx = days - 1;
      markIdx = null;
    }
    candidates.push({
      label: task.id.slice(0, 12),
      title: task.title,
      startIdx,
      endIdx,
      markIdx,
      mark,
      done: isDone,
    });
  }

  candidates.sort((a, b) => a.startIdx - b.startIdx || a.label.localeCompare(b.label));
  return candidates.slice(0, GANTT_MAX_ROWS);
}

/** Render the timeline itself. */
export function renderGantt(tasks: Task[], now: Date = new Date(), opts: { days?: number } = {}): string[] {
  const days = Math.max(3, Math.min(31, opts.days ?? 14));
  const windowStart = startOfDay(now);
  const lines: string[] = [];

  const labelWidth = SHORT_ID_LEN + 1;
  const pad = (text: string, width: number): string => padEndVisible(text, width);

  // Header: month marker + weekday letters + day numbers.
  const monthLine = `${pad('', labelWidth)}${Array.from({ length: days }, (_, i) => {
    const day = addDays(windowStart, i);
    const isFirst = day.getDate() === 1 || i === 0;
    return pad(isFirst ? `${MONTHS_SHORT[day.getMonth()]}` : '', DAY_CELL);
  }).join('')}`;
  const weekdayLine = `${pad('', labelWidth)}${Array.from({ length: days }, (_, i) => {
    const day = addDays(windowStart, i);
    const letter = WEEKDAY_LETTERS[(day.getDay() + 6) % 7];
    return pad(i % 7 === 6 ? bold(letter) : letter, DAY_CELL);
  }).join('')}`;
  const numbersLine = `${pad('', labelWidth)}${Array.from({ length: days }, (_, i) => {
    const day = addDays(windowStart, i);
    return pad(String(day.getDate()).slice(-2), DAY_CELL);
  }).join('')}`;

  lines.push(heading(`Timeline ${formatISODate(windowStart)} → ${formatISODate(addDays(windowStart, days - 1))} (${days} days)`));
  lines.push(dim(monthLine));
  lines.push(weekdayLine);
  lines.push(dim(numbersLine));

  const rows = buildRows(tasks, windowStart, days, now);
  if (rows.length === 0) {
    lines.push(dim('(no tasks fall inside this window)'));
    return lines;
  }

  for (const row of rows) {
    const cells: string[] = [];
    for (let i = 0; i < days; i += 1) {
      let glyph = dim('·');
      if (i >= row.startIdx && i <= row.endIdx) glyph = row.done ? green('░') : cyan('░');
      if (row.markIdx === i) {
        if (row.mark === 'done') glyph = green(bold('✔'));
        else if (row.mark === 'overdue') glyph = red(bold('! '));
        else glyph = yellow(bold('◆'));
      }
      cells.push(pad(glyph, DAY_CELL));
    }
    const title = row.title.length > 26 ? row.title.slice(0, 25) + '…' : row.title;
    const line = `${pad(row.label, labelWidth)}${cells.join('')} ${dim(title)}`;
    if (visibleWidth(line.replace(/\x1b\[[0-9;]*m/g, '')) > 120) {
      lines.push(line.slice(0, 140));
    } else {
      lines.push(line);
    }
  }

  // Legend.
  lines.push('');
  lines.push(
    dim(
      `legend: ${cyan('░')} span  ${yellow('◆')} due  ${red('!')} overdue  ${green('✔')} done  ${dim('·')} idle — rows capped at ${GANTT_MAX_ROWS}`,
    ),
  );

  // Load histogram: open tasks due per day.
  const load = Array.from({ length: days }, () => 0);
  for (const task of tasks) {
    if (task.status === 'done' || task.due === null) continue;
    const due = parseISODateTime(task.due);
    if (due === null) continue;
    const idx = dayIndex(windowStart, due, days);
    if (idx >= 0) load[idx] += 1;
  }
  const maxLoad = Math.max(...load, 0);
  if (maxLoad > 0) {
    lines.push('');
    lines.push(heading('Due load'));
    for (let i = 0; i < days; i += 1) {
      if (load[i] === 0) continue;
      const day = addDays(windowStart, i);
      const tone = load[i] >= 4 ? red : load[i] >= 2 ? yellow : green;
      const label = dueStyle(i === 0 ? 'today' : i === 1 ? 'tomorrow' : 'later', formatISODate(day).slice(5));
      lines.push(`  ${pad(label, 7)} ${tone(String(load[i]).padStart(2, ' '))} ${bar(load[i], maxLoad, { width: Math.max(10, maxLoad), fillStyle: tone })}`);
    }
  }
  return lines;
}
