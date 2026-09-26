/**
 * Command-line argument parsing for taskflow commands.
 *
 * A tiny, dependency-free flag parser that supports:
 *
 * - long flags: `--priority P1` or `--priority=P1`
 * - short flags: `-p P1`, bundled booleans `-xvf`, attached values `-pP1`
 * - repeatable list flags: `--tag work --tag urgent` or comma lists `--tag a,b`
 * - the `--` terminator (everything after it becomes positional text)
 *
 * Unknown flags raise a usage {@link CliError} with exit code 2, so typos are
 * caught instead of being silently treated as title words.
 *
 * @packageDocumentation
 */

import { CliError, EXIT_USAGE } from './types.ts';

/** How a flag consumes values. */
export type FlagKind = 'flag' | 'value' | 'list';

/** Declaration of one accepted flag. */
export interface FlagSpec {
  /** Long name without leading dashes, e.g. `priority`. */
  name: string;
  /** Optional single-letter short name, e.g. `p`. */
  short?: string;
  /** Consumption mode: boolean switch, single value, or repeatable list. */
  kind: FlagKind;
}

/** Result of parsing an argv slice. */
export interface ParsedFlags {
  /** Flag values keyed by long name: boolean, string or string[] (list). */
  flags: Map<string, boolean | string | string[]>;
  /** Positional words (excluding flags and consumed values). */
  positional: string[];
}

/** Alias accepted for a flag, mapped to its long name. */
type AliasMap = Map<string, FlagSpec>;

/** Build long-name and short-name lookup tables, validating duplicates. */
function buildAliases(specs: FlagSpec[]): AliasMap {
  const aliases: AliasMap = new Map();
  for (const spec of specs) {
    if (aliases.has(spec.name)) {
      throw new CliError('DEV_ERROR', `duplicate flag specification: ${spec.name}`);
    }
    aliases.set(spec.name, spec);
    if (spec.short !== undefined) {
      if (spec.short.length !== 1) {
        throw new CliError('DEV_ERROR', `short flag must be one character: ${spec.short}`);
      }
      if (aliases.has(spec.short)) {
        throw new CliError('DEV_ERROR', `duplicate flag short name: ${spec.short}`);
      }
      aliases.set(spec.short, spec);
    }
  }
  return aliases;
}

/** True when the token starts with at least one dash but is not a bare `-`. */
function looksLikeFlag(token: string): boolean {
  return token.length > 1 && token.startsWith('-') && !/^-[\d.]/.test(token);
}

/**
 * Parse `argv` according to `specs`.
 *
 * @param argv Raw argument tokens (already stripped of the command name).
 * @param specs Accepted flags.
 * @throws {CliError} with `exitCode = 2` for unknown flags or missing values.
 */
export function parseFlags(argv: readonly string[], specs: FlagSpec[]): ParsedFlags {
  const aliases = buildAliases(specs);
  const flags: ParsedFlags['flags'] = new Map();
  const positional: string[] = [];

  const setFlag = (name: string): void => {
    flags.set(name, true);
  };
  const setValue = (name: string, value: string, kind: FlagKind): void => {
    if (kind === 'list') {
      const existing = flags.get(name);
      const list = Array.isArray(existing) ? existing : [];
      list.push(value);
      flags.set(name, list);
    } else {
      flags.set(name, value);
    }
  };
  const readValue = (name: string, inline: string | undefined, iterator: () => string | undefined): string => {
    if (inline !== undefined) return inline;
    const next = iterator();
    if (next === undefined || looksLikeFlag(next)) {
      throw new CliError('MISSING_VALUE', `option --${name} requires a value`, EXIT_USAGE);
    }
    return next;
  };

  // Positional words feed titles and queries, which are joined back with
  // single spaces anyway (`joinPositional`), so each shell token may be
  // split on whitespace without losing information.
  const pushPositional = (token: string): void => {
    for (const word of token.split(/\s+/)) {
      if (word.length > 0) positional.push(word);
    }
  };

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    i += 1;

    if (token === '--') {
      while (i < argv.length) {
        pushPositional(argv[i]);
        i += 1;
      }
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      const name = eq >= 0 ? body.slice(0, eq) : body;
      const inline = eq >= 0 ? body.slice(eq + 1) : undefined;
      const spec = aliases.get(name);
      if (!spec) {
        throw new CliError('UNKNOWN_OPTION', `unknown option --${name}`, EXIT_USAGE);
      }
      if (spec.kind === 'flag') {
        if (inline !== undefined) {
          throw new CliError('UNEXPECTED_VALUE', `option --${name} does not take a value`, EXIT_USAGE);
        }
        setFlag(spec.name);
      } else {
        setValue(spec.name, readValue(spec.name, inline, () => (i < argv.length ? argv[i++] : undefined)), spec.kind);
      }
      continue;
    }

    if (looksLikeFlag(token)) {
      // Short cluster: -abc, -pP1, -vf out.txt
      const chars = token.slice(1);
      for (let c = 0; c < chars.length; c += 1) {
        const ch = chars[c];
        const spec = aliases.get(ch);
        if (!spec) {
          throw new CliError('UNKNOWN_OPTION', `unknown option -${ch}`, EXIT_USAGE);
        }
        if (spec.kind === 'flag') {
          setFlag(spec.name);
          continue;
        }
        const inline = c + 1 < chars.length ? chars.slice(c + 1) : undefined;
        setValue(
          spec.name,
          readValue(spec.name, inline, () => (i < argv.length ? argv[i++] : undefined)),
          spec.kind,
        );
        break; // value consumed the rest of the cluster
      }
      continue;
    }

    pushPositional(token);
  }

  return { flags, positional };
}

/** True when the boolean flag was present. */
export function hasFlag(parsed: ParsedFlags, name: string): boolean {
  return parsed.flags.get(name) === true;
}

/** Read a single-valued flag, or `fallback` when absent. */
export function flagString(parsed: ParsedFlags, name: string, fallback?: string): string | undefined {
  const value = parsed.flags.get(name);
  if (typeof value === 'string') return value;
  return fallback;
}

/**
 * Read a list flag as a flat string list. Comma-separated values inside a
 * single occurrence are split, and entries are trimmed; empty entries drop.
 */
export function flagList(parsed: ParsedFlags, name: string): string[] {
  const value = parsed.flags.get(name);
  const parts: string[] = [];
  if (Array.isArray(value)) parts.push(...value);
  else if (typeof value === 'string') parts.push(value);
  return parts
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Read an integer flag, clamped to `[min, max]`; returns `fallback` if absent/invalid. */
export function flagInt(parsed: ParsedFlags, name: string, opts: { min: number; max: number; fallback: number }): number {
  const raw = flagString(parsed, name);
  if (raw === undefined) return opts.fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return opts.fallback;
  return Math.min(opts.max, Math.max(opts.min, n));
}

/**
 * Join positional words into a single phrase (used for titles and queries),
 * collapsing whitespace. Throws a usage error when the result is empty and
 * `required` is set.
 */
export function joinPositional(parsed: ParsedFlags, opts: { required?: boolean; what?: string } = {}): string {
  const text = parsed.positional.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0 && opts.required) {
    throw new CliError('MISSING_ARGUMENT', `missing required ${opts.what ?? 'argument'}`, EXIT_USAGE);
  }
  return text;
}
