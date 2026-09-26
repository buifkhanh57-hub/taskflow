/**
 * `taskflow search <query>` — relevance-ranked full-text search.
 *
 * Unlike `list`, search scans *every* task (done included) by default and
 * orders hits by a simple relevance score:
 *
 * ```
 * score = 3 × (words matched in title)
 *       + 2 × (words matched in tags)
 *       + 2 × (words matched in project)
 *       + 1 × (words matched in notes)
 * ```
 *
 * Inline query tokens (`#tag`, `+project`, `p1`, `is:done`, `!#noise`) work
 * here too — they narrow the candidate set before the text scoring runs.
 * Matched words are highlighted in the title; a notes snippet is shown when
 * the hit came from the notes body.
 *
 * @packageDocumentation
 */

import type { Task } from '../types.ts';
import { FILTER_FLAGS, applyFilter, parseFilter, parseQueryTokens, textMatches } from '../query.ts';
import { hasFlag, parseFlags } from '../args.ts';
import { listAllTasks } from '../storage.ts';
import { describeDue } from '../dateparse.ts';
import { dueStateOf, shortIdOf, taskText } from '../task.ts';
import { bold, count, cyan, dim, dueStyle, heading, inverse, magenta, priorityStyle, statusGlyph } from '../ui/colors.ts';
import { renderTable, type CellInput } from '../ui/table.ts';
import { emit } from './base.ts';

/** Weight of a title hit. */
const TITLE_WEIGHT = 3;
/** Weight of a tag/project hit. */
const META_WEIGHT = 2;
/** Weight of a notes hit. */
const NOTES_WEIGHT = 1;

/**
 * Relevance score of `task` for the given search words (all of which must
 * match somewhere — callers pre-filter with {@link textMatches}).
 */
export function scoreTask(task: Task, words: readonly string[]): number {
  const title = task.title.toLowerCase();
  const notes = task.notes.toLowerCase();
  const tags = task.tags.join(' ').toLowerCase();
  const project = (task.project ?? '').toLowerCase();
  let score = 0;
  for (const word of words) {
    if (title.includes(word)) score += TITLE_WEIGHT;
    if (tags.includes(word)) score += META_WEIGHT;
    if (project.includes(word)) score += META_WEIGHT;
    if (notes.includes(word)) score += NOTES_WEIGHT;
  }
  return score;
}

/** Highlight every occurrence of every search word inside `text`. */
export function highlight(text: string, words: readonly string[]): string {
  if (words.length === 0) return text;
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const word of words) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(word, from);
      if (idx < 0) break;
      ranges.push([idx, idx + word.length]);
      from = idx + word.length;
    }
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range] as [number, number]);
  }
  let out = '';
  let cursor = 0;
  for (const [start, end] of merged) {
    out += text.slice(cursor, start) + inverse(text.slice(start, end));
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}

/** Extract a short notes snippet around the first matched word. */
export function notesSnippet(task: Task, words: readonly string[], width: number = 60): string | null {
  const notes = task.notes.replace(/\s+/g, ' ').trim();
  if (notes.length === 0) return null;
  const lower = notes.toLowerCase();
  let hit = -1;
  for (const word of words) {
    const idx = lower.indexOf(word);
    if (idx >= 0 && (hit < 0 || idx < hit)) hit = idx;
  }
  if (hit < 0) return null;
  const start = Math.max(0, hit - 20);
  const end = Math.min(notes.length, start + width);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < notes.length ? '…' : '';
  return prefix + notes.slice(start, end) + suffix;
}

/**
 * Run `taskflow search <query…>`.
 *
 * @returns Process exit code.
 */
export function runSearch(dir: string, argv: readonly string[]): number {
  const { filter, text } = parseFilter(argv);
  // Search scans every task by default; only widen/no-op when the caller did
  // not explicitly restrict the status dimension themselves.
  const flagCheck = parseFlags(argv, FILTER_FLAGS);
  if (!hasFlag(flagCheck, 'all') && !hasFlag(flagCheck, 'done') && flagCheck.flags.get('status') === undefined) {
    filter.statuses = [];
  }
  const now = new Date();
  const query = parseQueryTokens(text);
  const words = query.residual.toLowerCase().split(/\s+/).filter((w) => w.length > 0);

  const all = listAllTasks(dir, now);
  const candidates = applyFilter(all, filter, now);
  const hits = candidates
    .filter((task) => (words.length === 0 ? true : textMatches(task, query.residual)))
    .map((task) => ({ task, score: scoreTask(task, words) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.task.due ?? '9999').localeCompare(b.task.due ?? '9999') ||
        a.task.title.localeCompare(b.task.title),
    );

  const lines: string[] = [];
  const termLabel = words.length > 0 ? `"${words.join(' ')}"` : 'all tasks';
  lines.push(`${heading('Search')} ${count(`· ${termLabel} · ${hits.length} hit${hits.length === 1 ? '' : 's'}`)}`);

  if (hits.length === 0) {
    lines.push('');
    lines.push(dim('  (nothing matched — search scans titles, notes, tags and projects)'));
    lines.push(dim('  tip: completed tasks are included by default; use `is:open <words>` to search open work only'));
  } else {
    const rows: CellInput[][] = hits.slice(0, 50).map(({ task, score }) => {
      const due = task.due === null ? dim('—') : dueStyle(dueStateOf(task, now), describeDue(task.due, now));
      const snippet = notesSnippet(task, words);
      const context = snippet === null ? '' : dim(snippet);
      const meta: string[] = [];
      if (task.tags.length > 0) meta.push(cyan(task.tags.map((t) => `#${t}`).join(' ')));
      if (task.project !== null) meta.push(magenta(`+${task.project}`));
      return [
        { text: shortIdOf(task), style: dim },
        { text: statusGlyph(task.status), style: dim },
        { text: priorityStyle(task.priority) },
        { text: highlight(task.title, words), style: bold },
        due,
        meta.join(' '),
        context,
        { text: String(score), style: dim },
      ];
    });
    lines.push(
      ...renderTable(
        [
          { header: 'ID' },
          { header: '•', width: 1 },
          { header: 'PRI' },
          { header: 'TITLE', maxWidth: 44 },
          { header: 'DUE', width: 13 },
          { header: 'META', maxWidth: 22 },
          { header: 'CONTEXT', maxWidth: 42 },
          { header: 'SCORE', align: 'right' },
        ],
        rows,
        { indent: '  ' },
      ),
    );
    if (hits.length > 50) lines.push(dim(`  … ${hits.length - 50} more hits not shown`));
    const best = hits[0];
    lines.push('');
    lines.push(dim(`  best: ${best.task.title} ${dim(`(score ${best.score}) · haystack: ${taskText(best.task).slice(0, 80)}`)}`));
  }
  emit(lines);
  return 0;
}
