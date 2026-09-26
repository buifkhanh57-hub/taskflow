/**
 * `taskflow edit <id>` — change fields of an existing task.
 *
 * Positional words after the id replace the title; every field of `add` can
 * be patched through the matching flag. Tags support three modes:
 *
 * - `--tag a,b`       replace the whole tag list
 * - `--add-tag x`     append tags (creating a merged list)
 * - `--rm-tag y`      remove tags from the current list
 *
 * Clearing fields: `--due none`, `--project none`, `--recurrence none`,
 * `--estimate none`, `--notes none`.
 *
 * @packageDocumentation
 */

import type { EditPatch } from '../task.ts';
import { applyEdit } from '../task.ts';
import { parseDue, describeDue } from '../dateparse.ts';
import { normalizeTags } from '../task.ts';
import { listAllTasks, requireTask, withStore } from '../storage.ts';
import { flagList, flagString, parseFlags, type FlagSpec } from '../args.ts';
import { CliError, EXIT_USAGE } from '../types.ts';
import { bold, cyan, dim, dueStyle, green, magenta, success } from '../ui/colors.ts';
import { emit, requirePositionals } from './base.ts';
import { dueStateOf } from '../task.ts';

/** Flags accepted by `edit`. */
const EDIT_FLAGS: FlagSpec[] = [
  { name: 'priority', short: 'p', kind: 'value' },
  { name: 'tag', short: 't', kind: 'list' },
  { name: 'add-tag', kind: 'list' },
  { name: 'rm-tag', kind: 'list' },
  { name: 'project', short: 'j', kind: 'value' },
  { name: 'due', kind: 'value' },
  { name: 'notes', kind: 'value' },
  { name: 'recurrence', short: 'r', kind: 'value' },
  { name: 'estimate', kind: 'value' },
  { name: 'status', kind: 'value' },
];

/** Build the {@link EditPatch} from parsed flags, resolving tag merge modes. */
export function buildEditPatch(
  currentTags: string[],
  parsed: ReturnType<typeof parseFlags>,
): { patch: EditPatch; changes: string[] } {
  const patch: EditPatch = {};
  const changes: string[] = [];

  const priority = flagString(parsed, 'priority');
  if (priority !== undefined) {
    patch.priority = priority;
    changes.push(`priority → ${priority.toUpperCase()}`);
  }

  const status = flagString(parsed, 'status');
  if (status !== undefined) {
    patch.status = status;
    changes.push(`status → ${status.toLowerCase()}`);
  }

  const project = flagString(parsed, 'project');
  if (project !== undefined) {
    patch.project = project;
    changes.push(project === 'none' ? 'project cleared' : `project → ${project.toLowerCase()}`);
  }

  const due = flagString(parsed, 'due');
  if (due !== undefined) {
    if (due === 'none' || due === 'clear' || due === '-') {
      patch.due = null;
      changes.push('due date removed');
    } else {
      const resolved = parseDue(due);
      if (resolved === null) {
        throw new CliError('INVALID_DUE', `cannot parse due date ${JSON.stringify(due)} — try tomorrow, fri, +3d or 2026-01-15`, EXIT_USAGE);
      }
      patch.due = due;
      changes.push(`due → ${resolved.toISOString().slice(0, 10)}`);
    }
  }

  const notes = flagString(parsed, 'notes');
  if (notes !== undefined) {
    patch.notes = notes === 'none' || notes === 'clear' ? null : notes;
    changes.push(notes === null || notes === 'none' || notes === 'clear' ? 'notes cleared' : 'notes updated');
  }

  const recurrence = flagString(parsed, 'recurrence');
  if (recurrence !== undefined) {
    patch.recurrence = recurrence === 'none' || recurrence === 'clear' || recurrence === '-' ? null : recurrence;
    changes.push(recurrence === null ? 'recurrence removed' : `recurrence → ${recurrence.toLowerCase()}`);
  }

  const estimate = flagString(parsed, 'estimate');
  if (estimate !== undefined) {
    patch.estimate = estimate === 'none' || estimate === 'clear' || estimate === '-' ? null : estimate;
    changes.push(estimate === null ? 'estimate cleared' : `estimate → ${estimate.toLowerCase()}`);
  }

  const replaceTags = flagList(parsed, 'tag');
  const addTags = flagList(parsed, 'add-tag');
  const rmTags = flagList(parsed, 'rm-tag').map((t) => t.replace(/^#/, '').toLowerCase());
  if (replaceTags.length > 0) {
    patch.tags = replaceTags;
    changes.push(`tags → ${normalizeTags(replaceTags).map((t) => `#${t}`).join(' ')}`);
  } else if (addTags.length > 0 || rmTags.length > 0) {
    const next = [...currentTags];
    for (const tag of normalizeTags(addTags)) {
      if (!next.includes(tag)) next.push(tag);
    }
    const kept = next.filter((t) => !rmTags.includes(t));
    patch.tags = kept;
    const parts: string[] = [];
    if (addTags.length > 0) parts.push(`+${normalizeTags(addTags).map((t) => `#${t}`).join(' +#')}`);
    if (rmTags.length > 0) parts.push(`-${rmTags.map((t) => `#${t}`).join(' -#')}`);
    changes.push(`tags ${parts.join(' ')}`);
  }

  return { patch, changes };
}

/**
 * Run `taskflow edit <id-prefix> [new title…] [--flags]`.
 *
 * @returns Process exit code.
 */
export function runEdit(dir: string, argv: readonly string[]): number {
  const parsed = parseFlags(argv, EDIT_FLAGS);
  const positionals = requirePositionals(parsed.positional, 1, 'task id');
  const idOrPrefix = positionals[0];
  const titleWords = positionals.slice(1);
  const now = new Date();

  const tasks = listAllTasks(dir, now);
  const target = requireTask(tasks, idOrPrefix);

  const { patch, changes } = buildEditPatch(target.tags, parsed);
  if (titleWords.length > 0) {
    patch.title = titleWords.join(' ');
    changes.push('title updated');
  }
  if (changes.length === 0) {
    throw new CliError(
      'NOTHING_TO_EDIT',
      'nothing to edit — pass a new title or at least one flag (--priority, --tag, --due, …)',
      EXIT_USAGE,
    );
  }

  const { after } = withStore(
    dir,
    (allTasks) => {
      const current = requireTask(allTasks, idOrPrefix);
      const edited = applyEdit(current, patch, now);
      const next = allTasks.map((t) => (t.id === current.id ? edited : t));
      return { tasks: next, result: { before: current, after: edited } };
    },
    now,
  );

  const lines: string[] = [];
  lines.push(`${success('✎')} Updated ${bold(after.title)} ${dim(after.id.slice(0, 12))}`);
  for (const change of changes) lines.push(`  ${dim('·')} ${change}`);
  if (after.due !== null) {
    lines.push(`  ${dim('·')} due now renders as ${dueStyle(dueStateOf(after, now), describeDue(after.due, now))}`);
  }
  const meta: string[] = [];
  if (after.tags.length > 0) meta.push(cyan(after.tags.map((t) => `#${t}`).join(' ')));
  if (after.project !== null) meta.push(magenta(`+${after.project}`));
  if (meta.length > 0) lines.push(`  ${dim('·')} ${meta.join(' ')}`);
  lines.push(dim(`  inspect the result: taskflow show ${after.id.slice(0, 12)}`));
  emit(lines);
  return 0;
}
