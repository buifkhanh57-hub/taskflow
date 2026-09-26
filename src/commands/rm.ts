/**
 * `taskflow rm <id>…` — permanently delete tasks.
 *
 * Removal is all-or-nothing: every selector is resolved first; if any of them
 * matches nothing or is ambiguous, nothing is deleted.
 *
 * @packageDocumentation
 */

import { removeTasks } from '../storage.ts';
import { danger, count, dim, bold } from '../ui/colors.ts';
import { emit, requirePositionals } from './base.ts';

/**
 * Run `taskflow rm <id-prefix>…`.
 *
 * @returns Process exit code.
 */
export function runRm(dir: string, argv: readonly string[]): number {
  const selectors = requirePositionals(argv, 1, 'task id (see `taskflow list --all`)');
  const removed = removeTasks(dir, selectors);

  const lines: string[] = [];
  for (const task of removed) {
    lines.push(`${danger('✗')} Removed ${bold(task.title)} ${dim(task.id.slice(0, 12))}`);
  }
  lines.push(`${dim('·')} deleted ${bold(String(removed.length))} task${removed.length === 1 ? '' : 's'} ${count('— this cannot be undone (backups live in the data dir as tasks.json.bak.*)')}`);
  emit(lines);
  return 0;
}
