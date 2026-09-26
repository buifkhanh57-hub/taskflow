/**
 * `taskflow gantt` — ASCII timeline of the next days.
 *
 * @packageDocumentation
 */

import { renderGantt } from '../gantt.ts';
import { listAllTasks } from '../storage.ts';
import { flagInt, hasFlag, parseFlags, type FlagSpec } from '../args.ts';
import { flagList } from '../args.ts';
import { dim, heading, count } from '../ui/colors.ts';
import { emit } from './base.ts';

/** Flags accepted by `gantt`. */
const GANTT_FLAGS: FlagSpec[] = [
  { name: 'days', kind: 'value' },
  { name: 'project', short: 'j', kind: 'list' },
  { name: 'tag', short: 't', kind: 'list' },
  { name: 'all', kind: 'flag' },
];

/**
 * Run `taskflow gantt`.
 *
 * @returns Process exit code.
 */
export function runGantt(dir: string, argv: readonly string[]): number {
  const parsed = parseFlags(argv, GANTT_FLAGS);
  const days = flagInt(parsed, 'days', { min: 3, max: 31, fallback: 14 });
  const projects = flagList(parsed, 'project').map((p) => p.replace(/^\+/, '').toLowerCase());
  const tags = flagList(parsed, 'tag').map((t) => t.replace(/^#/, '').toLowerCase());
  const onlyOpen = !hasFlag(parsed, 'all');

  const now = new Date();
  let tasks = listAllTasks(dir, now);
  if (onlyOpen) tasks = tasks.filter((t) => t.status !== 'done');
  if (projects.length > 0) tasks = tasks.filter((t) => t.project !== null && projects.includes(t.project));
  if (tags.length > 0) tasks = tasks.filter((t) => tags.every((tag) => t.tags.includes(tag)));

  const lines: string[] = [];
  lines.push(...renderGantt(tasks, now, { days }));
  lines.push('');
  lines.push(
    dim(`  ${heading('Tips')} ${count('· --days 7..31 widens the window · --all includes completed rows · narrow with --project / --tag')}`),
  );
  emit(lines);
  return 0;
}
