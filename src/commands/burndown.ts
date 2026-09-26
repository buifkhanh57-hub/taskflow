/**
 * `taskflow burndown` — ASCII burndown of the trailing window.
 *
 * Shows how the open backlog shrank day by day versus the ideal even-burn
 * line. Narrow the scope with `--project` / `--tag` to burndown a single
 * initiative.
 *
 * @packageDocumentation
 */

import { computeBurndown, renderBurndown, burndownToCSV } from '../burndown.ts';
import { listAllTasks } from '../storage.ts';
import { flagInt, flagList, hasFlag, parseFlags, type FlagSpec } from '../args.ts';
import { heading, count, dim } from '../ui/colors.ts';
import { emit } from './base.ts';

/** Flags accepted by `burndown`. */
const BURNDOWN_FLAGS: FlagSpec[] = [
  { name: 'days', kind: 'value' },
  { name: 'project', short: 'j', kind: 'list' },
  { name: 'tag', short: 't', kind: 'list' },
  { name: 'csv', kind: 'flag' },
];

/**
 * Run `taskflow burndown`.
 *
 * @returns Process exit code.
 */
export function runBurndown(dir: string, argv: readonly string[]): number {
  const parsed = parseFlags(argv, BURNDOWN_FLAGS);
  const days = flagInt(parsed, 'days', { min: 3, max: 60, fallback: 14 });
  const projects = flagList(parsed, 'project').map((p) => p.replace(/^\+/, '').toLowerCase());
  const tags = flagList(parsed, 'tag').map((t) => t.replace(/^#/, '').toLowerCase());
  const asCSV = hasFlag(parsed, 'csv');

  const now = new Date();
  let tasks = listAllTasks(dir, now);
  if (projects.length > 0) tasks = tasks.filter((t) => t.project !== null && projects.includes(t.project));
  if (tags.length > 0) tasks = tasks.filter((t) => tags.every((tag) => t.tags.includes(tag)));

  const result = computeBurndown(tasks, now, days);

  if (asCSV) {
    emit([burndownToCSV(result).trimEnd()]);
    return 0;
  }

  const lines: string[] = [];
  const scope: string[] = [];
  if (projects.length > 0) scope.push(projects.map((p) => `+${p}`).join(' '));
  if (tags.length > 0) scope.push(tags.map((t) => `#${t}`).join(' '));
  lines.push(
    `${heading('Burndown')} ${count(`· ${scope.length > 0 ? scope.join(' ') : 'all projects'} · ${tasks.length} task${tasks.length === 1 ? '' : 's'} considered`)}`,
  );
  lines.push('');
  lines.push(...renderBurndown(result, { height: 8 }));
  emit(lines);
  return 0;
}
