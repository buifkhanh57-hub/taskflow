/**
 * Task domain logic for taskflow: construction, validation, recurrence
 * arithmetic, completion lifecycle and human-readable rendering.
 *
 * The module is pure (no filesystem access) so it can be unit-tested in
 * isolation and embedded in other tools.
 *
 * @packageDocumentation
 */

import type { Priority, Recurrence, Status, Task } from './types.ts';
import { CliError, EXIT_USAGE, isRecurrenceFreq, normalizePriority, normalizeStatus } from './types.ts';
import {
  addDays,
  addMonths,
  describeDue,
  formatISODateTime,
  parseDue,
  parseISODateTime,
  parseRecurrence,
  recurrenceLabel,
  startOfDay,
  toDueISO,
} from './dateparse.ts';
import { newId, shortId } from './id.ts';
import { SHORT_ID_LEN } from './id.ts';

/** Maximum length of a task title. */
export const TITLE_MAX = 500;
/** Maximum length of the notes field. */
export const NOTES_MAX = 5000;
/** Maximum length of a single tag. */
export const TAG_MAX = 32;
/** Maximum number of tags per task. */
export const MAX_TAGS = 16;
/** Maximum size estimate accepted (10 080 minutes = 7 days). */
export const ESTIMATE_MAX = 10_080;

/** Due-date urgency buckets used for table coloring. */
export type DueState = 'overdue' | 'today' | 'tomorrow' | 'soon' | 'later' | 'none';

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Normalize a single tag: trim, lowercase, strip `#`, spaces become dashes. */
export function normalizeTag(raw: string): string {
  if (typeof raw !== 'string') {
    throw new CliError('INVALID_TAG', 'tags must be strings', EXIT_USAGE);
  }
  const tag = raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._/-]/g, '');
  if (tag.length === 0) {
    throw new CliError('INVALID_TAG', `tag ${JSON.stringify(raw)} is empty after normalization`, EXIT_USAGE);
  }
  if (tag.length > TAG_MAX) {
    throw new CliError('INVALID_TAG', `tag ${JSON.stringify(tag)} exceeds ${TAG_MAX} characters`, EXIT_USAGE);
  }
  return tag;
}

/**
 * Normalize a list of tags from raw CLI input (comma separated string or
 * array), deduplicating while preserving order. Throws when more than
 * {@link MAX_TAGS} distinct tags are supplied.
 */
export function normalizeTags(input: string | string[] | null | undefined): string[] {
  if (input === null || input === undefined) return [];
  const parts = Array.isArray(input)
    ? input.flatMap((t) => String(t).split(','))
    : String(input).split(/[,\s]+/);
  const tags: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const tag = normalizeTag(trimmed);
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_TAGS) {
    throw new CliError('TOO_MANY_TAGS', `a task may carry at most ${MAX_TAGS} tags`, EXIT_USAGE);
  }
  return tags;
}

/**
 * Normalize a project name to a slug, or null when the value is a clearing
 * keyword (`none`, `-`, `null`, empty).
 */
export function normalizeProject(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const trimmed = String(input).trim().toLowerCase();
  if (trimmed === '' || trimmed === 'none' || trimmed === '-' || trimmed === 'null' || trimmed === 'clear') {
    return null;
  }
  const slug = trimmed.replace(/\s+/g, '-').replace(/[^a-z0-9._/-]/g, '');
  if (slug.length === 0) {
    throw new CliError('INVALID_PROJECT', `project ${JSON.stringify(input)} is empty after normalization`, EXIT_USAGE);
  }
  if (slug.length > TAG_MAX) {
    throw new CliError('INVALID_PROJECT', `project name exceeds ${TAG_MAX} characters`, EXIT_USAGE);
  }
  return slug;
}

/**
 * Parse a human size estimate such as `30`, `30m`, `2h`, `2h30m`, `1d`.
 * Returns minutes, or null when the input is empty. Throws a usage error on
 * malformed values.
 */
export function parseEstimateMinutes(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new CliError('INVALID_ESTIMATE', `estimate must be a non-negative number of minutes`, EXIT_USAGE);
    }
    return Math.min(ESTIMATE_MAX, Math.round(input));
  }
  const text = String(input).trim().toLowerCase();
  if (text === '' || text === 'none' || text === '-') return null;
  const combined = /^(\d+)\s*(d|h|m|min|mins|minutes|hours?|hrs?)?$/.exec(text);
  if (combined) {
    const n = Number.parseInt(combined[1], 10);
    const unit = combined[2] ?? 'm';
    const factor = unit === 'd' ? 1440 : unit.startsWith('h') ? 60 : 1;
    return Math.min(ESTIMATE_MAX, n * factor);
  }
  const parts = /^(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*m(?:ins?|inutes?)?$/.exec(text);
  if (parts) {
    const total = Number.parseInt(parts[1], 10) * 60 + Number.parseInt(parts[2], 10);
    return Math.min(ESTIMATE_MAX, total);
  }
  throw new CliError('INVALID_ESTIMATE', `cannot parse estimate ${JSON.stringify(input)} — try 30m, 2h or 2h30m`, EXIT_USAGE);
}

/** Render minutes back into a compact human label (`45m`, `2h`, `2h30m`, `1d`). */
export function estimateLabel(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return '—';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h % 24 === 0 && m === 0 && h >= 24) return `${h / 24}d`;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** Validate and collapse a title string. */
function normalizeTitle(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new CliError('INVALID_TITLE', 'title is required', EXIT_USAGE);
  }
  const title = raw.replace(/\s+/g, ' ').trim();
  if (title.length === 0) {
    throw new CliError('INVALID_TITLE', 'title must not be empty', EXIT_USAGE);
  }
  if (title.length > TITLE_MAX) {
    throw new CliError('INVALID_TITLE', `title exceeds ${TITLE_MAX} characters`, EXIT_USAGE);
  }
  return title;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** Input accepted by {@link createTask}; every field except `title` is optional. */
export interface NewTaskInput {
  title: string;
  notes?: string | null;
  priority?: string | Priority;
  status?: string | Status;
  tags?: string | string[];
  project?: string | null;
  /** Natural-language or ISO due expression; null/undefined leaves the task undated. */
  due?: string | null;
  /** Recurrence rule expression (`weekly`, `every 3 days`, …) or a parsed rule. */
  recurrence?: string | Recurrence | null;
  /** Size estimate (`2h`, `90m`, minutes). */
  estimate?: string | number | null;
  /** Set when the task is a spawned occurrence of a recurring template. */
  recurringParent?: string | null;
}

/** Resolve a recurrence from either raw text or an already-parsed object. */
function coerceRecurrence(input: string | Recurrence | null | undefined): Recurrence | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'string') {
    // Clearing keywords remove the rule instead of failing validation.
    if (['none', 'clear', '-', 'off'].includes(input.trim().toLowerCase())) return null;
    const parsed = parseRecurrence(input);
    if (parsed === null) {
      throw new CliError(
        'INVALID_RECURRENCE',
        `cannot parse recurrence ${JSON.stringify(input)} — try daily, weekly, monthly, biweekly or "every 3 days"`,
        EXIT_USAGE,
      );
    }
    return parsed;
  }
  if (typeof input === 'object' && isRecurrenceFreq((input as Recurrence).freq)) {
    const interval = Math.max(1, Math.floor(Number((input as Recurrence).interval) || 1));
    return { freq: (input as Recurrence).freq, interval };
  }
  throw new CliError('INVALID_RECURRENCE', 'recurrence must be a string expression or rule object', EXIT_USAGE);
}

/**
 * Resolve a due expression (raw text or ISO string) into a due-date string.
 * Relative expressions (`today`, `tomorrow`, `fri`, …) resolve against `now`.
 */
function coerceDue(input: string | null | undefined, now: Date): string | null {
  if (input === null || input === undefined || input === '') return null;
  const direct = parseISODateTime(input);
  if (direct !== null) return toDueISO(direct);
  const parsed = parseDue(input, now);
  if (parsed === null) {
    throw new CliError(
      'INVALID_DUE',
      `cannot parse due date ${JSON.stringify(input)} — try tomorrow, fri, +3d, 2026-01-15 or "friday 3pm"`,
      EXIT_USAGE,
    );
  }
  return toDueISO(parsed);
}

/**
 * Build a fully validated {@link Task}.
 *
 * @throws {CliError} with exit code 2 for invalid titles, priorities, dates,
 * recurrence rules (including a recurrence without a due date) or estimates.
 */
export function createTask(input: NewTaskInput, now: Date = new Date()): Task {
  const title = normalizeTitle(input.title);
  const priority = normalizePriority(input.priority ?? 'P2');
  const status = input.status !== undefined ? normalizeStatus(input.status) : 'todo';
  const tags = normalizeTags(input.tags);
  const project = normalizeProject(input.project ?? null);
  const due = coerceDue(input.due ?? null, now);
  const recurrence = coerceRecurrence(input.recurrence ?? null);
  if (recurrence !== null && due === null) {
    throw new CliError('INVALID_RECURRENCE', 'recurring tasks require a due date to anchor the next occurrence', EXIT_USAGE);
  }
  const estimateMinutes = parseEstimateMinutes(input.estimate ?? null);
  const nowISO = formatISODateTime(now);
  return {
    id: newId(now.getTime()),
    title,
    notes: typeof input.notes === 'string' ? input.notes.slice(0, NOTES_MAX) : '',
    status,
    priority,
    tags,
    project,
    due,
    createdAt: nowISO,
    updatedAt: nowISO,
    completedAt: null,
    recurrence,
    estimateMinutes,
    recurringParent: input.recurringParent ?? null,
  };
}

/** Deep-enough copy of a task (tags array copied too). */
export function cloneTask(task: Task): Task {
  return { ...task, tags: [...task.tags], recurrence: task.recurrence ? { ...task.recurrence } : null };
}

/** Return a copy of the task with a refreshed `updatedAt` timestamp. */
export function touchTask(task: Task, now: Date = new Date()): Task {
  return { ...task, updatedAt: formatISODateTime(now) };
}

// ---------------------------------------------------------------------------
// Recurrence & lifecycle
// ---------------------------------------------------------------------------

/**
 * Compute the due date of the next occurrence after `due`.
 * Daily adds `interval` days, weekly adds `interval * 7` days, monthly adds
 * `interval` calendar months with day-of-month clamping.
 */
export function nextOccurrence(due: Date, rec: Recurrence): Date {
  switch (rec.freq) {
    case 'daily':
      return addDays(due, rec.interval);
    case 'weekly':
      return addDays(due, rec.interval * 7);
    case 'monthly':
      return addMonths(due, rec.interval);
  }
}

export interface CompletionResult {
  /** The completed task (status `done`, `completedAt` stamped). */
  task: Task;
  /**
   * For recurring tasks: a freshly spawned open occurrence with the next due
   * date. Null for one-off tasks.
   */
  spawned: Task | null;
}

/**
 * Mark a task as done. When the task is recurring, a new open instance is
 * spawned for the next occurrence so the cycle never drops.
 */
export function completeTask(task: Task, now: Date = new Date()): CompletionResult {
  const nowISO = formatISODateTime(now);
  const done: Task = { ...task, status: 'done', completedAt: nowISO, updatedAt: nowISO };
  if (task.recurrence === null || task.due === null) {
    return { task: done, spawned: null };
  }
  const dueDate = parseISODateTime(task.due);
  if (dueDate === null) return { task: done, spawned: null };
  const nextDue = toDueISO(nextOccurrence(dueDate, task.recurrence));
  const spawned: Task = {
    ...cloneTask(task),
    id: newId(now.getTime()),
    status: 'todo',
    due: nextDue,
    createdAt: nowISO,
    updatedAt: nowISO,
    completedAt: null,
    recurringParent: task.id,
  };
  return { task: done, spawned };
}

/** Re-open a completed task (clears `completedAt`). */
export function reopenTask(task: Task, now: Date = new Date()): Task {
  const nowISO = formatISODateTime(now);
  return { ...task, status: 'todo', completedAt: null, updatedAt: nowISO };
}

/** Fields that may be changed through {@link applyEdit}. */
export interface EditPatch {
  title?: string;
  notes?: string | null;
  priority?: string | Priority;
  status?: string | Status;
  /** Replacement tag list. */
  tags?: string | string[];
  /** Project slug; `none` clears the project. */
  project?: string | null;
  /** Due expression; `none`/`clear` removes the date. */
  due?: string | null;
  /** Recurrence expression; `none` removes the rule. */
  recurrence?: string | Recurrence | null;
  /** Estimate expression; `none` clears it. */
  estimate?: string | number | null;
}

/**
 * Apply a validated edit patch to a task, returning a new object.
 *
 * @throws {CliError} with exit code 2 when any provided field is invalid.
 */
export function applyEdit(task: Task, patch: EditPatch, now: Date = new Date()): Task {
  const next = cloneTask(task);
  let changed = false;

  if (patch.title !== undefined) {
    next.title = normalizeTitle(patch.title);
    changed = true;
  }
  if (patch.notes !== undefined) {
    next.notes = patch.notes === null ? '' : String(patch.notes).slice(0, NOTES_MAX);
    changed = true;
  }
  if (patch.priority !== undefined) {
    next.priority = normalizePriority(patch.priority);
    changed = true;
  }
  if (patch.status !== undefined) {
    const status = normalizeStatus(patch.status);
    next.status = status;
    next.completedAt = status === 'done' ? (next.completedAt ?? formatISODateTime(now)) : null;
    changed = true;
  }
  if (patch.tags !== undefined) {
    next.tags = normalizeTags(patch.tags);
    changed = true;
  }
  if (patch.project !== undefined) {
    next.project = normalizeProject(patch.project);
    changed = true;
  }
  if (patch.due !== undefined) {
    if (patch.due === null) {
      next.due = null;
    } else {
      // Clearing keywords remove the date; anything else must parse.
      const cleared = ['none', 'clear', '-', 'off'].includes(String(patch.due).trim().toLowerCase());
      next.due = cleared ? null : coerceDue(patch.due, now);
    }
    changed = true;
  }
  if (patch.recurrence !== undefined) {
    next.recurrence = coerceRecurrence(patch.recurrence);
    if (next.recurrence !== null && next.due === null) {
      throw new CliError('INVALID_RECURRENCE', 'recurring tasks require a due date — set one with --due', EXIT_USAGE);
    }
    changed = true;
  }
  if (patch.estimate !== undefined) {
    next.estimateMinutes = parseEstimateMinutes(patch.estimate);
    changed = true;
  }

  if (!changed) return next;
  return { ...next, updatedAt: formatISODateTime(now) };
}

// ---------------------------------------------------------------------------
// Queries & rendering
// ---------------------------------------------------------------------------

/** True when an *open* task's due day has fully passed. */
export function isOverdue(task: Task, now: Date): boolean {
  if (task.status === 'done' || task.due === null) return false;
  const due = parseISODateTime(task.due);
  if (due === null) return false;
  return endOfDayTs(due) < now.getTime();
}

function endOfDayTs(due: Date): number {
  return new Date(due.getFullYear(), due.getMonth(), due.getDate(), 23, 59, 59, 999).getTime();
}

/** Urgency bucket of a task's due date (for coloring). */
export function dueStateOf(task: Task, now: Date): DueState {
  if (task.status === 'done' || task.due === null) return 'none';
  const due = parseISODateTime(task.due);
  if (due === null) return 'none';
  if (endOfDayTs(due) < now.getTime()) return 'overdue';
  const days = Math.round((startOfDay(due).getTime() - startOfDay(now).getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 3) return 'soon';
  return 'later';
}

/** Lower-case haystack used by text search (title, notes, tags, project). */
export function taskText(task: Task): string {
  return [task.title, task.notes, task.tags.join(' '), task.project ?? ''].join(' ').toLowerCase();
}

/** True when `prefix` fully or uniquely-prefix matches the task id. */
export function matchesPrefix(task: Task, idOrPrefix: string): boolean {
  const p = idOrPrefix.trim().toLowerCase();
  return task.id === idOrPrefix || task.id.toLowerCase().startsWith(p);
}

/** Short display id (timestamp + 2 random chars). */
export function shortIdOf(task: Task): string {
  return shortId(task.id, SHORT_ID_LEN);
}

/**
 * Coerce an arbitrary JSON-decoded value into a valid {@link Task}, repairing
 * what can be repaired and defaulting what cannot. Used when loading the
 * store and when importing foreign files — a corrupt record never crashes the
 * app, it becomes a well-formed task (or a reported import error upstream).
 */
export function sanitizeTask(raw: unknown, now: Date = new Date()): Task {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const nowISO = formatISODateTime(now);
  const id = typeof obj.id === 'string' && obj.id.length > 0 ? obj.id : newId(now.getTime());

  let status: Status = 'todo';
  if (typeof obj.status === 'string') {
    try {
      status = normalizeStatus(obj.status);
    } catch {
      status = 'todo';
    }
  }

  let priority: Priority = 'P2';
  if (obj.priority !== undefined) {
    try {
      priority = normalizePriority(obj.priority);
    } catch {
      priority = 'P2';
    }
  }

  const tags = Array.isArray(obj.tags)
    ? normalizeTags(obj.tags.map((t) => String(t)))
    : [];

  const dueRaw = typeof obj.due === 'string' ? parseISODateTime(obj.due) : null;
  const due = dueRaw !== null ? toDueISO(dueRaw) : null;

  let recurrence: Recurrence | null = null;
  if (typeof obj.recurrence === 'string') {
    recurrence = parseRecurrence(obj.recurrence);
  } else if (typeof obj.recurrence === 'object' && obj.recurrence !== null) {
    const r = obj.recurrence as Record<string, unknown>;
    if (isRecurrenceFreq(r.freq)) {
      recurrence = { freq: r.freq, interval: Math.max(1, Math.floor(Number(r.interval) || 1)) };
    }
  }

  const createdRaw = typeof obj.createdAt === 'string' ? parseISODateTime(obj.createdAt) : null;
  const completedRaw = typeof obj.completedAt === 'string' ? parseISODateTime(obj.completedAt) : null;
  const updatedRaw = typeof obj.updatedAt === 'string' ? parseISODateTime(obj.updatedAt) : null;

  const estimate =
    typeof obj.estimateMinutes === 'number' && Number.isFinite(obj.estimateMinutes) && obj.estimateMinutes > 0
      ? Math.min(ESTIMATE_MAX, Math.round(obj.estimateMinutes))
      : null;

  const titleRaw = typeof obj.title === 'string' ? obj.title.replace(/\s+/g, ' ').trim() : '';
  const projectRaw = typeof obj.project === 'string' ? normalizeProject(obj.project) : null;

  return {
    id,
    title: titleRaw.length > 0 ? titleRaw.slice(0, TITLE_MAX) : '(untitled task)',
    notes: typeof obj.notes === 'string' ? obj.notes.slice(0, NOTES_MAX) : '',
    status,
    priority,
    tags,
    project: projectRaw,
    due,
    createdAt: createdRaw !== null ? formatISODateTime(createdRaw) : nowISO,
    updatedAt: updatedRaw !== null ? formatISODateTime(updatedRaw) : nowISO,
    completedAt: status === 'done' && completedRaw !== null ? formatISODateTime(completedRaw) : null,
    recurrence,
    estimateMinutes: estimate,
    recurringParent: typeof obj.recurringParent === 'string' ? obj.recurringParent : null,
  };
}

/**
 * Render the full detail view used by `taskflow show` (plain lines; the
 * command layer adds color).
 */
export function describeTask(task: Task, now: Date): string[] {
  const lines: string[] = [];
  const state = dueStateOf(task, now);
  lines.push(task.title);
  lines.push(`id: ${task.id}`);
  lines.push(`status: ${task.status}`);
  lines.push(`priority: ${task.priority} (${task.priority === 'P0' ? 'urgent' : task.priority === 'P1' ? 'high' : task.priority === 'P2' ? 'normal' : 'low'})`);
  lines.push(`project: ${task.project ?? '—'}`);
  lines.push(`tags: ${task.tags.length > 0 ? task.tags.join(', ') : '—'}`);
  lines.push(`due: ${task.due === null ? '—' : `${task.due} (${describeDue(task.due, now)})`}`);
  lines.push(`recurrence: ${task.recurrence === null ? '—' : recurrenceLabel(task.recurrence)}`);
  lines.push(`estimate: ${estimateLabel(task.estimateMinutes)}`);
  lines.push(`created: ${task.createdAt}`);
  lines.push(`updated: ${task.updatedAt}`);
  lines.push(`completed: ${task.completedAt ?? '—'}`);
  if (task.recurringParent !== null) lines.push(`recurring parent: ${task.recurringParent}`);
  if (state === 'overdue') lines.push('warning: this task is overdue');
  if (task.notes.trim().length > 0) {
    lines.push('notes:');
    for (const line of task.notes.trim().split('\n')) lines.push(`  ${line}`);
  }
  return lines;
}
