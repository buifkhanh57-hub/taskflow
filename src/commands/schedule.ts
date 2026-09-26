/**
 * `taskflow schedule` — the "what needs my attention" board.
 *
 * Renders urgency buckets (overdue / today / tomorrow / rest of week) plus an
 * upcoming horizon. With `--catchup` it also materializes missed occurrences
 * of recurring tasks whose due dates slipped while the app was not run.
 *
 * @packageDocumentation
 */

import { formatISODateTime } from '../dateparse.ts';
import {
  buildReminders,
  catchUpRecurring,
  collectUpcoming,
  recurrencePreview,
  reminderCount,
  renderReminders,
  renderUpcoming,
} from '../scheduler.ts';
import { loadStore, saveStore } from '../storage.ts';
import { flagInt, hasFlag, parseFlags, type FlagSpec } from '../args.ts';
import { bold, count, cyan, dim, green, heading, warn } from '../ui/colors.ts';
import { emit } from './base.ts';

/** Flags accepted by `schedule`. */
const SCHEDULE_FLAGS: FlagSpec[] = [
  { name: 'catchup', kind: 'flag' },
  { name: 'horizon', kind: 'value' },
  { name: 'no-upcoming', kind: 'flag' },
];

/**
 * Run `taskflow schedule`.
 *
 * @returns Process exit code.
 */
export function runSchedule(dir: string, argv: readonly string[]): number {
  const parsed = parseFlags(argv, SCHEDULE_FLAGS);
  const catchup = hasFlag(parsed, 'catchup');
  const horizon = flagInt(parsed, 'horizon', { min: 1, max: 90, fallback: 7 });
  const showUpcoming = !hasFlag(parsed, 'no-upcoming');
  const now = new Date();

  const lines: string[] = [];

  if (catchup) {
    const { store } = loadStore(dir, now);
    const result = catchUpRecurring(store.tasks, now);
    if (result.spawnedTotal > 0 || result.entries.length > 0) {
      store.tasks = result.tasks;
      saveStore(dir, store, now);
    }
    lines.push(`${heading('Catch-up')} ${count(`· ${result.entries.length} recurring template${result.entries.length === 1 ? '' : 's'} processed`)}`);
    if (result.entries.length === 0) {
      lines.push(`  ${green('✓')} no recurring task had slipped past its due date`);
    } else {
      for (const entry of result.entries) {
        lines.push(
          `  ${cyan('↻')} ${dim(entry.templateId.slice(0, 12))} advanced to ${bold(entry.advancedTo)} — ${entry.spawned} occurrence${
            entry.spawned === 1 ? '' : 's'
          } spawned${entry.skipped > 0 ? warn(` · ${entry.skipped} skipped (cap)`) : ''}`,
        );
      }
      lines.push(`  ${dim('·')} ${bold(String(result.spawnedTotal))} new task${result.spawnedTotal === 1 ? '' : 's'} in total ${dim('— saved')}`);
    }
    lines.push('');
  }

  const { store: current } = loadStore(dir, now);
  const buckets = buildReminders(current.tasks, now);
  lines.push(...renderReminders(buckets, now));

  if (showUpcoming) {
    const upcoming = collectUpcoming(current.tasks, now, horizon);
    lines.push('');
    lines.push(`${heading(`Next ${horizon} day${horizon === 1 ? '' : 's'}`)} ${count(`· ${upcoming.length} scheduled`)}`);
    lines.push(...renderUpcoming(upcoming, now));
  }

  const previews = recurrencePreview(current.tasks, now);
  if (previews.length > 0) {
    lines.push('');
    lines.push(`${heading('Recurring')} ${count(`· ${previews.length} active rule${previews.length === 1 ? '' : 's'}`)}`);
    for (const preview of previews.slice(0, 12)) {
      const missed = preview.missed > 0 ? warn(` · ${preview.missed} missed`) : dim(' · up to date');
      lines.push(`  ${dim(preview.task.id.slice(0, 12))} ${preview.task.title.slice(0, 40)} ${dim('→ next')} ${preview.nextDue}${missed}`);
    }
  }

  lines.push('');
  lines.push(dim(`  board generated ${formatISODateTime(now)} · total flagged: ${reminderCount(buckets)}`));
  emit(lines);
  return 0;
}
