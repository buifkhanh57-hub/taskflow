/**
 * Burndown analytics for taskflow.
 *
 * A burndown answers one question: *is the backlog shrinking fast enough?*
 * {@link computeBurndown} replays task history over a trailing window of days
 * and produces, per day:
 *
 * - `actual` — how many tasks were still open at the end of that day
 *   (created on or before it, not yet completed),
 * - `ideal` — the straight line from the scope at window start down to zero,
 *   the classic "if we burned evenly" reference.
 *
 * {@link renderBurndown} draws the result as an ASCII chart:
 *
 * ```
 * 12 |              ·     ·
 * 10 |        ·           ·  ●
 *  ...
 *      03-01     03-05     03-09
 * ```
 *
 * All functions are pure; persistence stays with the caller.
 *
 * @packageDocumentation
 */

import type { Task } from './types.ts';
import { addDays, formatISODate, parseISODateTime, startOfDay } from './dateparse.ts';
import { bold, dim, green, heading, red, yellow } from './ui/colors.ts';
import { percent } from './ui/progress.ts';

/** One day of burndown history. */
export interface BurndownPoint {
  /** ISO date (`YYYY-MM-DD`) the row refers to. */
  day: string;
  /** Human label (`MM-DD`) used on the chart axis. */
  label: string;
  /** Open tasks at the end of the day (as far as history can tell). */
  actual: number;
  /** Ideal remaining work for an even burn-down from the window scope. */
  ideal: number;
}

/** Result of a burndown computation. */
export interface BurndownResult {
  /** One point per day, oldest first. */
  points: BurndownPoint[];
  /** Peak open-task count within the window (the ideal line's start). */
  scope: number;
  /** Tasks completed inside the window. */
  completedInWindow: number;
  /** Open tasks right now (last point's `actual`). */
  remaining: number;
  /** Ideal remaining work for today. */
  idealToday: number;
  /** True when actual ≤ ideal today (on or ahead of the even-burn line). */
  onTrack: boolean;
  /** True when `actual` counts fewer tasks than the store currently holds open (pre-window creations excluded). */
  truncated: boolean;
  /** True when neither open work nor completions existed in the window. */
  empty: boolean;
}

/** Largest window accepted (keeps the chart readable). */
export const BURNDOWN_MAX_DAYS = 60;

/** Minimum window width. */
export const BURNDOWN_MIN_DAYS = 3;

/**
 * Replay task history and compute the burndown series.
 *
 * Tasks created *after* the window opened only join the scope on their
 * creation day; `truncated` reports whether the opening scope therefore
 * understates the true backlog (useful context when reading the chart).
 *
 * @param tasks All tasks (open and completed) — completions drive history.
 * @param now Reference "today".
 * @param days Window length in days (clamped to 3..60).
 */
export function computeBurndown(tasks: Task[], now: Date = new Date(), days: number = 14): BurndownResult {
  const window = Math.max(BURNDOWN_MIN_DAYS, Math.min(BURNDOWN_MAX_DAYS, Math.floor(days) || 14));
  const todayMid = startOfDay(now).getTime();
  const windowStart = addDays(startOfDay(now), -(window - 1));

  const created: (number | null)[] = [];
  const completed: (number | null)[] = [];
  for (const task of tasks) {
    const c = parseISODateTime(task.createdAt);
    created.push(c === null ? null : startOfDay(c).getTime());
    if (task.status === 'done' && task.completedAt !== null) {
      const d = parseISODateTime(task.completedAt);
      completed.push(d === null ? null : startOfDay(d).getTime());
    } else {
      completed.push(null);
    }
  }

  const points: BurndownPoint[] = [];
  let openAtStart = 0;
  let completionsInWindow = 0;
  let sawCreationAfterStart = false;

  for (let i = 0; i < window; i += 1) {
    const day = addDays(windowStart, i);
    const dayMid = startOfDay(day).getTime();
    const dayEnd = dayMid + 86_399_999;
    let actual = 0;
    for (let t = 0; t < tasks.length; t += 1) {
      const createdAt = created[t];
      const completedAt = completed[t];
      if (createdAt !== null && createdAt <= dayEnd) {
        const stillOpen = completedAt === null || completedAt > dayEnd;
        if (stillOpen) actual += 1;
      }
      if (completedAt !== null && completedAt >= dayMid && completedAt <= dayEnd && createdAt !== null && createdAt <= dayEnd) {
        completionsInWindow += 1;
      }
    }
    if (i === 0) {
      openAtStart = actual;
      for (const c of created) {
        if (c !== null && c > dayEnd) sawCreationAfterStart = true;
      }
    }
    points.push({
      day: formatISODate(day),
      label: formatISODate(day).slice(5),
      actual,
      ideal: 0,
    });
  }

  // The ideal line burns the peak backlog (the largest open count in the
  // window) evenly down to zero. Using openAtStart alone would flatten the
  // line to zero when the whole scope was created mid-window.
  const scope = Math.max(openAtStart, ...points.map((p) => p.actual));
  for (let i = 0; i < points.length; i += 1) {
    const frac = points.length <= 1 ? 0 : i / (points.length - 1);
    points[i].ideal = Math.max(0, Math.round(scope * (1 - frac)));
  }

  const last = points[points.length - 1];
  const anyActivity = scope > 0 || completionsInWindow > 0;
  return {
    points,
    scope,
    completedInWindow: completionsInWindow,
    remaining: last.actual,
    idealToday: last.ideal,
    onTrack: last.actual <= last.ideal,
    truncated: sawCreationAfterStart,
    empty: !anyActivity,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderBurndownOptions {
  /** Chart height in rows. Default 8. */
  height?: number;
  /** Disable ANSI colors (the CLI normally decides globally). */
  colorless?: boolean;
}

/**
 * Render a burndown series as an ASCII chart with axis labels and a summary
 * footer. Returns lines; the caller prints them.
 */
export function renderBurndown(result: BurndownResult, opts: RenderBurndownOptions = {}): string[] {
  const height = Math.max(2, Math.floor(opts.height ?? 8));
  const points = result.points;
  const lines: string[] = [];

  const maxValue = Math.max(1, ...points.map((p) => Math.max(p.actual, p.ideal)));
  const yMax = maxValue;
  const levels = height; // rows above the baseline (plus the 0 baseline)
  const step = yMax / levels;

  const colFor = (value: number): number => {
    // Map a value onto the row index (0 = top row = yMax, levels = baseline 0).
    const snapped = Math.round(value / step);
    return Math.max(0, Math.min(levels, snapped));
  };

  const grid: string[][] = Array.from({ length: levels + 1 }, () => Array.from({ length: points.length }, () => ' '));
  for (let c = 0; c < points.length; c += 1) {
    const point = points[c];
    const actualRow = levels - colFor(point.actual);
    const idealRow = levels - colFor(point.ideal);
    if (grid[actualRow][c] === ' ') grid[actualRow][c] = '●';
    if (grid[idealRow][c] === ' ') grid[idealRow][c] = '·';
    if (actualRow === idealRow) grid[actualRow][c] = '◆';
  }

  const blank = (cell: string): string => (cell === ' ' ? ' ' : cell);
  const gutter = String(yMax).length + 2;
  lines.push(heading(`Burndown — last ${points.length} day${points.length === 1 ? '' : 's'}`));
  for (let r = 0; r <= levels; r += 1) {
    const levelValue = Math.round(yMax - r * step);
    // Label only the top and the baseline to avoid duplicated rounded values.
    const showLabel = r === 0 || r === levels;
    const axis = showLabel ? String(levelValue).padStart(String(yMax).length, ' ') : ' '.repeat(String(yMax).length);
    const row = grid[r]
      .map((cell) => {
        if (cell === '●') return green('●');
        if (cell === '·') return dim('·');
        if (cell === '◆') return yellow('◆');
        return blank(cell);
      })
      .join(' ');
    lines.push(`${dim(axis)}${' '.repeat(gutter - axis.length - 1)}│${row}`);
  }

  // X axis: rail + labels at first / middle / last column. The middle label
  // only fits once the axis is wide enough for three 5-character labels.
  const rail = `${' '.repeat(gutter - 1)}└${'─'.repeat(points.length * 2 - 1)}`;
  lines.push(dim(rail));
  const axisWidth = points.length * 2 - 1;
  const axisRow: string[] = Array.from({ length: axisWidth }, () => ' ');
  const placeLabel = (idx: number, text: string, mode: 'left' | 'center' | 'right'): void => {
    const start = mode === 'left' ? idx * 2 : mode === 'right' ? axisWidth - text.length : idx * 2 - Math.floor(text.length / 2);
    for (let i = 0; i < text.length; i += 1) {
      const pos = start + i;
      if (pos >= 0 && pos < axisWidth) axisRow[pos] = text[i];
    }
  };
  const first = points[0];
  const lastPoint = points[points.length - 1];
  placeLabel(0, first.label, 'left');
  const midIdx = Math.floor((points.length - 1) / 2);
  if (axisWidth >= 24 && midIdx !== 0 && midIdx !== points.length - 1) placeLabel(midIdx, points[midIdx].label, 'center');
  placeLabel(points.length - 1, lastPoint.label, 'right');
  lines.push(`${' '.repeat(gutter)}${dim(axisRow.join(''))}`);
  lines.push('');

  // Summary footer.
  const doneRateWord = result.onTrack ? green('on track') : yellow('behind ideal');
  lines.push(
    `  scope ${bold(String(result.scope))}${dim(' · ')}completed ${bold(green(String(result.completedInWindow)))}${dim(
      ' · ',
    )}remaining ${bold(String(result.remaining))} ${dim(`(ideal ${result.idealToday})`)} ${dim('·')} ${doneRateWord}`,
  );
  if (result.truncated) {
    lines.push(dim('  note: tasks created after the window opened join the chart on their creation day'));
  }
  if (result.remaining === 0 && result.scope > 0) {
    lines.push(green('  ✓ everything in scope is done — nothing left to burn'));
  }
  if (result.empty) {
    lines.push(dim('  (no tasks existed in this window)'));
  }
  lines.push(dim(`  completion rate overall: ${percent(Math.max(0, result.scope - result.remaining), Math.max(1, result.scope))}`));
  if (result.onTrack && result.remaining > 0) {
    lines.push(dim(`  keep the pace: ≈${Math.ceil(result.remaining / 7)}/day clears the backlog within a week`));
  }
  if (!result.onTrack) {
    lines.push(red('  hint: close lowest-effort tasks first to catch up with the ideal line'));
  }
  return lines;
}

/** Render the burndown series as flat `day,actual,ideal` CSV (debugging/tests). */
export function burndownToCSV(result: BurndownResult): string {
  const rows = ['day,actual,ideal'];
  for (const point of result.points) {
    rows.push(`${point.day},${point.actual},${point.ideal}`);
  }
  return rows.join('\n') + '\n';
}
