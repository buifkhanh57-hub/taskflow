/**
 * `taskflow done <id>…` — complete one or more tasks.
 *
 * Completing a recurring task spawns the next open occurrence automatically
 * so the cycle never drops. `--at` backfills the completion timestamp for
 * tasks that were actually finished earlier (useful after a planning gap).
 *
 * Examples:
 *
 * ```
 * taskflow done 01JT5Z9M
 * taskflow done 01JT5Z9M 01JT6A1B
 * taskflow done 01JT5Z9M --at yesterday
 * ```
 *
 * @packageDocumentation
 */

import type { Task } from '../types.ts';
import { CliError, EXIT_USAGE } from '../types.ts';
import { describeDue, formatISODateTime, parseDue, startOfDay } from '../dateparse.ts';
import { completeTask, dueStateOf } from '../task.ts';
import { withStore } from '../storage.ts';
import { parseFlags, type FlagSpec } from '../args.ts';
import { bold, count, cyan, dim, dueStyle, green, success, yellow } from '../ui/colors.ts';
import { emit, requirePositionals } from './base.ts';

/** Flags accepted by `done`. */
const DONE_FLAGS: FlagSpec[] = [{ name: 'at', kind: 'value' }];

/**
 * Run `taskflow done <id-prefix>…`.
 *
 * @returns Process exit code.
 */
export function runDone(dir: string, argv: readonly string[]): number {
  const parsed = parseFlags(argv, DONE_FLAGS);
  const selectors = requirePositionals(parsed.positional, 1, 'task id (see `taskflow list`)');

  const atRaw = parsed.flags.get('at');
  let completedAt: Date = new Date();
  if (typeof atRaw === 'string') {
    const parsedAt = parseDue(atRaw);
    if (parsedAt === null) {
      throw new CliError('INVALID_DATE', `cannot parse --at value ${JSON.stringify(atRaw)} — try "yesterday" or 2026-01-15`, EXIT_USAGE);
    }
    if (startOfDay(parsedAt).getTime() > startOfDay(new Date()).getTime()) {
      throw new CliError('INVALID_DATE', '--at must not be in the future', EXIT_USAGE);
    }
    completedAt = parsedAt;
  }

  const now = new Date();
  const results = withStore(dir, (tasks) => {
    // Resolve every selector up front: all-or-nothing, no partial completes.
    const targets: Task[] = selectors.map((selector) => {
      const exact = tasks.find((t) => t.id === selector);
      if (exact !== undefined) return exact;
      const prefix = selector.toLowerCase();
      const matches = tasks.filter((t) => t.id.toLowerCase().startsWith(prefix));
      if (matches.length === 0) {
        throw new CliError('TASK_NOT_FOUND', `no task matches "${selector}" — run \`taskflow list\` to see ids`);
      }
      if (matches.length > 1) {
        throw new CliError('AMBIGUOUS_ID', `"${selector}" matches ${matches.length} tasks — use more characters`);
      }
      return matches[0];
    });

    const alreadyDone = targets.filter((t) => t.status === 'done');
    if (alreadyDone.length === targets.length && targets.length === 1) {
      throw new CliError('ALREADY_DONE', `task ${targets[0].id.slice(0, 12)} is already done — see \`taskflow reopen\``);
    }

    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    const completedRows: { task: Task; spawned: Task | null }[] = [];
    for (const target of targets) {
      if (target.status === 'done') continue; // idempotent batch completes
      const result = completeTask(target, completedAt);
      const finalTask = { ...result.task, updatedAt: formatISODateTime(now) };
      byId.set(target.id, finalTask);
      if (result.spawned !== null) {
        byId.set(result.spawned.id, { ...result.spawned, createdAt: formatISODateTime(now), updatedAt: formatISODateTime(now) });
      }
      completedRows.push({ task: finalTask, spawned: result.spawned });
    }
    return { tasks: [...byId.values()], result: completedRows };
  }, now);

  const lines: string[] = [];
  for (const row of results) {
    lines.push(`${success('✓')} Done ${bold(row.task.title)} ${dim(row.task.id.slice(0, 12))}`);
    if (row.spawned !== null) {
      const nextDue = row.spawned.due === null ? '—' : dueStyle(dueStateOf(row.spawned, now), describeDue(row.spawned.due, now));
      lines.push(`  ${cyan('↻')} next occurrence ${bold(row.spawned.title.length > 0 ? row.spawned.title : row.task.title)} ${dim('due')} ${nextDue} ${dim(row.spawned.id.slice(0, 12))}`);
    }
  }
  if (results.length === 0) {
    lines.push(yellow('Nothing to do — every selected task was already done.'));
  } else {
    const spawnedCount = results.filter((r) => r.spawned !== null).length;
    lines.push(
      `${dim('·')} completed ${bold(String(results.length))} task${results.length === 1 ? '' : 's'}${
        spawnedCount > 0 ? count(` · ${spawnedCount} recurring occurrence${spawnedCount === 1 ? '' : 's'} spawned`) : ''
      }`,
    );
  }
  emit(lines);
  return 0;
}
