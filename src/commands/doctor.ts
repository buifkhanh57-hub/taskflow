/**
 * `taskflow doctor` — store health check.
 *
 * Verifies the data directory and inspects every task for structural
 * problems that the sanitizer cannot produce on its own but that hand edits,
 * crashed sync tools or foreign imports can:
 *
 * - duplicate ids
 * - malformed ids (not 26-char Crockford base32)
 * - open recurring tasks without a due anchor
 * - done tasks without a completion timestamp
 * - open tasks that still carry a completion timestamp
 * - `recurringParent` references pointing at missing tasks
 * - estimated sizes above the 7-day ceiling
 *
 * `--fix` repairs what can be repaired automatically (completion stamps,
 * dangling parent references, oversized estimates) and rewrites the store.
 * The command exits 1 when unresolved problems remain, 0 otherwise.
 *
 * @packageDocumentation
 */

import type { Task } from '../types.ts';
import { ESTIMATE_MAX } from '../task.ts';
import { loadStore, saveStore, storeInfo } from '../storage.ts';
import { isValidId } from '../id.ts';
import { formatISODateTime } from '../dateparse.ts';
import { parseFlags, type FlagSpec } from '../args.ts';
import { bold, count, dim, green, heading, red, warn } from '../ui/colors.ts';
import { emit } from './base.ts';

/** Flags accepted by `doctor`. */
const DOCTOR_FLAGS: FlagSpec[] = [{ name: 'fix', kind: 'flag' }];

/** One finding of the health scan. */
export interface Finding {
  /** Stable check identifier, e.g. `DUPLICATE_ID`. */
  code: string;
  /** `error` blocks the healthy exit code; `warn` is informational. */
  severity: 'error' | 'warn';
  message: string;
  /** Ids of tasks involved (used by `--fix`). */
  ids: string[];
}

/**
 * Scan a task array for structural problems.
 * Exported for tests; `runDoctor` wraps it with filesystem context.
 */
export function scanTasks(tasks: Task[]): Finding[] {
  const findings: Finding[] = [];

  const byId = new Map<string, number>();
  for (const task of tasks) byId.set(task.id, (byId.get(task.id) ?? 0) + 1);
  const duplicates = [...byId.entries()].filter(([, n]) => n > 1);
  if (duplicates.length > 0) {
    findings.push({
      code: 'DUPLICATE_ID',
      severity: 'error',
      message: `${duplicates.length} duplicate id${duplicates.length === 1 ? '' : 's'}: ${duplicates.map(([id]) => id.slice(0, 12)).join(', ')}`,
      ids: duplicates.map(([id]) => id),
    });
  }

  const malformed = tasks.filter((t) => !isValidId(t.id));
  if (malformed.length > 0) {
    findings.push({
      code: 'MALFORMED_ID',
      severity: 'error',
      message: `${malformed.length} task${malformed.length === 1 ? '' : 's'} with a malformed id (expected 26-char Crockford base32)`,
      ids: malformed.map((t) => t.id),
    });
  }

  const noAnchor = tasks.filter((t) => t.recurrence !== null && t.status !== 'done' && t.due === null);
  if (noAnchor.length > 0) {
    findings.push({
      code: 'RECURRENCE_NO_DUE',
      severity: 'error',
      message: `${noAnchor.length} recurring task${noAnchor.length === 1 ? '' : 's'} without a due anchor — recurrence cannot advance`,
      ids: noAnchor.map((t) => t.id),
    });
  }

  const doneNoStamp = tasks.filter((t) => t.status === 'done' && t.completedAt === null);
  if (doneNoStamp.length > 0) {
    findings.push({
      code: 'DONE_WITHOUT_TIMESTAMP',
      severity: 'warn',
      message: `${doneNoStamp.length} done task${doneNoStamp.length === 1 ? '' : 's'} missing completedAt — stats will ignore them`,
      ids: doneNoStamp.map((t) => t.id),
    });
  }

  const openWithStamp = tasks.filter((t) => t.status !== 'done' && t.completedAt !== null);
  if (openWithStamp.length > 0) {
    findings.push({
      code: 'OPEN_WITH_TIMESTAMP',
      severity: 'error',
      message: `${openWithStamp.length} open task${openWithStamp.length === 1 ? '' : 's'} still carrying completedAt`,
      ids: openWithStamp.map((t) => t.id),
    });
  }

  const known = new Set(tasks.map((t) => t.id));
  const orphanParents = tasks.filter((t) => t.recurringParent !== null && !known.has(t.recurringParent));
  if (orphanParents.length > 0) {
    findings.push({
      code: 'ORPHAN_RECURRING_PARENT',
      severity: 'warn',
      message: `${orphanParents.length} spawned task${orphanParents.length === 1 ? '' : 's'} whose template no longer exists`,
      ids: orphanParents.map((t) => t.id),
    });
  }

  const oversized = tasks.filter((t) => t.estimateMinutes !== null && t.estimateMinutes > ESTIMATE_MAX);
  if (oversized.length > 0) {
    findings.push({
      code: 'ESTIMATE_OVERFLOW',
      severity: 'warn',
      message: `${oversized.length} task${oversized.length === 1 ? '' : 's'} with an estimate above the ${ESTIMATE_MAX} minute ceiling`,
      ids: oversized.map((t) => t.id),
    });
  }

  return findings;
}

/** Apply automatic repairs; returns the fixed task array and a change log. */
export function applyFixes(tasks: Task[], now: Date): { tasks: Task[]; fixed: string[] } {
  const nowISO = formatISODateTime(now);
  const known = new Set(tasks.map((t) => t.id));
  const fixed: string[] = [];
  const next = tasks.map((task) => {
    let out = task;
    if (task.status === 'done' && task.completedAt === null) {
      out = { ...out, completedAt: task.updatedAt || nowISO };
      fixed.push(`stamped completedAt on "${task.title.slice(0, 40)}"`);
    }
    if (task.status !== 'done' && task.completedAt !== null) {
      out = { ...out, completedAt: null };
      fixed.push(`cleared stray completedAt on "${task.title.slice(0, 40)}"`);
    }
    if (task.recurringParent !== null && !known.has(task.recurringParent)) {
      out = { ...out, recurringParent: null };
      fixed.push(`detached orphan spawn "${task.title.slice(0, 40)}"`);
    }
    if (task.estimateMinutes !== null && task.estimateMinutes > ESTIMATE_MAX) {
      out = { ...out, estimateMinutes: ESTIMATE_MAX };
      fixed.push(`clamped estimate of "${task.title.slice(0, 40)}" to ${ESTIMATE_MAX}m`);
    }
    return out;
  });
  return { tasks: next, fixed };
}

/**
 * Run `taskflow doctor [--fix]`.
 *
 * @returns 0 when healthy (or fully fixed), 1 when errors remain.
 */
export function runDoctor(dir: string, argv: readonly string[]): number {
  const parsed = parseFlags(argv, DOCTOR_FLAGS);
  const fix = parsed.flags.get('fix') === true;
  const now = new Date();

  const info = storeInfo(dir, now);
  const lines: string[] = [];
  lines.push(`${heading('Doctor')} ${count(`· ${dir}`)}`);

  if (!info.exists) {
    lines.push(`  ${warn('⚠')} no store yet at ${info.path} — first use creates it`);
    emit(lines);
    return 0;
  }
  lines.push(`  ${green('✓')} store found ${dim(`(${info.bytes} bytes, ${info.backups.length} backup${info.backups.length === 1 ? '' : 's'}, schema v1)`)}`);
  if (info.corruptFiles.length > 0) {
    lines.push(`  ${warn('⚠')} ${info.corruptFiles.length} quarantined file${info.corruptFiles.length === 1 ? '' : 's'}: ${info.corruptFiles.join(', ')}`);
  }

  const { store, warning } = loadStore(dir, now);
  if (warning !== null) {
    lines.push(`  ${warn('⚠')} ${warning}`);
  }
  lines.push(`  ${green('✓')} parsed ${bold(String(store.tasks.length))} task${store.tasks.length === 1 ? '' : 's'} (savedAt ${store.savedAt === '' ? dim('never') : store.savedAt})`);

  let findings = scanTasks(store.tasks);
  if (fix) {
    const result = applyFixes(store.tasks, now);
    if (result.fixed.length > 0) {
      store.tasks = result.tasks;
      saveStore(dir, store, now);
      findings = scanTasks(store.tasks);
      lines.push(`  ${green('✓')} applied ${result.fixed.length} fix${result.fixed.length === 1 ? '' : 'es'} and saved:`);
      for (const entry of result.fixed.slice(0, 10)) lines.push(`      ${dim('·')} ${entry}`);
    } else {
      lines.push(`  ${dim('·')} --fix had nothing to repair`);
    }
  }

  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warn');
  if (findings.length === 0) {
    lines.push(`  ${green('✓')} structure check passed — no duplicates, dangling references or inconsistent lifecycle states`);
    lines.push(dim('  all systems nominal'));
    emit(lines);
    return 0;
  }
  lines.push('');
  for (const finding of findings) {
    const icon = finding.severity === 'error' ? red('✗') : warn('⚠');
    lines.push(`  ${icon} ${bold(finding.code)} ${dim('·')} ${finding.message}`);
  }
  lines.push('');
  lines.push(
    errors.length > 0
      ? red(`${bold(String(errors.length))} error${errors.length === 1 ? '' : 's'} · ${warnings.length} warning${warnings.length === 1 ? '' : 's'} — rerun with --fix where possible`)
      : warn(`${warnings.length} warning${warnings.length === 1 ? '' : 's'} only — store is usable`),
  );
  emit(lines);
  return errors.length > 0 ? 1 : 0;
}
