/**
 * `taskflow add` — create a new task.
 *
 * Examples:
 *
 * ```
 * taskflow add Fix login redirect -p P0 --tags bug,api --project auth --due tomorrow
 * taskflow add "Write release notes" --due "fri 3pm" --estimate 2h -r weekly
 * taskflow add Review PR #42 --tags review --due +3d --notes "Check the retry logic"
 * ```
 *
 * @packageDocumentation
 */

import type { Task } from '../types.ts';
import { CliError, EXIT_USAGE } from '../types.ts';
import { flagList, flagString, joinPositional, parseFlags } from '../args.ts';
import { createTask, dueStateOf, estimateLabel, shortIdOf, type DueState } from '../task.ts';
import { insertTasks } from '../storage.ts';
import { bold, count, dim, dueStyle, green, priorityStyle, cyan, magenta } from '../ui/colors.ts';
import { describeDue, recurrenceLabel } from '../dateparse.ts';

/** Flags accepted by `add`. */
const ADD_FLAGS = [
  { name: 'priority', short: 'p', kind: 'value' },
  { name: 'tag', short: 't', kind: 'list' },
  { name: 'tags', kind: 'list' },
  { name: 'project', short: 'j', kind: 'value' },
  { name: 'due', kind: 'value' },
  { name: 'notes', kind: 'value' },
  { name: 'recurrence', short: 'r', kind: 'value' },
  { name: 'estimate', kind: 'value' },
  { name: 'status', kind: 'value' },
] as const;

/**
 * Run `taskflow add`.
 *
 * @param dir Data directory.
 * @param argv Arguments after the command name.
 * @returns Process exit code (always 0 unless an error is thrown).
 */
export function runAdd(dir: string, argv: readonly string[]): number {
  const parsed = parseFlags(argv, ADD_FLAGS.map((f) => ({ ...f })));
  const title = joinPositional(parsed, { required: true, what: 'task title (quote it if it contains spaces)' });

  const now = new Date();
  const task: Task = createTask(
    {
      title,
      priority: flagString(parsed, 'priority') ?? 'P2',
      tags: [...flagList(parsed, 'tag'), ...flagList(parsed, 'tags')],
      project: flagString(parsed, 'project') ?? null,
      due: flagString(parsed, 'due') ?? null,
      notes: flagString(parsed, 'notes') ?? '',
      recurrence: flagString(parsed, 'recurrence') ?? null,
      estimate: flagString(parsed, 'estimate') ?? null,
      status: flagString(parsed, 'status'),
    },
    now,
  );
  insertTasks(dir, [task], now);

  printCreated(task, now);
  return 0;
}

/** Styled confirmation block printed after a task is created. */
export function printCreated(task: Task, now: Date): void {
  const lines: string[] = [];
  lines.push(`${green('✓')} Added ${bold(task.title)}`);
  lines.push(`  ${dim('id:')} ${task.id} ${dim(`(short: ${shortIdOf(task)})`)}`);

  const meta: string[] = [];
  meta.push(`priority ${priorityStyle(task.priority)}`);
  if (task.project !== null) meta.push(`project ${magenta(`+${task.project}`)}`);
  if (task.tags.length > 0) meta.push(`tags ${cyan(task.tags.map((t) => `#${t}`).join(' '))}`);
  lines.push(`  ${meta.join(count(' · '))}`);

  const time: string[] = [];
  if (task.due !== null) {
    time.push(`due ${dueStyle(dueStateOf(task, now) as DueState, describeDue(task.due, now))}`);
  } else {
    time.push(dim('no due date'));
  }
  if (task.recurrence !== null) time.push(`repeats ${cyan(recurrenceLabel(task.recurrence))}`);
  if (task.estimateMinutes !== null) time.push(`estimate ${cyan(estimateLabel(task.estimateMinutes))}`);
  lines.push(`  ${time.join(count(' · '))}`);
  if (task.notes.length > 0) lines.push(`  ${dim('notes:')} ${task.notes.replace(/\s+/g, ' ').slice(0, 120)}`);
  lines.push(dim(`  inspect: taskflow show ${shortIdOf(task)} · complete: taskflow done ${shortIdOf(task)}`));
  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * Entry-point guard used by tests: validates that a raw argv slice would
 * produce a usable `add` invocation without touching storage.
 */
export function validateAddArgs(argv: readonly string[]): void {
  const parsed = parseFlags(argv, ADD_FLAGS.map((f) => ({ ...f })));
  const title = joinPositional(parsed, { required: true, what: 'task title' });
  if (title.length === 0) {
    throw new CliError('MISSING_ARGUMENT', 'title must not be empty', EXIT_USAGE);
  }
}
