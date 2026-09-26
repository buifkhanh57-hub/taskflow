/**
 * `taskflow reopen <id>…` — send completed tasks back to the todo column.
 *
 * Re-opening clears `completedAt` and stamps `updatedAt`; the task re-enters
 * the normal open backlog and keeps feeding history-based statistics.
 *
 * Examples:
 *
 * ```
 * taskflow reopen 01JT5Z9M
 * taskflow reopen 01JT5Z9M 01JT6A1B
 * ```
 *
 * @packageDocumentation
 */

import type { Task } from '../types.ts';
import { CliError } from '../types.ts';
import { formatISODateTime } from '../dateparse.ts';
import { reopenTask } from '../task.ts';
import { withStore } from '../storage.ts';
import { bold, count, dim, success, yellow } from '../ui/colors.ts';
import { emit, requirePositionals } from './base.ts';

/**
 * Run `taskflow reopen <id-prefix>…`.
 *
 * @returns Process exit code.
 */
export function runReopen(dir: string, argv: readonly string[]): number {
  const selectors = requirePositionals(argv, 1, 'task id (see `taskflow list --done`)');
  const now = new Date();

  const reopened = withStore(
    dir,
    (tasks) => {
      const targets: Task[] = [];
      for (const selector of selectors) {
        const matches = tasks.filter((t) => t.id.toLowerCase().startsWith(selector.toLowerCase()));
        if (matches.length === 0) {
          throw new CliError('TASK_NOT_FOUND', `no task matches "${selector}" — run \`taskflow list --done\` to see ids`);
        }
        if (matches.length > 1) {
          throw new CliError('AMBIGUOUS_ID', `"${selector}" matches ${matches.length} tasks — use more characters`);
        }
        targets.push(matches[0]);
      }
      const byId = new Map(tasks.map((t) => [t.id, t] as const));
      const rows: { after: Task }[] = [];
      for (const target of targets) {
        if (target.status !== 'done') continue;
        const after = reopenTask(target, now);
        byId.set(target.id, after);
        rows.push({ after });
      }
      return { tasks: [...byId.values()], result: rows };
    },
    now,
  );

  const lines: string[] = [];
  for (const row of reopened) {
    lines.push(`${success('↺')} Reopened ${bold(row.after.title)} ${dim(row.after.id.slice(0, 12))} ${dim('· status todo, completion cleared')}`);
  }
  if (reopened.length === 0) {
    lines.push(yellow('Nothing reopened — none of the selected tasks were done.'));
    lines.push(dim('  tip: `taskflow list --done` shows completed task ids.'));
  } else {
    lines.push(
      `${dim('·')} reopened ${bold(String(reopened.length))} task${reopened.length === 1 ? '' : 's'} ${dim(`at ${formatISODateTime(now)}`)}`,
    );
  }
  emit(lines);
  return 0;
}
