/**
 * Scheduler for taskflow: due-date reminders and recurring-task maintenance.
 *
 * Two jobs:
 *
 * 1. **Reminders** — bucket every open task by urgency (overdue / today /
 *    tomorrow / rest of the week) for the `schedule` report.
 * 2. **Catch-up** — when a recurring task's due date has slipped into the
 *    past (the app wasn't run for a while), {@link catchUpRecurring} spawns
 *    one open task per missed occurrence (capped) and advances the template
 *    to its next future date.
 *
 * All functions are pure over the task array; persistence is the caller's job.
 *
 * @packageDocumentation
 */

import type { ReminderBuckets, Task } from './types.ts';
import { addDays, describeDue, formatISODateTime, parseISODateTime, startOfDay, toDueISO } from './dateparse.ts';
import { nextOccurrence, dueStateOf } from './task.ts';
import { newId } from './id.ts';
import { bold, count, danger, dim, priorityStyle, statusGlyph, success, warn, yellow, dueStyle } from './ui/colors.ts';

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/** Largest bucket size before the reminder output truncates its listing. */
export const REMINDER_ROW_LIMIT = 12;

/**
 * Bucket open tasks into reminder groups.
 * Buckets are disjoint: `overdue` (past), `today`, `tomorrow`, then
 * `thisWeek` for the remaining days 2..7.
 */
export function buildReminders(tasks: Task[], now: Date): ReminderBuckets {
  const buckets: ReminderBuckets = { overdue: [], today: [], tomorrow: [], thisWeek: [] };
  const todayMid = startOfDay(now).getTime();
  for (const task of tasks) {
    if (task.status === 'done' || task.due === null) continue;
    const due = parseISODateTime(task.due);
    if (due === null) continue;
    const dueMid = startOfDay(due).getTime();
    const diff = Math.round((dueMid - todayMid) / 86_400_000);
    if (diff < 0) buckets.overdue.push(task);
    else if (diff === 0) buckets.today.push(task);
    else if (diff === 1) buckets.tomorrow.push(task);
    else if (diff <= 7) buckets.thisWeek.push(task);
  }
  const byDue = (a: Task, b: Task): number => (parseISODateTime(a.due ?? '')?.getTime() ?? 0) - (parseISODateTime(b.due ?? '')?.getTime() ?? 0);
  buckets.overdue.sort(byDue);
  buckets.today.sort(byDue);
  buckets.tomorrow.sort(byDue);
  buckets.thisWeek.sort(byDue);
  return buckets;
}

/** Total number of tasks covered by the reminder buckets. */
export function reminderCount(buckets: ReminderBuckets): number {
  return buckets.overdue.length + buckets.today.length + buckets.tomorrow.length + buckets.thisWeek.length;
}

/** Render a single reminder row. */
function reminderRow(task: Task, now: Date): string {
  const glyph = statusGlyph(task.status);
  const pri = priorityStyle(task.priority);
  const due = dueStyle(dueStateOf(task, now), describeDue(task.due, now));
  const meta: string[] = [];
  if (task.tags.length > 0) meta.push(task.tags.map((t) => `#${t}`).join(' '));
  if (task.project !== null) meta.push(`+${task.project}`);
  const metaText = meta.length > 0 ? dim(` · ${meta.join(' ')}`) : '';
  return `  ${dim(glyph)} ${pri} ${task.title} ${dim('—')} ${due}${metaText} ${dim(task.id.slice(0, 12))}`;
}

/** Render one labeled bucket; returns zero lines when the bucket is empty. */
function renderBucket(title: string, tasks: Task[], now: Date, tone: 'danger' | 'warn' | 'info' | 'plain'): string[] {
  if (tasks.length === 0) return [];
  const label = `${title} (${tasks.length})`;
  const styledLabel = tone === 'danger' ? danger(bold(label)) : tone === 'warn' ? warn(bold(label)) : tone === 'info' ? yellow(label) : dim(label);
  const lines = [styledLabel];
  const shown = tasks.slice(0, REMINDER_ROW_LIMIT);
  for (const task of shown) lines.push(reminderRow(task, now));
  if (tasks.length > shown.length) {
    lines.push(dim(`  … and ${tasks.length - shown.length} more`));
  }
  return lines;
}

/** Render the full reminder board used by `taskflow schedule`. */
export function renderReminders(buckets: ReminderBuckets, now: Date): string[] {
  const lines: string[] = [];
  const total = reminderCount(buckets);
  lines.push(`Reminders for ${formatISODateTime(now)} ${count(`— ${total} task${total === 1 ? '' : 's'} need attention`)}`);
  lines.push('');
  lines.push(...renderBucket('⚠ Overdue', buckets.overdue, now, 'danger'));
  lines.push(...renderBucket('Today', buckets.today, now, 'warn'));
  lines.push(...renderBucket('Tomorrow', buckets.tomorrow, now, 'info'));
  lines.push(...renderBucket('Rest of week', buckets.thisWeek, now, 'plain'));
  if (total === 0) {
    lines.push(success('Nothing due — enjoy the calm. ✓'));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Upcoming horizon
// ---------------------------------------------------------------------------

/** One row of the upcoming-horizon view. */
export interface UpcomingItem {
  task: Task;
  due: Date;
  /** Calendar days from today (negative = overdue). */
  daysAway: number;
}

/**
 * Collect open tasks due within `horizonDays` from today (overdue included),
 * sorted by due date.
 */
export function collectUpcoming(tasks: Task[], now: Date, horizonDays: number = 7): UpcomingItem[] {
  const todayMid = startOfDay(now).getTime();
  const items: UpcomingItem[] = [];
  for (const task of tasks) {
    if (task.status === 'done' || task.due === null) continue;
    const due = parseISODateTime(task.due);
    if (due === null) continue;
    const daysAway = Math.round((startOfDay(due).getTime() - todayMid) / 86_400_000);
    if (daysAway <= horizonDays) items.push({ task, due, daysAway });
  }
  items.sort((a, b) => a.due.getTime() - b.due.getTime());
  return items;
}

/** Render the upcoming horizon table (plain rows; caller adds framing). */
export function renderUpcoming(items: UpcomingItem[], now: Date): string[] {
  const lines: string[] = [];
  if (items.length === 0) {
    lines.push(dim('No tasks scheduled in this horizon.'));
    return lines;
  }
  for (const item of items) {
    const pri = priorityStyle(item.task.priority);
    const due = dueStyle(dueStateOf(item.task, now), describeDue(toDueISO(item.due), now));
    const rec = item.task.recurrence !== null ? dim(' ↻') : '';
    lines.push(`  ${due.padEnd(14)}${pri} ${item.task.title}${rec} ${dim(item.task.id.slice(0, 12))}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Recurring catch-up
// ---------------------------------------------------------------------------

/** Safety cap on spawned catch-up instances per template. */
export const CATCH_UP_CAP = 10;

export interface CatchUpEntry {
  templateId: string;
  /** New due date of the template (ISO). */
  advancedTo: string;
  /** Missed occurrences materialized as standalone tasks. */
  spawned: number;
  /** Missed occurrences beyond the cap (already skipped). */
  skipped: number;
}

export interface CatchUpResult {
  /** New task array (templates advanced, spawns appended). */
  tasks: Task[];
  /** Detail rows for reporting. */
  entries: CatchUpEntry[];
  /** Total spawned instances. */
  spawnedTotal: number;
}

/**
 * Advance every open recurring template whose due date lies in the past.
 *
 * For each missed occurrence a standalone open task is spawned (capped at
 * {@link CATCH_UP_CAP} per template); the template itself moves to its next
 * future due date. Completed recurring tasks are left untouched — completing
 * them already spawns the next occurrence via `task.completeTask`.
 */
export function catchUpRecurring(tasks: Task[], now: Date = new Date()): CatchUpResult {
  const nowISO = formatISODateTime(now);
  const todayMid = startOfDay(now).getTime();
  const nextTasks = [...tasks];
  const entries: CatchUpEntry[] = [];
  let spawnedTotal = 0;

  for (let i = 0; i < nextTasks.length; i += 1) {
    const template = nextTasks[i];
    if (template.recurrence === null || template.status === 'done' || template.due === null) continue;
    let due = parseISODateTime(template.due);
    if (due === null) continue;

    const spawns: Task[] = [];
    let skipped = 0;
    let missed = 0;
    while (startOfDay(due).getTime() < todayMid) {
      if (spawns.length < CATCH_UP_CAP) {
        spawns.push({
          ...template,
          tags: [...template.tags],
          recurrence: template.recurrence === null ? null : { ...template.recurrence },
          id: newId(now.getTime()),
          status: 'todo',
          due: toDueISO(due),
          createdAt: nowISO,
          updatedAt: nowISO,
          completedAt: null,
          recurringParent: template.id,
        });
      } else {
        skipped += 1;
      }
      due = nextOccurrence(due, template.recurrence);
      missed += 1;
    }
    if (missed === 0) continue;
    nextTasks[i] = { ...template, due: toDueISO(due), updatedAt: nowISO };
    entries.push({
      templateId: template.id,
      advancedTo: toDueISO(due),
      spawned: spawns.length,
      skipped,
    });
    spawnedTotal += spawns.length;
    nextTasks.push(...spawns);
  }

  return { tasks: nextTasks, entries, spawnedTotal };
}

/**
 * Preview rows for recurring templates: their next due date and how many
 * occurrences were missed as of `now`.
 */
export function recurrencePreview(tasks: Task[], now: Date): { task: Task; nextDue: string; missed: number }[] {
  const todayMid = startOfDay(now).getTime();
  const rows: { task: Task; nextDue: string; missed: number }[] = [];
  for (const task of tasks) {
    if (task.recurrence === null || task.status === 'done' || task.due === null) continue;
    const due = parseISODateTime(task.due);
    if (due === null) continue;
    // Approximate missed-occurrence count from the period length.
    const periodDays =
      task.recurrence.freq === 'daily'
        ? task.recurrence.interval
        : task.recurrence.freq === 'weekly'
          ? task.recurrence.interval * 7
          : task.recurrence.interval * 30;
    const elapsed = Math.floor((todayMid - startOfDay(due).getTime()) / 86_400_000);
    const missed = elapsed > 0 ? Math.floor(elapsed / periodDays) : 0;
    rows.push({ task, nextDue: task.due, missed });
  }
  return rows.sort((a, b) => a.nextDue.localeCompare(b.nextDue));
}
