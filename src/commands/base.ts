/**
 * Shared plumbing for taskflow command modules.
 *
 * Every command exports a `HELP` constant ({@link CommandHelp}) plus a
 * `run<Name>(dir, argv): number` function. The registry (`registry.ts`) wires
 * them together and the `bin/taskflow.ts` dispatcher only talks to the
 * registry.
 *
 * @packageDocumentation
 */

import { CliError, EXIT_USAGE } from '../types.ts';

/** Declarative help block shown by `taskflow help <command>`. */
export interface CommandHelp {
  /** Canonical command name (lowercase). */
  readonly name: string;
  /** Alternative names that dispatch to the same command. */
  readonly aliases: readonly string[];
  /** One-line summary for the command table. */
  readonly summary: string;
  /** Synopsis line, without the leading `taskflow`. */
  readonly usage: string;
  /** Optional long description paragraphs. */
  readonly details?: readonly string[];
  /** Flag documentation: `[flag, description]` pairs. */
  readonly flags?: readonly (readonly [string, string])[];
  /** Concrete usage examples. */
  readonly examples: readonly string[];
  /** Related command names suggested in help output. */
  readonly seeAlso?: readonly string[];
}

/** Write lines to stdout in one write (keeps output atomic under pipes). */
export function emit(lines: readonly string[]): void {
  if (lines.length === 0) return;
  process.stdout.write(lines.join('\n') + '\n');
}

/** Write lines to stderr in one write. */
export function emitError(lines: readonly string[]): void {
  if (lines.length === 0) return;
  process.stderr.write(lines.join('\n') + '\n');
}

/** Throw a usage error when fewer than `count` positionals were supplied. */
export function requirePositionals(values: readonly string[], count: number, what: string): readonly string[] {
  if (values.length < count) {
    throw new CliError('MISSING_ARGUMENT', `missing required ${what}${count > 1 ? 's' : ''} — got ${values.length}`, EXIT_USAGE);
  }
  return values;
}

/** Parse a positive integer option with a usage error when malformed. */
export function parsePositiveInt(raw: string | undefined, name: string, fallback: number, max = 10_000): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new CliError('INVALID_OPTION', `--${name} expects a positive integer, got ${JSON.stringify(raw)}`, EXIT_USAGE);
  }
  return Math.min(max, n);
}

/** Truncate a title for narrow table columns, appending an ellipsis. */
export function clipTitle(title: string, width: number): string {
  if (title.length <= width) return title;
  return width <= 1 ? title.slice(0, 1) : title.slice(0, width - 1) + '…';
}
