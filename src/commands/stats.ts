/**
 * `taskflow stats` — portfolio overview with streaks, velocity and breakdowns.
 *
 * @packageDocumentation
 */

import { computeStats, renderStats } from '../stats.ts';
import { listAllTasks, storeInfo } from '../storage.ts';
import { flagInt, flagList, hasFlag, parseFlags, type FlagSpec } from '../args.ts';
import { emit } from './base.ts';

/** Flags accepted by `stats`. */
const STATS_FLAGS: FlagSpec[] = [
  { name: 'json', kind: 'flag' },
  { name: 'weeks', kind: 'value' },
  { name: 'top', kind: 'value' },
  { name: 'project', short: 'j', kind: 'list' },
  { name: 'tag', short: 't', kind: 'list' },
];

/**
 * Run `taskflow stats`.
 *
 * @returns Process exit code.
 */
export function runStats(dir: string, argv: readonly string[]): number {
  const parsed = parseFlags(argv, STATS_FLAGS);
  const json = hasFlag(parsed, 'json');
  const weeks = flagInt(parsed, 'weeks', { min: 1, max: 52, fallback: 8 });
  const top = flagInt(parsed, 'top', { min: 1, max: 50, fallback: 8 });

  const scopeProjects = flagList(parsed, 'project').map((p) => p.replace(/^\+/, '').toLowerCase());
  const scopeTags = flagList(parsed, 'tag').map((t) => t.replace(/^#/, '').toLowerCase());

  const now = new Date();
  let tasks = listAllTasks(dir, now);
  if (scopeProjects.length > 0) tasks = tasks.filter((t) => t.project !== null && scopeProjects.includes(t.project));
  if (scopeTags.length > 0) tasks = tasks.filter((t) => scopeTags.every((tag) => t.tags.includes(tag)));

  const stats = computeStats(tasks, now, { weeks });

  if (json) {
    const info = storeInfo(dir, now);
    emit([JSON.stringify({ stats, store: info }, null, 2)]);
    return 0;
  }

  const lines = renderStats(stats, { topN: top });
  if (scopeProjects.length > 0 || scopeTags.length > 0) {
    const scope: string[] = [];
    if (scopeProjects.length > 0) scope.push(`project ${scopeProjects.map((p) => `+${p}`).join(' ')}`);
    if (scopeTags.length > 0) scope.push(`tags ${scopeTags.map((t) => `#${t}`).join(' ')}`);
    lines.unshift(`scoped to ${scope.join(' and ')} — ${tasks.length} task${tasks.length === 1 ? '' : 's'} in scope`);
  }
  emit(lines);
  return 0;
}
