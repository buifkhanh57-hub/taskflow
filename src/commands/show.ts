/**
 * `taskflow show <id>` — full detail view for a single task.
 *
 * @packageDocumentation
 */

import { describeDue, recurrenceLabel } from '../dateparse.ts';
import { dueStateOf, estimateLabel } from '../task.ts';
import { requireTask, listAllTasks } from '../storage.ts';
import {
  bold,
  count,
  cyan,
  dim,
  dueStyle,
  green,
  heading,
  magenta,
  priorityStyle,
  red,
  statusStyle,
  warn,
} from '../ui/colors.ts';
import { renderKeyValue } from '../ui/table.ts';
import { emit } from './base.ts';

/**
 * Run `taskflow show <id-prefix>`.
 *
 * @returns Process exit code — 0 on success, 1 when no task matches.
 */
export function runShow(dir: string, argv: readonly string[]): number {
  if (argv.length === 0) {
    emit([
      `${heading('Show a task')}`,
      '',
      '  usage: taskflow show <id-prefix>',
      '',
      '  ids can be given as the full 26-character ULID or any unique prefix',
      '  (usually the first 8 characters shown by `taskflow list`).',
      '',
      '  related: taskflow list · taskflow edit <id> · taskflow done <id>',
    ]);
    return 0;
  }

  const now = new Date();
  const tasks = listAllTasks(dir, now);
  const task = requireTask(tasks, argv[0]);

  const lines: string[] = [];
  const state = dueStateOf(task, now);
  const titlePrefix = task.status === 'done' ? green('✔') : task.status === 'doing' ? cyan('▸') : '○';
  lines.push(`${titlePrefix} ${bold(task.title)} ${count(`· ${statusStyle(task.status)}`)}`);
  lines.push('');

  const labelForPriority = task.priority === 'P0' ? 'urgent' : task.priority === 'P1' ? 'high' : task.priority === 'P2' ? 'normal' : 'low';
  const pairs: [string, string][] = [
    ['id', task.id],
    ['short id', task.id.slice(0, 12)],
    ['priority', `${priorityStyle(task.priority)} ${dim(`(${labelForPriority})`)}`],
    ['project', task.project === null ? dim('—') : magenta(`+${task.project}`)],
    [
      'tags',
      task.tags.length > 0 ? cyan(task.tags.map((t) => `#${t}`).join(' ')) : dim('—'),
    ],
    [
      'due',
      task.due === null ? dim('—') : `${dueStyle(state, task.due)} ${dim(`(${describeDue(task.due, now)})`)}`,
    ],
    ['recurrence', task.recurrence === null ? dim('—') : cyan(recurrenceLabel(task.recurrence))],
    ['estimate', task.estimateMinutes === null ? dim('—') : estimateLabel(task.estimateMinutes)],
    ['created', dim(task.createdAt)],
    ['updated', dim(task.updatedAt)],
    ['completed', task.completedAt === null ? dim('—') : green(task.completedAt)],
  ];
  if (task.recurringParent !== null) {
    pairs.push(['recurring parent', task.recurringParent]);
  }
  lines.push(...renderKeyValue(pairs, { indent: '  ' }));

  if (state === 'overdue') {
    lines.push('');
    lines.push(`  ${warn('⚠ overdue')} ${dim('— complete it with')} taskflow done ${task.id.slice(0, 12)}`);
  }

  if (task.notes.trim().length > 0) {
    lines.push('');
    lines.push(`  ${heading('Notes')}`);
    for (const noteLine of task.notes.trim().split('\n')) {
      lines.push(`    ${noteLine}`);
    }
  }

  const related = tasks.filter(
    (t) => t.id !== task.id && (t.project !== null && t.project === task.project || t.recurringParent === task.id),
  );
  if (related.length > 0) {
    lines.push('');
    lines.push(`  ${heading('Related')} ${count(`(${related.length})`)}`);
    for (const rel of related.slice(0, 5)) {
      lines.push(`    ${dim(rel.id.slice(0, 12))} ${bold(rel.title.slice(0, 48))} ${dim(`· ${rel.status}`)}${red(rel.recurringParent === task.id ? ' · child' : '')}`);
    }
  }

  lines.push('');
  lines.push(dim(`  next: taskflow edit ${task.id.slice(0, 12)} --priority P1 · taskflow done ${task.id.slice(0, 12)}`));
  emit(lines);
  return 0;
}
