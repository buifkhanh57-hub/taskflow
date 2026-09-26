/**
 * `taskflow tags` — inspect and manage tag vocabulary.
 *
 * - `taskflow tags`                breakdown table per tag
 * - `taskflow tags rename OLD NEW` re-label a tag on every task
 * - `taskflow tags drop OLD`       remove a tag from every task
 *
 * @packageDocumentation
 */

import { listAllTasks, withStore } from '../storage.ts';
import { normalizeTag, normalizeTags } from '../task.ts';
import { CliError } from '../types.ts';
import { bold, count, cyan, dim, green, heading, red } from '../ui/colors.ts';
import { bar, percent } from '../ui/progress.ts';
import { renderTable } from '../ui/table.ts';
import { emit } from './base.ts';

interface TagBucket {
  key: string;
  total: number;
  open: number;
  done: number;
  overdue: number;
}

/**
 * Run `taskflow tags [rename OLD NEW | drop OLD]`.
 *
 * @returns Process exit code.
 */
export function runTags(dir: string, argv: readonly string[]): number {
  const now = new Date();
  const action = argv[0] ?? 'list';

  if (action === 'rename' || action === 'drop') {
    const oldRaw = argv[1];
    if (oldRaw === undefined) {
      throw new CliError('MISSING_ARGUMENT', `usage: taskflow tags ${action} <tag>${action === 'rename' ? ' <new-name>' : ''}`);
    }
    const oldTag = normalizeTag(oldRaw);
    let newTag: string | null = null;
    if (action === 'rename') {
      if (argv[2] === undefined) {
        throw new CliError('MISSING_ARGUMENT', 'usage: taskflow tags rename <old> <new>');
      }
      newTag = normalizeTags([argv[2]])[0] ?? null;
      if (newTag === null) {
        throw new CliError('INVALID_TAG', `tag ${JSON.stringify(argv[2])} is empty after normalization`);
      }
    }

    const touched = withStore(
      dir,
      (tasks) => {
        let n = 0;
        const next = tasks.map((task) => {
          if (!task.tags.includes(oldTag)) return task;
          n += 1;
          const tags = task.tags.map((t) => (t === oldTag ? newTag : t)).filter((t, i, arr) => t !== null && arr.indexOf(t) === i);
          return { ...task, tags, updatedAt: now.toISOString() };
        });
        return { tasks: next, result: n };
      },
      now,
    );

    const lines: string[] = [];
    if (action === 'rename') {
      lines.push(`✓ Renamed tag ${cyan(`#${oldTag}`)} → ${cyan(`#${newTag}`)} — ${bold(String(touched))} task${touched === 1 ? '' : 's'} updated`);
    } else {
      lines.push(`✓ Dropped tag ${cyan(`#${oldTag}`)} — removed from ${bold(String(touched))} task${touched === 1 ? '' : 's'}`);
    }
    if (touched === 0) lines.push(dim('  (no task carried the tag — nothing changed)'));
    emit(lines);
    return 0;
  }

  // Default: breakdown table (a task counts for every tag it carries).
  const tasks = listAllTasks(dir, now);
  const map = new Map<string, TagBucket>();
  for (const task of tasks) {
    if (task.tags.length === 0) {
      const b = map.get('(untagged)') ?? { key: '(untagged)', total: 0, open: 0, done: 0, overdue: 0 };
      b.total += 1;
      if (task.status === 'done') b.done += 1;
      else b.open += 1;
      map.set('(untagged)', b);
      continue;
    }
    for (const tag of task.tags) {
      const b = map.get(tag) ?? { key: tag, total: 0, open: 0, done: 0, overdue: 0 };
      b.total += 1;
      if (task.status === 'done') b.done += 1;
      else b.open += 1;
      map.set(tag, b);
    }
  }
  const buckets = [...map.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));

  const lines: string[] = [];
  lines.push(`${heading('Tags')} ${count(`· ${buckets.length} distinct · ${tasks.length} task${tasks.length === 1 ? '' : 's'} scanned`)}`);
  if (buckets.length === 0) {
    lines.push(dim('  (no tags yet — try `taskflow add "…" --tag urgent`)'));
  } else {
    lines.push('');
    lines.push(
      ...renderTable(
        [
          { header: 'TAG' },
          { header: 'TASKS', align: 'right' },
          { header: 'OPEN', align: 'right' },
          { header: 'DONE', align: 'right' },
          { header: 'DONE %', align: 'right' },
          { header: 'PROGRESS' },
        ],
        buckets.map((b) => [
          { text: b.key === '(untagged)' ? dim(b.key) : cyan(`#${b.key}`) },
          { text: String(b.total) },
          { text: String(b.open), style: b.open > 0 ? green : dim },
          { text: String(b.done) },
          { text: percent(b.done, b.total) },
          { text: bar(b.done, b.total, { width: 14 }) },
        ]),
        { indent: '  ' },
      ),
    );
    lines.push('');
    lines.push(dim('  manage: taskflow tags rename <old> <new> · taskflow tags drop <old>'));
    lines.push(dim('  filter: taskflow list #<tag> · taskflow list --tag <tag>'));
    const top = buckets.find((b) => b.key !== '(untagged)');
    if (top !== undefined) {
      lines.push(dim(`  busiest: #${top.key} with ${top.total} task${top.total === 1 ? '' : 's'}, ${red(String(top.open))} still open`));
    }
  }
  emit(lines);
  return 0;
}
