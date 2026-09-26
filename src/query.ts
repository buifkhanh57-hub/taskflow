/**
 * Filtering, sorting, grouping and pagination for task lists.
 *
 * Two layers of query power are provided:
 *
 * 1. **Flags** — `--status done`, `--priority P0,P1`, `--tag work`,
 *    `--project api`, `--due week`, `--sort due --desc`, `--limit 20`.
 * 2. **Inline query tokens** inside free text — `#tag`, `+project`,
 *    `p0`..`p3`, `is:done` / `is:open` / `is:doing`, each negatable with a
 *    leading `!` (e.g. `!#someday`).
 *
 * All functions are pure: they take task arrays and return new arrays.
 *
 * @packageDocumentation
 */

import type { DueMode, Filter, GroupMode, Priority, QueryToken, SortDir, SortField, Status, Task } from './types.ts';
import { CliError, EXIT_USAGE, PRIORITIES, PRIORITY_KEYS, STATUS_KEYS, isSortField } from './types.ts';
import type { FlagSpec } from './args.ts';
import { flagInt, flagList, flagString, hasFlag, parseFlags } from './args.ts';
import { parseISODateTime, toDueISO, formatISODateTime } from './dateparse.ts';
import { isOverdue, taskText } from './task.ts';
import { combineFilters, resolvePresetExpression } from './ui/filter-builder.ts';

/** Flag vocabulary shared by `list`, `search` and `export`. */
export const FILTER_FLAGS: FlagSpec[] = [
  { name: 'status', short: 's', kind: 'value' },
  { name: 'priority', short: 'p', kind: 'value' },
  { name: 'tag', short: 't', kind: 'list' },
  { name: 'project', short: 'j', kind: 'value' },
  { name: 'due', kind: 'value' },
  { name: 'overdue', kind: 'flag' },
  { name: 'sort', kind: 'value' },
  { name: 'asc', kind: 'flag' },
  { name: 'desc', kind: 'flag' },
  { name: 'limit', kind: 'value' },
  { name: 'offset', kind: 'value' },
  { name: 'group', short: 'g', kind: 'value' },
  { name: 'all', kind: 'flag' },
  { name: 'done', kind: 'flag' },
  { name: 'compact', kind: 'flag' },
  { name: 'preset', kind: 'value' },
];

/** A filter with taskflow's default presentation settings. */
export function defaultFilter(): Filter {
  return {
    statuses: ['todo', 'doing'],
    priorities: [],
    tags: [],
    projects: [],
    text: '',
    tokens: [],
    dueMode: 'any',
    dueDate: null,
    sort: 'due',
    dir: 'asc',
    limit: null,
    offset: 0,
    group: 'none',
  };
}

/** Interpret a `--due` flag value into `dueMode` + optional anchor date. */
export function parseDueMode(raw: string): { dueMode: DueMode; dueDate: string | null } {
  const v = raw.trim().toLowerCase();
  switch (v) {
    case '':
    case 'any':
    case 'all':
      return { dueMode: 'any', dueDate: null };
    case 'today':
      return { dueMode: 'today', dueDate: null };
    case 'tomorrow':
    case 'tmr':
      return { dueMode: 'tomorrow', dueDate: null };
    case 'week':
    case 'this-week':
    case '7d':
      return { dueMode: 'week', dueDate: null };
    case 'overdue':
      return { dueMode: 'overdue', dueDate: null };
    case 'none':
    case 'undated':
      return { dueMode: 'none', dueDate: null };
    case 'future':
    case 'upcoming':
      return { dueMode: 'future', dueDate: null };
  }
  const parsed = parseISODateTime(raw);
  if (parsed !== null) {
    return { dueMode: 'date', dueDate: toDueISO(parsed) };
  }
  throw new CliError(
    'INVALID_DUE_FILTER',
    `invalid --due value ${JSON.stringify(raw)} — use today, tomorrow, week, overdue, none, future or an ISO date`,
    EXIT_USAGE,
  );
}

/** Validate a `--sort` value. */
export function parseSortField(raw: string): SortField {
  if (!isSortField(raw)) {
    throw new CliError('INVALID_SORT', `invalid --sort ${JSON.stringify(raw)} — use ${'due|priority|created|updated|completed|title|status'}`, EXIT_USAGE);
  }
  return raw;
}

/** Validate a `--group` value. */
export function parseGroupMode(raw: string): GroupMode {
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'none' || v === 'off') return 'none';
  if (v === 'project' || v === 'proj') return 'project';
  if (v === 'tag' || v === 'tags') return 'tag';
  if (v === 'status') return 'status';
  if (v === 'priority' || v === 'pri') return 'priority';
  throw new CliError('INVALID_GROUP', `invalid --group ${JSON.stringify(raw)} — use none, project, tag, status or priority`, EXIT_USAGE);
}

// ---------------------------------------------------------------------------
// Inline query tokens
// ---------------------------------------------------------------------------

export interface ParsedQuery {
  tokens: QueryToken[];
  /** Leftover plain words (the actual text search). */
  residual: string;
}

/**
 * Split a free-text query into structured tokens and residual words.
 *
 * Recognized forms: `#tag`, `+project`, `p0`..`p3`, `is:done|open|doing`,
 * `status:todo|doing|done` — each negatable with `!` (tags/projects only).
 */
export function parseQueryTokens(text: string): ParsedQuery {
  const tokens: QueryToken[] = [];
  const words: string[] = [];
  for (const word of text.split(/\s+/)) {
    const w = word.trim();
    if (w === '') continue;
    let negated = false;
    let body = w;
    if (body.startsWith('!') && body.length > 1) {
      negated = true;
      body = body.slice(1);
    }
    if (body.startsWith('#') && body.length > 1) {
      tokens.push({ kind: 'tag', value: body.slice(1).toLowerCase(), negated });
      continue;
    }
    if (body.startsWith('+') && body.length > 1) {
      tokens.push({ kind: 'project', value: body.slice(1).toLowerCase(), negated });
      continue;
    }
    const pri = /^p([0-3])$/i.exec(body);
    if (pri) {
      tokens.push({ kind: 'priority', value: ('P' + pri[1]) as Priority, negated });
      continue;
    }
    const statusToken = /^(?:is|status):(open|todo|doing|done|complete[d]?)$/i.exec(body);
    if (statusToken) {
      const v = statusToken[1].toLowerCase();
      const value = v === 'open' ? 'todo' : v.startsWith('complete') ? 'done' : v;
      tokens.push({ kind: 'status', value, negated });
      continue;
    }
    words.push(w);
  }
  return { tokens, residual: words.join(' ') };
}

/** True when a single task satisfies one positive token. */
function tokenMatches(task: Task, token: QueryToken): boolean {
  let hit: boolean;
  switch (token.kind) {
    case 'tag':
      hit = task.tags.includes(token.value);
      break;
    case 'project':
      hit = token.value === 'none' ? task.project === null : task.project === token.value;
      break;
    case 'priority':
      hit = task.priority === token.value;
      break;
    case 'status':
      hit = task.status === token.value;
      break;
    default:
      hit = true;
  }
  return token.negated ? !hit : hit;
}

/** True when every word of `text` occurs in the task's searchable text. */
export function textMatches(task: Task, text: string): boolean {
  const hay = taskText(task);
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .every((w) => hay.includes(w));
}

/** Evaluate the due-date portion of a filter. */
export function dueMatch(task: Task, filter: Filter, now: Date): boolean {
  switch (filter.dueMode) {
    case 'any':
      return true;
    case 'none':
      return task.due === null;
    case 'overdue':
      return isOverdue(task, now);
  }
  if (task.due === null) return false;
  const due = parseISODateTime(task.due);
  if (due === null) return false;
  const dueMid = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayDiff = Math.round((dueMid - todayMid) / 86_400_000);
  switch (filter.dueMode) {
    case 'today':
      return dayDiff === 0;
    case 'tomorrow':
      return dayDiff === 1;
    case 'week':
      return dayDiff >= 0 && dayDiff <= 6;
    case 'future':
      return dayDiff >= 0;
    case 'date': {
      if (filter.dueDate === null) return false;
      const anchor = parseISODateTime(filter.dueDate);
      if (anchor === null) return false;
      return (
        due.getFullYear() === anchor.getFullYear() &&
        due.getMonth() === anchor.getMonth() &&
        due.getDate() === anchor.getDate()
      );
    }
    default:
      return true;
  }
}

/** True when a task satisfies every dimension of the filter. */
export function matchTask(task: Task, filter: Filter, now: Date): boolean {
  if (filter.statuses.length > 0 && !filter.statuses.includes(task.status)) return false;
  if (filter.priorities.length > 0 && !filter.priorities.includes(task.priority)) return false;
  if (filter.tags.length > 0 && !filter.tags.every((tag) => task.tags.includes(tag))) return false;
  if (filter.projects.length > 0) {
    const anyProject = filter.projects.some((p) => (p === 'none' ? task.project === null : task.project === p));
    if (!anyProject) return false;
  }
  if (!dueMatch(task, filter, now)) return false;
  if (filter.text !== '' && !textMatches(task, filter.text)) return false;
  for (const token of filter.tokens) {
    if (!tokenMatches(task, token)) return false;
  }
  return true;
}

/** Filter, then return the matching tasks (input order preserved). */
export function applyFilter(tasks: Task[], filter: Filter, now: Date): Task[] {
  return tasks.filter((t) => matchTask(t, filter, now));
}

// ---------------------------------------------------------------------------
// Sorting & pagination
// ---------------------------------------------------------------------------

/** Status ordering weight used by the `status` sort field. */
function statusWeight(status: Status): number {
  return STATUS_KEYS.indexOf(status);
}

/**
 * Stable sort by the requested field. Undated tasks always sink to the bottom
 * for date fields regardless of direction; `--desc` inverts the rest.
 */
export function sortTasks(tasks: Task[], sort: SortField, dir: SortDir): Task[] {
  const indexed = tasks.map((task, index) => ({ task, index }));
  const invert = dir === 'desc' ? -1 : 1;
  indexed.sort((a, b) => {
    const A = a.task;
    const B = b.task;
    const fallback = a.index - b.index;
    switch (sort) {
      case 'due': {
        const aDue = A.due === null ? null : parseISODateTime(A.due);
        const bDue = B.due === null ? null : parseISODateTime(B.due);
        if (aDue === null && bDue === null) return fallback;
        if (aDue === null) return 1; // undated last in both directions
        if (bDue === null) return -1;
        return (aDue.getTime() - bDue.getTime()) * invert || fallback;
      }
      case 'priority':
        return (PRIORITIES[A.priority].weight - PRIORITIES[B.priority].weight) * invert || fallback;
      case 'created':
        return ((parseISODateTime(A.createdAt)?.getTime() ?? 0) - (parseISODateTime(B.createdAt)?.getTime() ?? 0)) * invert || fallback;
      case 'updated':
        return ((parseISODateTime(A.updatedAt)?.getTime() ?? 0) - (parseISODateTime(B.updatedAt)?.getTime() ?? 0)) * invert || fallback;
      case 'completed': {
        const aC = A.completedAt === null ? null : parseISODateTime(A.completedAt);
        const bC = B.completedAt === null ? null : parseISODateTime(B.completedAt);
        if (aC === null && bC === null) return fallback;
        if (aC === null) return 1;
        if (bC === null) return -1;
        return (aC.getTime() - bC.getTime()) * invert || fallback;
      }
      case 'title':
        return A.title.localeCompare(B.title) * invert || fallback;
      case 'status':
        return (statusWeight(A.status) - statusWeight(B.status)) * invert || fallback;
      default:
        return fallback;
    }
  });
  return indexed.map((entry) => entry.task);
}

export interface Page {
  items: Task[];
  total: number;
  offset: number;
  limit: number | null;
}

/** Apply offset/limit to a sorted list. */
export function paginate(tasks: Task[], filter: Filter): Page {
  const offset = Math.max(0, filter.offset);
  const limited = filter.limit !== null && filter.limit > 0 ? tasks.slice(offset, offset + filter.limit) : tasks.slice(offset);
  return { items: limited, total: tasks.length, offset, limit: filter.limit };
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

export interface FilterParseResult {
  filter: Filter;
  /** Positional words not consumed as flags (already token-parsed). */
  text: string;
}

/**
 * Parse an argv slice into a {@link Filter}.
 *
 * The default status filter is `todo + doing` (open work); `--all` widens to
 * every status and `--done` narrows to completed tasks. Positional words are
 * parsed for inline tokens (`#tag`, `+project`, `p1`, `is:done`).
 *
 * `--preset <name[,name…]>` merges named presets (see `ui/filter-builder.ts`)
 * into the flag-derived filter with AND semantics.
 *
 * @param extraFlags Additional command-specific flags that should be accepted
 *                   (and ignored) while parsing, e.g. `--format` on export.
 */
export function parseFilter(argv: readonly string[], now: Date = new Date(), extraFlags: FlagSpec[] = []): FilterParseResult {
  const parsed = parseFlags(argv, [...FILTER_FLAGS, ...extraFlags]);
  let filter = defaultFilter();

  if (hasFlag(parsed, 'all')) {
    filter.statuses = [];
  } else if (hasFlag(parsed, 'done')) {
    filter.statuses = ['done'];
  }
  const statusRaw = flagString(parsed, 'status');
  if (statusRaw !== undefined) {
    filter.statuses = statusRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const norm = s.toLowerCase();
        if (norm === 'todo' || norm === 'doing' || norm === 'done') return norm as Status;
        throw new CliError('INVALID_STATUS', `invalid --status ${JSON.stringify(s)} — use todo, doing or done`, EXIT_USAGE);
      });
  }

  const priRaw = flagString(parsed, 'priority');
  if (priRaw !== undefined) {
    filter.priorities = priRaw
      .split(',')
      .map((p) => p.trim().toUpperCase())
      .filter((p) => p.length > 0)
      .map((p) => {
        if ((PRIORITY_KEYS as readonly string[]).includes(p)) return p as Priority;
        throw new CliError('INVALID_PRIORITY', `invalid --priority ${JSON.stringify(p)} — use P0..P3`, EXIT_USAGE);
      });
  }

  filter.tags = flagList(parsed, 'tag').map((t) => t.replace(/^#/, '').toLowerCase()).filter((t) => t.length > 0);
  filter.projects = flagList(parsed, 'project').map((p) => p.replace(/^\+/, '').toLowerCase()).filter((p) => p.length > 0);

  const dueRaw = flagString(parsed, 'due');
  if (dueRaw !== undefined) {
    const resolved = parseDueMode(dueRaw);
    filter.dueMode = resolved.dueMode;
    filter.dueDate = resolved.dueDate;
  }
  if (hasFlag(parsed, 'overdue')) {
    filter.dueMode = 'overdue';
    filter.dueDate = null;
  }

  const sortRaw = flagString(parsed, 'sort');
  if (sortRaw !== undefined) filter.sort = parseSortField(sortRaw);
  if (hasFlag(parsed, 'desc')) filter.dir = 'desc';
  if (hasFlag(parsed, 'asc')) filter.dir = 'asc';

  filter.limit = flagInt(parsed, 'limit', { min: 1, max: 10_000, fallback: 0 }) || null;
  filter.offset = flagInt(parsed, 'offset', { min: 0, max: 1_000_000, fallback: 0 });
  const groupRaw = flagString(parsed, 'group');
  if (groupRaw !== undefined) filter.group = parseGroupMode(groupRaw);

  const text = parsed.positional.join(' ').replace(/\s+/g, ' ').trim();
  const query = parseQueryTokens(text);
  filter.text = query.residual;

  // Positive inline tokens act like their flag equivalents and are folded
  // into the filter dimensions; negated tokens stay for `!` semantics.
  // `is:done` replaces the untouched open default (otherwise the two cancel
  // out and the filter matches nothing); flags pin it explicitly instead.
  const statusFlagPinned =
    hasFlag(parsed, 'all') || hasFlag(parsed, 'done') || flagString(parsed, 'status') !== undefined;
  const openDefault = filter.statuses.length === 2 && filter.statuses[0] === 'todo' && filter.statuses[1] === 'doing';
  const keptTokens: QueryToken[] = [];
  for (const token of query.tokens) {
    if (!token.negated && token.kind === 'tag') {
      if (!filter.tags.includes(token.value)) filter.tags.push(token.value);
      continue;
    }
    if (!token.negated && token.kind === 'project') {
      if (!filter.projects.includes(token.value)) filter.projects.push(token.value);
      continue;
    }
    if (!token.negated && token.kind === 'priority') {
      if (!filter.priorities.includes(token.value)) filter.priorities.push(token.value);
      continue;
    }
    if (!token.negated && token.kind === 'status' && token.value === 'done' && !statusFlagPinned && openDefault) {
      filter.statuses = ['done'];
      continue;
    }
    keptTokens.push(token);
  }
  filter.tokens = keptTokens;

  const presetRaw = flagString(parsed, 'preset');
  if (presetRaw !== undefined) {
    const presetFilter = resolvePresetExpression(presetRaw);
    // Dimensions the user explicitly pinned via flags win; everything the
    // preset controls and the flags left at their default comes from the
    // preset. Blank out unpinned dimensions first so the intersection below
    // cannot conflict with mere *defaults* (e.g. open-only statuses).
    const statusPinned = hasFlag(parsed, 'all') || hasFlag(parsed, 'done') || flagString(parsed, 'status') !== undefined;
    const duePinned = hasFlag(parsed, 'overdue') || flagString(parsed, 'due') !== undefined;
    const sortPinned = flagString(parsed, 'sort') !== undefined || hasFlag(parsed, 'asc') || hasFlag(parsed, 'desc');
    if (!statusPinned) filter.statuses = [];
    if (!duePinned) {
      filter.dueMode = 'any';
      filter.dueDate = null;
    }
    if (!sortPinned) {
      filter.sort = presetFilter.sort;
      filter.dir = presetFilter.dir;
    }
    filter = combineFilters(filter, presetFilter);
  }

  // referenced to keep `now` meaningful for future extensions (e.g. relative
  // date tokens like due:today parsed with the real clock)
  void now;
  return { filter, text };
}

/** Human-readable one-line description of a filter (used in list headers). */
export function describeFilter(filter: Filter): string {
  const parts: string[] = [];
  if (filter.statuses.length === 0) parts.push('all statuses');
  else if (filter.statuses.length === 2) parts.push('open');
  else parts.push(filter.statuses[0]);
  if (filter.priorities.length > 0) parts.push(`priority: ${filter.priorities.join(',')}`);
  if (filter.tags.length > 0) parts.push(`tags: ${filter.tags.map((t) => `#${t}`).join(' ')}`);
  if (filter.projects.length > 0) {
    parts.push(`project: ${filter.projects.map((p) => (p === 'none' ? p : `+${p}`)).join(' ')}`);
  }
  switch (filter.dueMode) {
    case 'today':
      parts.push('due today');
      break;
    case 'tomorrow':
      parts.push('due tomorrow');
      break;
    case 'week':
      parts.push('due this week');
      break;
    case 'overdue':
      parts.push('overdue');
      break;
    case 'none':
      parts.push('no due date');
      break;
    case 'future':
      parts.push('upcoming');
      break;
    case 'date':
      parts.push(`due ${filter.dueDate ?? ''}`.trim());
      break;
    default:
      break;
  }
  for (const token of filter.tokens) {
    const mark = token.negated ? '!' : '';
    if (token.kind === 'tag') parts.push(`${mark}#${token.value}`);
    else if (token.kind === 'project') parts.push(`${mark}+${token.value}`);
    else parts.push(`${mark}${token.kind}:${token.value}`);
  }
  if (filter.text !== '') parts.push(`"${filter.text}"`);
  parts.push(`sorted by ${filter.sort} (${filter.dir})`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface TaskGroup {
  key: string;
  tasks: Task[];
}

/**
 * Bucket tasks for grouped presentation.
 * `(none)` / `(untagged)` buckets are appended last; other keys sort
 * ascending, except status (todo → doing → done) and priority (P0 → P3).
 */
export function groupTasks(tasks: Task[], mode: GroupMode): TaskGroup[] {
  if (mode === 'none') return [{ key: 'all', tasks }];
  if (mode === 'status') {
    return STATUS_KEYS.map((status) => ({
      key: status,
      tasks: tasks.filter((t) => t.status === status),
    })).filter((g) => g.tasks.length > 0);
  }
  if (mode === 'priority') {
    return PRIORITY_KEYS.map((pri) => ({
      key: pri,
      tasks: tasks.filter((t) => t.priority === pri),
    })).filter((g) => g.tasks.length > 0);
  }
  const buckets = new Map<string, Task[]>();
  const push = (key: string, task: Task): void => {
    const list = buckets.get(key);
    if (list) list.push(task);
    else buckets.set(key, [task]);
  };
  if (mode === 'project') {
    for (const task of tasks) push(task.project ?? '(no project)', task);
  } else {
    for (const task of tasks) {
      if (task.tags.length === 0) push('(untagged)', task);
      else for (const tag of task.tags) push(tag, task);
    }
  }
  return [...buckets.entries()]
    .map(([key, grouped]) => ({ key, tasks: grouped }))
    .sort((a, b) => {
      const aNone = a.key.startsWith('(') ? 1 : 0;
      const bNone = b.key.startsWith('(') ? 1 : 0;
      if (aNone !== bNone) return aNone - bNone;
      return a.key.localeCompare(b.key);
    });
}

/** Re-export for command modules that need to stamp "generated at" headers. */
export { formatISODateTime };
