/**
 * `taskflow import <file>` — load tasks from CSV / JSON / Markdown.
 *
 * The format is detected from the file extension, falling back to content
 * sniffing. Rows are sanitized through the same pipeline the store uses, so
 * hand-edited or foreign files cannot corrupt the database — individual bad
 * rows are reported and skipped.
 *
 * Merge semantics:
 * - default   — merge by id: new ids are added, existing ids are kept
 * - `--replace-existing` — incoming records overwrite matching ids
 * - `--replace` — the whole store is replaced by the file contents
 * - `--dry-run` — validate and report without writing anything
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs';
import type { ExportFormat } from '../types.ts';
import { CliError, isExportFormat } from '../types.ts';
import { listAllTasks, mergeTasks, replaceTasks } from '../storage.ts';
import { sniffFormat } from '../serialize.ts';
import { parseFlags, type FlagSpec } from '../args.ts';
import { bold, count, dim, green, warn } from '../ui/colors.ts';
import { emit, emitError } from './base.ts';
import { parseFor } from './export.ts';

/** Flags accepted by `import`. */
const IMPORT_FLAGS: FlagSpec[] = [
  { name: 'format', short: 'f', kind: 'value' },
  { name: 'replace', kind: 'flag' },
  { name: 'replace-existing', kind: 'flag' },
  { name: 'dry-run', kind: 'flag' },
];

/** Resolve the import format: explicit flag → extension → content sniffing. */
export function resolveImportFormat(filePath: string, content: string, explicit?: string): ExportFormat {
  if (explicit !== undefined && explicit.trim() !== '') {
    const v = explicit.trim().toLowerCase();
    if (!isExportFormat(v)) {
      throw new CliError('INVALID_FORMAT', `unsupported import format ${JSON.stringify(explicit)} — use csv, json or markdown`);
    }
    return v;
  }
  const sniffed = sniffFormat(filePath, content);
  if (sniffed === 'unknown') {
    throw new CliError('UNKNOWN_FORMAT', `cannot detect format of ${filePath} — pass --format csv|json|markdown`);
  }
  return sniffed;
}

/**
 * Run `taskflow import <file>`.
 *
 * @returns Process exit code — 1 when the file produced zero tasks and errors.
 */
export function runImport(dir: string, argv: readonly string[]): number {
  const parsed = parseFlags(argv, IMPORT_FLAGS);
  const files = parsed.positional.filter((p) => p.trim().length > 0);
  if (files.length === 0) {
    throw new CliError('MISSING_ARGUMENT', 'usage: taskflow import <file> [--format csv|json|markdown] [--replace|--replace-existing] [--dry-run]');
  }

  const replaceAll = parsed.flags.get('replace') === true;
  const replaceExisting = parsed.flags.get('replace-existing') === true;
  const dryRun = parsed.flags.get('dry-run') === true;
  const explicitFormat = typeof parsed.flags.get('format') === 'string' ? (parsed.flags.get('format') as string) : undefined;
  const now = new Date();

  const allTasks = [];
  const allErrors: string[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new CliError('FILE_UNREADABLE', `cannot read ${file}: ${(err as Error).message}`);
    }
    const format = resolveImportFormat(file, content, explicitFormat);
    const report = parseFor(format, content, now);
    allTasks.push(...report.tasks);
    allErrors.push(...report.errors.map((e) => `${file}: ${e}`));
  }

  const lines: string[] = [];
  lines.push(`${bold('Import')} ${count(`· ${files.length} file${files.length === 1 ? '' : 's'} · ${allTasks.length} task${allTasks.length === 1 ? '' : 's'} parsed`)}`);
  if (allErrors.length > 0) {
    lines.push(`  ${warn('⚠')} ${allErrors.length} problem${allErrors.length === 1 ? '' : 's'}:`);
    for (const err of allErrors.slice(0, 10)) lines.push(`    ${dim(err)}`);
    if (allErrors.length > 10) lines.push(dim(`    … and ${allErrors.length - 10} more`));
  }

  if (allTasks.length === 0) {
    emit(lines);
    emitError(warn(`no tasks could be imported from ${files.join(', ')}`));
    return 1;
  }

  if (dryRun) {
    const wouldAdd = replaceAll ? 'store would be REPLACED' : 'merge planned';
    lines.push(`  ${dim('dry run:')} no changes written — ${wouldAdd}`);
    emit(lines);
    return 0;
  }

  if (replaceAll) {
    const previous = listAllTasks(dir, now).length;
    replaceTasks(dir, allTasks, now);
    lines.push(`  ${green('✓')} store replaced — ${bold(String(previous))} previous task${previous === 1 ? '' : 's'} → ${bold(String(allTasks.length))} imported`);
  } else {
    const report = mergeTasks(dir, allTasks, { replaceExisting }, now);
    lines.push(
      `  ${green('✓')} merged — ${bold(String(report.added))} added ${dim('·')} ${bold(String(report.updated))} updated ${dim('·')} ${bold(
        String(report.skipped),
      )} skipped ${dim(replaceExisting ? '(existing overwritten)' : '(existing kept)')}`,
    );
  }
  emit(lines);
  return 0;
}
