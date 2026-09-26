/**
 * `taskflow projects` — inspect and manage project slugs.
 *
 * - `taskflow projects`                breakdown table per project
 * - `taskflow projects rename OLD NEW` move every task to a new slug
 * - `taskflow projects drop OLD`       detach every task from that project
 *
 * @packageDocumentation
 */

import { listAllTasks, withStore } from '../storage.ts';
import { isOverdue, normalizeProject } from '../task.ts';
import { CliError } from '../types.ts';
import { bold, count, cyan, dim, green, heading, magenta, red } from '../ui/colors.ts';
import { bar, percent } from '../ui/progress.ts';
import { renderTable } from '../ui/table.ts';
import { emit } from './base.ts';

/** Shared breakdown row. */
interface Bucket {
  key: string;
  total: number;
  open: number;
  done: number;
  overdue: number;
}

/** Aggregate tasks by a string key (null key → `(none)`). */
function bucketize(tasks: ReturnType<typeof listAllTasks>, keyOf: (t: (typeof tasks)[number]) => string | null, overdueIds: Set<string>): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const task of tasks) {
    const key = keyOf(task) ?? '(none)';
    const b = map.get(key) ?? { key, total: 0, open: 0, done: 0, overdue: 0 };
    b.total += 1;
    if (task.status === 'done') b.done += 1;
    else {
      b.open += 1;
      if (overdueIds.has(task.id)) b.overdue += 1;
    }
    map.set(key, b);
  }
  return [...map.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

/**
 * Run `taskflow projects [rename OLD NEW | drop OLD]`.
 *
 * @returns Process exit code.
 */
export function runProjects(dir: string, argv: readonly string[]): number {
  const now = new Date();
  const action = argv[0] ?? 'list';

  if (action === 'rename' || action === 'drop') {
    const oldRaw = argv[1];
    if (oldRaw === undefined) {
      throw new CliError('MISSING_ARGUMENT', `usage: taskflow projects ${action} <project>${action === 'rename' ? ' <new-name>' : ''}`);
    }
    const oldSlug = normalizeProject(oldRaw);
    if (oldSlug === null) {
      throw new CliError('INVALID_PROJECT', `project ${JSON.stringify(oldRaw)} does not name a project`);
    }
    let newSlug: string | null = null;
    if (action === 'rename') {
      newSlug = normalizeProject(argv[2] ?? '');
      if (newSlug === null) {
        throw new CliError('MISSING_ARGUMENT', 'usage: taskflow projects rename <old> <new>');
      }
    }

    const moved = withStore(
      dir,
      (tasks) => {
        let n = 0;
        const next = tasks.map((task) => {
          if (task.project !== oldSlug) return task;
          n += 1;
          return { ...task, project: newSlug, updatedAt: now.toISOString() };
        });
        return { tasks: next, result: n };
      },
      now,
    );

    const lines: string[] = [];
    if (action === 'rename') {
      lines.push(`✓ Renamed project ${magenta(`+${oldSlug}`)} → ${magenta(`+${newSlug}`)} — ${bold(String(moved))} task${moved === 1 ? '' : 's'} updated`);
    } else {
      lines.push(`✓ Dropped project ${magenta(`+${oldSlug}`)} — ${bold(String(moved))} task${moved === 1 ? '' : 's'} detached`);
    }
    if (moved === 0) lines.push(dim(`  (no task carried the project — nothing changed)`));
    emit(lines);
    return 0;
  }

  // Default: breakdown table.
  const tasks = listAllTasks(dir, now);
  const overdueIds = new Set(tasks.filter((t) => isOverdue(t, now)).map((t) => t.id));
  const buckets = bucketize(tasks, (t) => t.project, overdueIds);

  const lines: string[] = [];
  lines.push(`${heading('Projects')} ${count(`· ${buckets.length} project${buckets.length === 1 ? '' : 's'} · ${tasks.length} task${tasks.length === 1 ? '' : 's'}`)}`);
  if (buckets.length === 0) {
    lines.push(dim('  (no tasks yet — create one with `taskflow add "…" --project my-project`)'));
  } else {
    lines.push('');
    lines.push(
      ...renderTable(
        [
          { header: 'PROJECT' },
          { header: 'TOTAL', align: 'right' },
          { header: 'OPEN', align: 'right' },
          { header: 'LATE', align: 'right' },
          { header: 'DONE %', align: 'right' },
          { header: 'PROGRESS' },
        ],
        buckets.map((b) => [
          { text: b.key === '(none)' ? dim('(no project)') : magenta(`+${b.key}`) },
          { text: String(b.total) },
          { text: String(b.open), style: b.open > 0 ? cyan : dim },
          { text: String(b.overdue), style: b.overdue > 0 ? red : dim },
          { text: percent(b.done, b.total) },
          { text: bar(b.done, b.total, { width: 14 }) },
        ]),
        { indent: '  ' },
      ),
    );
    lines.push('');
    lines.push(dim('  manage: taskflow projects rename <old> <new> · taskflow projects drop <old>'));
    const biggest = buckets.find((b) => b.key !== '(none)' && b.open > 0);
    if (biggest !== undefined) {
      lines.push(dim(`  focus: +${biggest.key} still holds ${biggest.open} open task${biggest.open === 1 ? '' : 's'} (${green(percent(biggest.done, biggest.total))} complete)`));
    }
  }
  emit(lines);
  return 0;
}
