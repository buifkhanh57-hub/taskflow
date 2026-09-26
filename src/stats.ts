/**
 * Statistics engine for taskflow: completion streaks, weekly velocity,
 * overdue exposure and per-priority / per-project / per-tag breakdowns.
 *
 * {@link computeStats} produces a plain {@link StatsSnapshot} object (easy to
 * serialize or embed), while {@link renderStats} turns one into colored
 * terminal lines.
 *
 * @packageDocumentation
 */

import type { GroupedBreakdown, StatsSnapshot, Status, Task, WeekVelocity } from './types.ts';
import { PRIORITIES, PRIORITY_KEYS, STATUS_KEYS } from './types.ts';
import { addDays, formatISODate, formatISODateTime, formatTimeOfDay, parseISODateTime, startOfDay, startOfWeek } from './dateparse.ts';
import { isOverdue } from './task.ts';
import { heading, bold, dim, green, red, yellow, count, priorityStyle, dueStyle } from './ui/colors.ts';
import { bar, barLabel, percent, sparkline, trend } from './ui/progress.ts';
import { renderTable } from './ui/table.ts';

export interface StatsOptions {
  /** Number of weekly velocity buckets. Default 8. */
  weeks?: number;
}

/** Parse an `YYYY-MM-DD` day string into a local midnight Date (invalid → null). */
function isoDayToDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Set of ISO days on which at least one task was completed. */
export function completionDaySet(tasks: Task[]): Set<string> {
  const days = new Set<string>();
  for (const task of tasks) {
    if (task.status !== 'done' || task.completedAt === null) continue;
    const completed = parseISODateTime(task.completedAt);
    if (completed !== null) days.add(formatISODate(completed));
  }
  return days;
}

/**
 * Current streak: consecutive completion days ending today, or ending
 * yesterday when nothing was completed yet today.
 */
export function currentStreak(days: Set<string>, now: Date): number {
  let cursor = startOfDay(now);
  if (!days.has(formatISODate(cursor))) cursor = addDays(cursor, -1);
  let streak = 0;
  while (days.has(formatISODate(cursor))) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** Longest run of consecutive completion days in the whole history. */
export function longestStreak(days: Set<string>): number {
  const sorted = [...days].sort();
  let best = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const iso of sorted) {
    const day = isoDayToDate(iso);
    if (day === null) continue;
    if (prev !== null) {
      const diff = Math.round((day.getTime() - prev.getTime()) / 86_400_000);
      run = diff === 1 ? run + 1 : 1;
    } else {
      run = 1;
    }
    if (run > best) best = run;
    prev = day;
  }
  return best;
}

/**
 * Weekly completion counts for the last `weeks` ISO weeks (Monday-based),
 * oldest bucket first.
 */
export function weeklyVelocity(days: Set<string>, now: Date, weeks: number): WeekVelocity[] {
  const out: WeekVelocity[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const ws = startOfWeek(addDays(now, -7 * i));
    const we = addDays(ws, 7);
    let completed = 0;
    for (const iso of days) {
      const day = isoDayToDate(iso);
      if (day !== null && day.getTime() >= ws.getTime() && day.getTime() < we.getTime()) completed += 1;
    }
    out.push({
      weekStart: formatISODate(ws),
      label: `${formatISODate(ws).slice(5)}`,
      completed,
    });
  }
  return out;
}

/** Build one breakdown bucket list keyed by `keyFn` (null keys become `(none)`). */
export function breakdown(tasks: Task[], keyFn: (task: Task) => string | null, now: Date): GroupedBreakdown[] {
  const map = new Map<string, GroupedBreakdown>();
  const bucketFor = (key: string): GroupedBreakdown => {
    let b = map.get(key);
    if (!b) {
      b = { key, total: 0, done: 0, open: 0, overdue: 0, completionRate: 0 };
      map.set(key, b);
    }
    return b;
  };
  for (const task of tasks) {
    const key = keyFn(task) ?? '(none)';
    const b = bucketFor(key);
    b.total += 1;
    if (task.status === 'done') b.done += 1;
    else {
      b.open += 1;
      if (isOverdue(task, now)) b.overdue += 1;
    }
  }
  for (const b of map.values()) {
    b.completionRate = b.total > 0 ? b.done / b.total : 0;
  }
  return [...map.values()];
}

/** Mean hours between creation and completion across completed tasks (null when none). */
export function averageCompletionHours(tasks: Task[]): number | null {
  let sumMs = 0;
  let n = 0;
  for (const task of tasks) {
    if (task.status !== 'done' || task.completedAt === null) continue;
    const created = parseISODateTime(task.createdAt);
    const completed = parseISODateTime(task.completedAt);
    if (created === null || completed === null) continue;
    const ms = completed.getTime() - created.getTime();
    if (ms < 0) continue;
    sumMs += ms;
    n += 1;
  }
  if (n === 0) return null;
  return Math.round((sumMs / n / 3_600_000) * 10) / 10;
}

/**
 * Compute the full statistics snapshot for a task list.
 *
 * @param tasks All tasks in the store (open and completed).
 * @param now Reference time for streaks, overdue checks and velocity buckets.
 */
export function computeStats(tasks: Task[], now: Date = new Date(), opts: StatsOptions = {}): StatsSnapshot {
  const weeks = Math.max(1, Math.min(52, opts.weeks ?? 8));
  const days = completionDaySet(tasks);
  const byStatus: Record<Status, number> = { todo: 0, doing: 0, done: 0 };
  let overdue = 0;
  let dueToday = 0;
  let dueThisWeek = 0;
  const todayMid = startOfDay(now).getTime();
  const weekEnd = addDays(startOfDay(now), 7).getTime();

  for (const task of tasks) {
    byStatus[task.status] += 1;
    if (task.status === 'done') continue;
    if (isOverdue(task, now)) overdue += 1;
    if (task.due === null) continue;
    const due = parseISODateTime(task.due);
    if (due === null) continue;
    const dueMid = startOfDay(due).getTime();
    if (dueMid === todayMid) dueToday += 1;
    if (dueMid >= todayMid && dueMid < weekEnd) dueThisWeek += 1;
  }

  const done = byStatus.done;
  const total = tasks.length;
  const open = byStatus.todo + byStatus.doing;
  const lastDone = [...days].sort().pop() ?? null;

  const byPriorityFull = PRIORITY_KEYS.map((pri) => {
    const scoped = tasks.filter((t) => t.priority === pri);
    const rows = breakdown(scoped, () => pri, now);
    return rows[0] ?? { key: pri, total: 0, done: 0, open: 0, overdue: 0, completionRate: 0 };
  });

  const byProject = breakdown(tasks, (t) => t.project, now).sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  const tagMap = new Map<string, GroupedBreakdown>();
  for (const task of tasks) {
    if (task.tags.length === 0) {
      const b = tagMap.get('(untagged)') ?? { key: '(untagged)', total: 0, done: 0, open: 0, overdue: 0, completionRate: 0 };
      b.total += 1;
      if (task.status === 'done') b.done += 1;
      else {
        b.open += 1;
        if (isOverdue(task, now)) b.overdue += 1;
      }
      tagMap.set('(untagged)', b);
      continue;
    }
    for (const tag of task.tags) {
      const b = tagMap.get(tag) ?? { key: tag, total: 0, done: 0, open: 0, overdue: 0, completionRate: 0 };
      b.total += 1;
      if (task.status === 'done') b.done += 1;
      else {
        b.open += 1;
        if (isOverdue(task, now)) b.overdue += 1;
      }
      tagMap.set(tag, b);
    }
  }
  const byTag = [...tagMap.values()]
    .map((b) => ({ ...b, completionRate: b.total > 0 ? b.done / b.total : 0 }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));

  return {
    generatedAt: formatISODateTime(now),
    total,
    open,
    done,
    doing: byStatus.doing,
    overdue,
    dueToday,
    dueThisWeek,
    completionRate: total > 0 ? done / total : 0,
    streak: {
      current: currentStreak(days, now),
      longest: longestStreak(days),
      lastCompletedDay: lastDone,
    },
    velocity: weeklyVelocity(days, now, weeks),
    avgCompletionHours: averageCompletionHours(tasks),
    byPriority: byPriorityFull,
    byStatus,
    byProject,
    byTag,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderStatsOptions {
  /** Max rows shown for tag/project tables. Default 8. */
  topN?: number;
}

/**
 * Render a snapshot as colored terminal lines (overview, streak, velocity
 * sparkline, and per-priority/project/tag tables).
 */
export function renderStats(stats: StatsSnapshot, opts: RenderStatsOptions = {}): string[] {
  const topN = Math.max(1, opts.topN ?? 8);
  const lines: string[] = [];

  lines.push(heading('Overview'));
  lines.push(
    `  total ${bold(String(stats.total))}${count(' · ')}open ${bold(String(stats.open))}${count(' · ')}done ${bold(
      String(stats.done),
    )}${count(' · ')}in progress ${bold(String(stats.doing))}`,
  );
  lines.push(
    `  ${stats.overdue > 0 ? red(`${stats.overdue} overdue`) : dim('0 overdue')}${count(' · ')}${
      stats.dueToday > 0 ? yellow(`${stats.dueToday} due today`) : dim('0 due today')
    }${count(' · ')}${stats.dueThisWeek} due this week`,
  );
  lines.push(`  completion ${bar(stats.done, stats.total, { width: 24 })} ${bold(percent(stats.done, stats.total))} ${count(barLabel(stats.done, stats.total))}`);
  if (stats.avgCompletionHours !== null) {
    const avg = stats.avgCompletionHours;
    const label = avg < 1 ? `${Math.max(1, Math.round(avg * 60))}m` : `${avg}h`;
    lines.push(`  avg time to complete ${bold(label)}`);
  }
  lines.push('');

  lines.push(heading('Streak'));
  lines.push(
    `  current ${bold(green(`${stats.streak.current} day${stats.streak.current === 1 ? '' : 's'}`))}${count(
      ' · ',
    )}longest ${bold(String(stats.streak.longest))}${count(' · ')}last completion ${stats.streak.lastCompletedDay ?? dim('—')}`,
  );
  lines.push('');

  lines.push(heading('Velocity (completions per week)'));
  const values = stats.velocity.map((w) => w.completed);
  if (values.length >= 2) {
    const last = values[values.length - 1];
    const prev = values[values.length - 2];
    lines.push(`  ${sparkline(values)}  ${trend(last, prev)}`);
  } else if (values.length === 1) {
    lines.push(`  ${sparkline(values)}`);
  }
  lines.push(`  ${stats.velocity.map((w) => dim(`${w.label}:`)).join(' ')}${''}`);
  lines.push(`  ${stats.velocity.map((w) => String(w.completed)).join('  ')}`);
  lines.push('');

  const breakdownTable = (title: string, rows: GroupedBreakdown[]): void => {
    if (rows.length === 0) return;
    lines.push(heading(title));
    const keyStyle = (t: string): string =>
      t === 'P0' || t === 'P1' || t === 'P2' || t === 'P3' ? priorityStyle(t) : t;
    const tableRows = rows.slice(0, topN).map((b) => [
      { text: b.key, style: keyStyle },
      { text: String(b.total) },
      { text: String(b.open), style: b.open > 0 ? ((t: string): string => t) : dim },
      { text: String(b.overdue), style: b.overdue > 0 ? red : ((t: string): string => t) },
      { text: percent(b.done, b.total) },
      { text: bar(b.done, b.total, { width: 12 }) },
    ]);
    lines.push(
      ...renderTable(
        [
          { header: 'KEY' },
          { header: 'TOTAL', align: 'right' },
          { header: 'OPEN', align: 'right' },
          { header: 'LATE', align: 'right' },
          { header: 'DONE %', align: 'right' },
          { header: 'PROGRESS' },
        ],
        tableRows,
        { indent: '  ' },
      ),
    );
    lines.push('');
  };

  breakdownTable('By priority', stats.byPriority);
  breakdownTable('By project', stats.byProject);
  breakdownTable('By tag', stats.byTag);

  // Status footer strip.
  const statusStrip = STATUS_KEYS.map((s) => `${s}: ${stats.byStatus[s]}`).join('  ·  ');
  lines.push(dim(statusStrip));
  return lines;
}

/** Re-exports kept for convenience of command modules. */
export { formatTimeOfDay, dueStyle };
