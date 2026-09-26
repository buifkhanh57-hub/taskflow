/**
 * Composable filter construction for taskflow commands.
 *
 * The {@link Filter} record in `types.ts` is a plain data shape; building one
 * by hand is verbose and easy to get wrong. This module adds three layers on
 * top:
 *
 * 1. **{@link FilterBuilder}** — a chainable builder with named methods
 *    (`withStatus`, `overdueOnly`, `dueWithinDays`, …) and a validated
 *    `build()`.
 * 2. **{@link buildFilter}** — construct a filter from a partial spec object,
 *    normalizing and validating every field (used when filters come from
 *    JSON, presets or embedded hosts).
 * 3. **Presets** — named, reusable filters (`today`, `overdue`, `urgent`, …)
 *    resolvable via {@link resolvePreset} and combinable with
 *    {@link combineFilters}. The CLI exposes them through `--preset`.
 *
 * @packageDocumentation
 */

import type {
  DueMode,
  Filter,
  GroupMode,
  Priority,
  SortDir,
  SortField,
  Status,
} from '../types.ts';
import { CliError, EXIT_USAGE, normalizePriority, normalizeStatus } from '../types.ts';
import { normalizeProject, normalizeTags } from '../task.ts';

// ---------------------------------------------------------------------------
// FilterBuilder
// ---------------------------------------------------------------------------

/**
 * Chainable builder producing a validated {@link Filter}.
 *
 * ```
 * const filter = new FilterBuilder()
 *   .withStatus('todo', 'doing')
 *   .withPriority('P0', 'P1')
 *   .withTags('work')
 *   .dueWithinDays(7)
 *   .sortBy('due', 'asc')
 *   .build();
 * ```
 */
export class FilterBuilder {
  private statuses: Status[] = ['todo', 'doing'];
  private priorities: Priority[] = [];
  private tags: string[] = [];
  private projects: string[] = [];
  private text = '';
  private dueMode: DueMode = 'any';
  private dueDate: string | null = null;
  private sort: SortField = 'due';
  private dir: SortDir = 'asc';
  private limit: number | null = null;
  private offset = 0;
  private group: GroupMode = 'none';

  /** Restrict to the given statuses (empty list = any status). The keyword
   * `open` expands to the todo + doing pair. */
  withStatus(...values: (Status | string)[]): this {
    const next: Status[] = [];
    for (const value of values) {
      const normalized = normalizeStatus(value);
      if (normalized === 'todo' && String(value).trim().toLowerCase() === 'open') {
        next.push('todo', 'doing');
      } else if (!next.includes(normalized)) {
        next.push(normalized);
      }
    }
    this.statuses = next;
    return this;
  }

  /** Accept every status (the `--all` behavior). */
  withAnyStatus(): this {
    this.statuses = [];
    return this;
  }

  /** Restrict to the given priorities (empty list = any priority). */
  withPriority(...values: (Priority | string)[]): this {
    this.priorities = values.map((v) => normalizePriority(v));
    return this;
  }

  /** Require *all* of the given tags on matched tasks. */
  withTags(...values: string[]): this {
    this.tags = [...new Set([...this.tags, ...normalizeTags(values)])];
    return this;
  }

  /** Match tasks in any of the given projects; `none` matches project-less tasks. */
  withProject(...values: string[]): this {
    for (const value of values) {
      const slug = normalizeProject(value);
      if (slug !== null) this.projects.push(slug);
      else this.projects.push('none');
    }
    this.projects = [...new Set(this.projects)];
    return this;
  }

  /** Free-text requirement — every word must occur somewhere in the task. */
  searchText(text: string): this {
    this.text = text.trim();
    return this;
  }

  /** Only tasks due exactly today. */
  dueToday(): this {
    this.dueMode = 'today';
    this.dueDate = null;
    return this;
  }

  /** Only tasks due tomorrow. */
  dueTomorrow(): this {
    this.dueMode = 'tomorrow';
    this.dueDate = null;
    return this;
  }

  /** Open tasks due within the next `days` days (0 = today). */
  dueWithinDays(days: number): this {
    const n = Math.max(0, Math.floor(days));
    this.dueMode = n === 0 ? 'today' : 'week';
    this.dueDate = null;
    return this;
  }

  /** Only tasks whose due date has passed while still open. */
  overdueOnly(): this {
    this.dueMode = 'overdue';
    this.dueDate = null;
    return this;
  }

  /** Only tasks due today or later (overdue excluded). */
  futureOnly(): this {
    this.dueMode = 'future';
    this.dueDate = null;
    return this;
  }

  /** Only tasks without a due date. */
  undated(): this {
    this.dueMode = 'none';
    this.dueDate = null;
    return this;
  }

  /** Reset the due dimension to "any". */
  anyDue(): this {
    this.dueMode = 'any';
    this.dueDate = null;
    return this;
  }

  /** Pin an exact due date (ISO `YYYY-MM-DD`). */
  dueOn(dateISO: string): this {
    this.dueMode = 'date';
    this.dueDate = dateISO;
    return this;
  }

  /** Set sort field and direction. */
  sortBy(field: SortField, dir: SortDir = 'asc'): this {
    this.sort = field;
    this.dir = dir;
    return this;
  }

  /** Cap the number of returned rows. */
  withLimit(limit: number): this {
    this.limit = Math.max(1, Math.floor(limit));
    return this;
  }

  /** Skip the first `offset` rows after sorting. */
  withOffset(offset: number): this {
    this.offset = Math.max(0, Math.floor(offset));
    return this;
  }

  /** Group presentation mode. */
  groupedBy(mode: GroupMode): this {
    this.group = mode;
    return this;
  }

  /** Produce the finished {@link Filter}. */
  build(): Filter {
    return {
      statuses: [...this.statuses],
      priorities: [...this.priorities],
      tags: [...this.tags],
      projects: [...this.projects],
      text: this.text,
      tokens: [],
      dueMode: this.dueMode,
      dueDate: this.dueDate,
      sort: this.sort,
      dir: this.dir,
      limit: this.limit,
      offset: this.offset,
      group: this.group,
    };
  }
}

// ---------------------------------------------------------------------------
// Spec-based construction
// ---------------------------------------------------------------------------

/** Partial, user-facing filter description accepted by {@link buildFilter}. */
export interface FilterSpec {
  statuses?: (Status | string)[];
  priorities?: (Priority | string)[];
  tags?: string | string[];
  projects?: string | string[];
  text?: string;
  dueMode?: DueMode;
  dueDate?: string | null;
  sort?: SortField;
  dir?: SortDir;
  limit?: number | null;
  offset?: number;
  group?: GroupMode;
}

/** Build a filter from a loose spec, validating every provided field.
 * Dimensions the spec leaves out stay unconstrained (e.g. no `statuses`
 * means every status, unlike the CLI's open-by-default). */
export function buildFilter(spec: FilterSpec): Filter {
  const builder = new FilterBuilder();
  if (spec.statuses === undefined) builder.withAnyStatus();
  else builder.withStatus(...spec.statuses);
  if (spec.priorities !== undefined) builder.withPriority(...spec.priorities);
  if (spec.tags !== undefined) builder.withTags(...normalizeTags(spec.tags));
  if (spec.projects !== undefined) {
    const list = Array.isArray(spec.projects) ? spec.projects : [spec.projects];
    builder.withProject(...list);
  }
  if (spec.text !== undefined) builder.searchText(spec.text);
  switch (spec.dueMode) {
    case 'today':
      builder.dueToday();
      break;
    case 'tomorrow':
      builder.dueTomorrow();
      break;
    case 'overdue':
      builder.overdueOnly();
      break;
    case 'none':
      builder.undated();
      break;
    case 'date':
      builder.dueOn(spec.dueDate ?? '');
      break;
    case 'week':
      builder.dueWithinDays(6);
      break;
    case 'future':
      builder.futureOnly();
      break;
    default:
      break;
  }
  if (spec.sort !== undefined) builder.sortBy(spec.sort, spec.dir ?? 'asc');
  else if (spec.dir !== undefined) builder.sortBy('due', spec.dir);
  if (spec.limit !== undefined && spec.limit !== null) builder.withLimit(spec.limit);
  if (spec.offset !== undefined) builder.withOffset(spec.offset);
  if (spec.group !== undefined) builder.groupedBy(spec.group);
  return builder.build();
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** Metadata + factory for a named filter preset. */
export interface FilterPreset {
  /** Short description shown in help output. */
  readonly description: string;
  /** Apply the preset onto a builder (called with a fresh builder). */
  readonly apply: (builder: FilterBuilder) => FilterBuilder;
}

/** Registry of built-in presets, keyed by the `--preset` name. */
export const FILTER_PRESETS: Readonly<Record<string, FilterPreset>> = {
  open: { description: 'tasks not finished yet (todo + doing)', apply: (b) => b.withStatus('todo', 'doing') },
  todo: { description: 'tasks in the todo column', apply: (b) => b.withStatus('todo') },
  doing: { description: 'tasks currently in progress', apply: (b) => b.withStatus('doing') },
  done: { description: 'completed tasks', apply: (b) => b.withStatus('done') },
  today: { description: 'due today', apply: (b) => b.dueToday() },
  tomorrow: { description: 'due tomorrow', apply: (b) => b.dueTomorrow() },
  week: { description: 'due within the next 7 days', apply: (b) => b.dueWithinDays(6) },
  overdue: { description: 'past their due date and still open', apply: (b) => b.overdueOnly() },
  undated: { description: 'no due date at all', apply: (b) => b.undated() },
  urgent: { description: 'priority P0 or P1', apply: (b) => b.withPriority('P0', 'P1') },
  p0: { description: 'priority P0 only', apply: (b) => b.withPriority('P0') },
  p1: { description: 'priority P1 only', apply: (b) => b.withPriority('P1') },
};

/** Sorted preset names (for help output and error messages). */
export function presetNames(): string[] {
  return Object.keys(FILTER_PRESETS).sort();
}

/** Comma-separated `name — description` list of every preset. */
export function describePresets(): string {
  return presetNames()
    .map((name) => `${name} (${FILTER_PRESETS[name].description})`)
    .join(', ');
}

/** Resolve a single preset name into a {@link Filter}. */
export function resolvePreset(name: string): Filter {
  const preset = FILTER_PRESETS[name.trim().toLowerCase()];
  if (preset === undefined) {
    throw new CliError(
      'UNKNOWN_PRESET',
      `unknown preset ${JSON.stringify(name)} — available: ${presetNames().join(', ')}`,
      EXIT_USAGE,
    );
  }
  return preset.apply(new FilterBuilder().withAnyStatus()).build();
}

/**
 * Resolve a whitespace/comma separated preset expression (`"overdue urgent"`)
 * into one filter. Multiple presets are combined with AND semantics via
 * {@link combineFilters}.
 */
export function resolvePresetExpression(raw: string): Filter {
  const names = raw
    .split(/[\s,]+/)
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (names.length === 0) {
    throw new CliError('UNKNOWN_PRESET', '--preset needs at least one preset name', EXIT_USAGE);
  }
  let combined = resolvePreset(names[0]);
  for (let i = 1; i < names.length; i += 1) {
    combined = combineFilters(combined, resolvePreset(names[i]));
  }
  return combined;
}

// ---------------------------------------------------------------------------
// Combining
// ---------------------------------------------------------------------------

/** Strictness ranking for due modes — higher wins when intersecting. */
const DUE_MODE_PRECEDENCE: Readonly<Record<DueMode, number>> = {
  any: 0,
  future: 1,
  none: 1,
  week: 2,
  tomorrow: 3,
  today: 4,
  date: 5,
  overdue: 6,
};

/**
 * Intersect two filters (AND semantics).
 *
 * - status/priority lists intersect; an empty intersection throws
 *   `CONFLICTING_FILTER` because "no status matches" cannot be represented.
 * - tag requirements are unioned (the task must carry all of them).
 * - the stricter due mode wins.
 * - text, tokens, sort, pagination and grouping are concatenated / taken
 *   from `primary`.
 */
export function combineFilters(primary: Filter, secondary: Filter): Filter {
  const intersect = <T>(a: T[], b: T[], what: string): T[] => {
    if (a.length === 0) return [...b];
    if (b.length === 0) return [...a];
    const shared = a.filter((x) => b.includes(x));
    if (shared.length === 0) {
      throw new CliError('CONFLICTING_FILTER', `combined filter has no matching ${what}`, EXIT_USAGE);
    }
    return shared;
  };

  const statuses = intersect(primary.statuses, secondary.statuses, 'statuses');
  const priorities = intersect(primary.priorities, secondary.priorities, 'priorities');

  let dueMode = primary.dueMode;
  if (DUE_MODE_PRECEDENCE[secondary.dueMode] > DUE_MODE_PRECEDENCE[primary.dueMode]) {
    dueMode = secondary.dueMode;
  }
  let dueDate: string | null = primary.dueDate;
  if (dueMode === 'date') {
    dueDate = primary.dueMode === 'date' ? primary.dueDate : secondary.dueDate;
  }

  const projects =
    primary.projects.length === 0
      ? [...secondary.projects]
      : secondary.projects.length === 0
        ? [...primary.projects]
        : [...new Set([...primary.projects, ...secondary.projects])];

  return {
    statuses,
    priorities,
    tags: [...new Set([...primary.tags, ...secondary.tags])],
    projects,
    text: [primary.text, secondary.text].filter((t) => t.length > 0).join(' '),
    tokens: [...primary.tokens, ...secondary.tokens],
    dueMode,
    dueDate,
    sort: primary.sort,
    dir: primary.dir,
    limit: primary.limit ?? secondary.limit,
    offset: primary.offset || secondary.offset,
    group: primary.group !== 'none' ? primary.group : secondary.group,
  };
}
