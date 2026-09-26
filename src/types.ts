/**
 * Core domain types and vocabulary tables for taskflow.
 *
 * Every module in this project sticks to *erasable* TypeScript syntax only —
 * plain interfaces, type aliases, `as const` lookup tables and ordinary
 * functions/classes. That keeps the sources directly runnable by Node.js
 * (v24+) via type stripping, with no build step required.
 *
 * @packageDocumentation
 */

/** Exit code returned when a command finishes successfully. */
export const EXIT_OK = 0 as const;
/** Exit code returned when an operation fails at runtime (missing task, I/O error, …). */
export const EXIT_ERROR = 1 as const;
/** Exit code returned when the command line itself is invalid. */
export const EXIT_USAGE = 2 as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error type carrying a machine readable `code` and the shell exit code the
 * CLI should surface. All user-facing failures in taskflow raise this class;
 * anything else is treated as an unexpected bug.
 */
export class CliError extends Error {
  /** Stable machine readable identifier, e.g. `TASK_NOT_FOUND`. */
  code: string;
  /** Process exit code the CLI should use (0 ok / 1 error / 2 usage). */
  exitCode: number;

  constructor(code: string, message: string, exitCode: number = EXIT_ERROR) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** Narrow an unknown thrown value into a {@link CliError}. */
export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}

// ---------------------------------------------------------------------------
// Priorities
// ---------------------------------------------------------------------------

/** Task priority levels, from urgent (`P0`) down to low (`P3`). */
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

/** All priority keys in display order. */
export const PRIORITY_KEYS = ['P0', 'P1', 'P2', 'P3'] as const;

/** Human readable metadata attached to a priority level. */
export interface PriorityMeta {
  readonly key: Priority;
  readonly label: string;
  /** Sort weight — lower values sort first. */
  readonly weight: number;
  readonly hint: string;
}

/** Priority vocabulary table. */
export const PRIORITIES: Readonly<Record<Priority, PriorityMeta>> = {
  P0: { key: 'P0', label: 'urgent', weight: 0, hint: 'drop everything else' },
  P1: { key: 'P1', label: 'high', weight: 1, hint: 'this week' },
  P2: { key: 'P2', label: 'normal', weight: 2, hint: 'default priority' },
  P3: { key: 'P3', label: 'low', weight: 3, hint: 'someday / maybe' },
};

/** Type guard: is the value one of the four priority keys? */
export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITY_KEYS as readonly string[]).includes(value);
}

/**
 * Coerce loose user input into a {@link Priority}.
 * Accepts `P0`..`P3` (any case), bare digits `0`..`3` and the label aliases
 * (`urgent`, `high`, `normal`, `low`). Throws a usage {@link CliError} otherwise.
 */
export function normalizePriority(value: unknown): Priority {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3) {
    return ('P' + String(value)) as Priority;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^p?[0-3]$/i.test(trimmed)) return ('P' + trimmed.slice(-1).toUpperCase()) as Priority;
    const lowered = trimmed.toLowerCase();
    for (const key of PRIORITY_KEYS) {
      if (PRIORITIES[key].label === lowered) return key;
    }
  }
  throw new CliError(
    'INVALID_PRIORITY',
    `invalid priority ${JSON.stringify(value)} — expected P0, P1, P2, P3, a digit 0-3 or a label (urgent/high/normal/low)`,
    EXIT_USAGE,
  );
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/** Lifecycle status of a task. */
export type Status = 'todo' | 'doing' | 'done';

/** All status keys in canonical order. */
export const STATUS_KEYS = ['todo', 'doing', 'done'] as const;

/** Metadata attached to a status. */
export interface StatusMeta {
  readonly key: Status;
  readonly label: string;
  /** Single-glyph marker used in compact tables. */
  readonly glyph: string;
  /** Whether tasks with this status count as "open" work. */
  readonly open: boolean;
}

/** Status vocabulary table. */
export const STATUSES: Readonly<Record<Status, StatusMeta>> = {
  todo: { key: 'todo', label: 'to do', glyph: '○', open: true },
  doing: { key: 'doing', label: 'in progress', glyph: '▸', open: true },
  done: { key: 'done', label: 'done', glyph: '✔', open: false },
};

/** Type guard: is the value one of the three status keys? */
export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUS_KEYS as readonly string[]).includes(value);
}

/**
 * Coerce loose status input (including common aliases such as `open`,
 * `complete`, `x`) into a {@link Status}. Throws a usage {@link CliError}
 * when nothing matches.
 */
export function normalizeStatus(value: unknown): Status {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'todo' || v === 'to-do' || v === 'open' || v === 't') return 'todo';
    if (v === 'doing' || v === 'in-progress' || v === 'progress' || v === 'd') return 'doing';
    if (v === 'done' || v === 'complete' || v === 'completed' || v === 'x') return 'done';
  }
  throw new CliError(
    'INVALID_STATUS',
    `invalid status ${JSON.stringify(value)} — expected todo, doing or done`,
    EXIT_USAGE,
  );
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

/** Supported recurrence frequencies. */
export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly';

/** All recurrence frequencies. */
export const RECURRENCE_FREQS = ['daily', 'weekly', 'monthly'] as const;

/** Type guard for {@link RecurrenceFreq}. */
export function isRecurrenceFreq(value: unknown): value is RecurrenceFreq {
  return typeof value === 'string' && (RECURRENCE_FREQS as readonly string[]).includes(value);
}

/**
 * Recurrence rule attached to a task. The next occurrence is computed from the
 * task's `due` date: daily adds `interval` days, weekly adds `interval * 7`
 * days, monthly adds `interval` calendar months with day-of-month clamping.
 */
export interface Recurrence {
  readonly freq: RecurrenceFreq;
  /** Step size, always ≥ 1 (e.g. `every 3 days` → `{ freq: 'daily', interval: 3 }`). */
  readonly interval: number;
}

/** Upper bound accepted for a recurrence interval. */
export const MAX_INTERVAL = 365 as const;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** The central domain record persisted by taskflow. */
export interface Task {
  /** ULID-style identifier (26 Crockford-base32 characters). */
  id: string;
  /** Short single-line summary. */
  title: string;
  /** Optional long description. */
  notes: string;
  /** Lifecycle status. */
  status: Status;
  /** Priority level. */
  priority: Priority;
  /** Lower-cased label list (deduplicated, max 16). */
  tags: string[];
  /** Optional project slug this task belongs to. */
  project: string | null;
  /** Due date as an ISO-8601 local timestamp, or null when undated. */
  due: string | null;
  /** Creation timestamp (ISO-8601). */
  createdAt: string;
  /** Last modification timestamp (ISO-8601). */
  updatedAt: string;
  /** Completion timestamp (ISO-8601), or null while the task is open. */
  completedAt: string | null;
  /** Recurrence rule, or null for one-off tasks. */
  recurrence: Recurrence | null;
  /** Optional size estimate in minutes. */
  estimateMinutes: number | null;
  /** Id of the recurring task this instance was spawned from, if any. */
  recurringParent: string | null;
}

/** Shape of the on-disk `tasks.json` file. */
export interface StoreFile {
  /** Schema version, currently always {@link STORE_VERSION}. */
  version: number;
  /** All tasks, oldest first. */
  tasks: Task[];
  /** ISO timestamp of the last successful save. */
  savedAt: string;
}

/** Current on-disk schema version. */
export const STORE_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Import / export formats
// ---------------------------------------------------------------------------

/** Serialization formats supported by `taskflow export` / `taskflow import`. */
export type ExportFormat = 'csv' | 'json' | 'markdown';

/** All export format names, accepted by the `--format` flag. */
export const EXPORT_FORMATS = ['csv', 'json', 'markdown'] as const;

/** Type guard for {@link ExportFormat}. */
export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && (EXPORT_FORMATS as readonly string[]).includes(value);
}

/** Normalize a format name/alias (`yml`-style tolerance is intentionally small). */
export function normalizeExportFormat(value: string): ExportFormat {
  const v = value.trim().toLowerCase();
  if (v === 'md' || v === 'markdown') return 'markdown';
  if (v === 'csv') return 'csv';
  if (v === 'json') return 'json';
  throw new CliError(
    'INVALID_FORMAT',
    `invalid format ${JSON.stringify(value)} — expected csv, json or markdown`,
    EXIT_USAGE,
  );
}

// ---------------------------------------------------------------------------
// Sorting / filtering
// ---------------------------------------------------------------------------

/** Fields a task list can be sorted by. */
export type SortField =
  | 'due'
  | 'priority'
  | 'created'
  | 'updated'
  | 'completed'
  | 'title'
  | 'status';

/** All sort field names, accepted by the `--sort` flag. */
export const SORT_FIELDS = [
  'due',
  'priority',
  'created',
  'updated',
  'completed',
  'title',
  'status',
] as const;

/** Type guard for {@link SortField}. */
export function isSortField(value: unknown): value is SortField {
  return typeof value === 'string' && (SORT_FIELDS as readonly string[]).includes(value);
}

/** Sort direction. */
export type SortDir = 'asc' | 'desc';

/** How the `--due` filter interprets its argument. */
export type DueMode = 'any' | 'today' | 'tomorrow' | 'week' | 'overdue' | 'none' | 'future' | 'date';

/** All due-filter modes, accepted by the `--due` flag. */
export const DUE_MODES = ['any', 'today', 'tomorrow', 'week', 'overdue', 'none', 'future', 'date'] as const;

/** A structured piece of a free-text query (`#tag`, `+project`, `p1`, `is:done`, …). */
export interface QueryToken {
  readonly kind: 'priority' | 'tag' | 'project' | 'status' | 'text';
  readonly value: string;
  /** True when the token is negated with a leading `!`. */
  readonly negated: boolean;
}

/** Bucket key used by `list --group`. */
export type GroupMode = 'none' | 'project' | 'tag' | 'status' | 'priority';

/** All group modes, accepted by the `--group` flag. */
export const GROUP_MODES = ['none', 'project', 'tag', 'status', 'priority'] as const;

/** Declarative filter describing which tasks a command should operate on. */
export interface Filter {
  /** Empty array = any status; otherwise tasks must have one of these statuses. */
  statuses: Status[];
  /** Empty array = any priority; otherwise tasks must have one of these priorities. */
  priorities: Priority[];
  /** Task tags must include *all* of these. */
  tags: string[];
  /** Task project must be one of these (OR semantics). */
  projects: string[];
  /** Free-text query — every word must appear somewhere in the task. */
  text: string;
  /** Structured query tokens parsed out of {@link Filter.text}. */
  tokens: QueryToken[];
  /** Due-date bucket selection. */
  dueMode: DueMode;
  /** Exact due date (ISO) when {@link Filter.dueMode} is `'date'`. */
  dueDate: string | null;
  /** Sort field. */
  sort: SortField;
  /** Sort direction. */
  dir: SortDir;
  /** Page size cap, or null for unlimited. */
  limit: number | null;
  /** Number of records to skip before the first returned row. */
  offset: number;
  /** Grouping mode for presentation. */
  group: GroupMode;
}

// ---------------------------------------------------------------------------
// Statistics & scheduling snapshots
// ---------------------------------------------------------------------------

/** Completion-streak information. */
export interface StreakInfo {
  /** Consecutive days with at least one completion, ending today or yesterday. */
  current: number;
  /** Best streak ever recorded. */
  longest: number;
  /** ISO day (`YYYY-MM-DD`) of the most recent completion, or null. */
  lastCompletedDay: string | null;
}

/** Completions bucketed by ISO week (Monday-based). */
export interface WeekVelocity {
  /** ISO date of the Monday that starts the bucket. */
  weekStart: string;
  /** Human label, e.g. `Jan 5`. */
  label: string;
  /** Number of tasks completed within the week. */
  completed: number;
}

/** Aggregate row used for per-priority / per-project / per-tag breakdowns. */
export interface GroupedBreakdown {
  /** Bucket key (priority key, project slug or tag). */
  key: string;
  /** Tasks in the bucket. */
  total: number;
  /** Completed tasks in the bucket. */
  done: number;
  /** Open tasks in the bucket. */
  open: number;
  /** Open tasks in the bucket that are past due. */
  overdue: number;
  /** Share of done tasks, 0..1 (0 when the bucket is empty). */
  completionRate: number;
}

/** Full statistics snapshot produced by `taskflow stats`. */
export interface StatsSnapshot {
  /** When the snapshot was computed (ISO). */
  generatedAt: string;
  total: number;
  open: number;
  done: number;
  doing: number;
  /** Open tasks past their due date. */
  overdue: number;
  /** Open tasks due before the end of today. */
  dueToday: number;
  /** Open tasks due within the next 7 days (inclusive). */
  dueThisWeek: number;
  /** done / total, 0..1 (0 when there are no tasks). */
  completionRate: number;
  streak: StreakInfo;
  /** Weekly completion buckets, oldest first. */
  velocity: WeekVelocity[];
  /** Mean hours between creation and completion, or null when unknown. */
  avgCompletionHours: number | null;
  byPriority: GroupedBreakdown[];
  byStatus: Record<Status, number>;
  byProject: GroupedBreakdown[];
  byTag: GroupedBreakdown[];
}

/** Reminder buckets produced by the scheduler. */
export interface ReminderBuckets {
  /** Open tasks whose due date is in the past. */
  overdue: Task[];
  /** Open tasks due before the end of today. */
  today: Task[];
  /** Open tasks due tomorrow. */
  tomorrow: Task[];
  /** Open tasks due within 2..7 days from now. */
  thisWeek: Task[];
}
