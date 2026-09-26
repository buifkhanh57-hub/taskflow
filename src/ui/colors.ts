/**
 * ANSI styling helpers for taskflow's terminal output.
 *
 * The module keeps a single global "color enabled" switch that is auto-detected
 * on import (TTY, `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`) and can be overridden
 * by the CLI dispatcher (e.g. `--no-color` or piped output).
 *
 * All style helpers are safe on any string: when coloring is disabled they
 * return the input unchanged, and {@link stripAnsi} / {@link visibleWidth}
 * let layout code measure text as it will actually appear on screen.
 *
 * @packageDocumentation
 */

/** Regex matching every ANSI SGR sequence produced by this module. */
const ANSI_RE = new RegExp('\x1b\\[[0-9;]*m', 'g');

/** Auto-detection result captured before anything can override it. */
function detectColorSupport(): boolean {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '') {
    return force !== '0' && force.toLowerCase() !== 'false' && force.toLowerCase() !== 'no';
  }
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout && process.stdout.isTTY);
}

/** Global switch — auto-detected on load. */
let colorEnabled = detectColorSupport();

/** Turn ANSI styling on or off globally (used by `--no-color` / tests). */
export function setColorEnabled(enabled: boolean): void {
  colorEnabled = Boolean(enabled);
}

/** Current global color switch. */
export function isColorEnabled(): boolean {
  return colorEnabled;
}

/** Wrap `text` in an ANSI sequence pair when coloring is enabled. */
function wrap(open: string, close: string, text: string): string {
  if (!colorEnabled) return text;
  return open + text + close;
}

/** Remove every ANSI SGR sequence from `text`. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Number of terminal cells `text` occupies, ignoring ANSI sequences and
 * counting Unicode code points (good enough for the BMP symbols taskflow uses).
 */
export function visibleWidth(text: string): number {
  const plain = stripAnsi(text);
  let n = 0;
  for (const _ of plain) n += 1; // eslint-disable-line no-unused-vars
  return n;
}

/**
 * Cut `text` down to at most `width` visible cells, appending an ellipsis when
 * truncation happens. ANSI sequences at the tail are preserved so partially
 * styled strings keep their color.
 */
export function truncateVisible(text: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  const suffix = '…';
  const plain = stripAnsi(text);
  let out = '';
  let used = 0;
  for (const ch of plain) {
    if (used + 1 > Math.max(0, width - 1)) break;
    out += ch;
    used += 1;
  }
  return out + suffix;
}

// ---------------------------------------------------------------------------
// Basic SGR styles
// ---------------------------------------------------------------------------

/** Bold text. */
export const bold = (t: string): string => wrap('\x1b[1m', '\x1b[22m', t);
/** Dim / low-contrast text. */
export const dim = (t: string): string => wrap('\x1b[2m', '\x1b[22m', t);
/** Italic text. */
export const italic = (t: string): string => wrap('\x1b[3m', '\x1b[23m', t);
/** Underlined text. */
export const underline = (t: string): string => wrap('\x1b[4m', '\x1b[24m', t);
/** Inverted (background/foreground swapped) text. */
export const inverse = (t: string): string => wrap('\x1b[7m', '\x1b[27m', t);

/** Red foreground. */
export const red = (t: string): string => wrap('\x1b[31m', '\x1b[39m', t);
/** Green foreground. */
export const green = (t: string): string => wrap('\x1b[32m', '\x1b[39m', t);
/** Yellow foreground. */
export const yellow = (t: string): string => wrap('\x1b[33m', '\x1b[39m', t);
/** Blue foreground. */
export const blue = (t: string): string => wrap('\x1b[34m', '\x1b[39m', t);
/** Magenta foreground. */
export const magenta = (t: string): string => wrap('\x1b[35m', '\x1b[39m', t);
/** Cyan foreground. */
export const cyan = (t: string): string => wrap('\x1b[36m', '\x1b[39m', t);
/** White foreground. */
export const white = (t: string): string => wrap('\x1b[37m', '\x1b[39m', t);
/** Bright gray foreground. */
export const gray = (t: string): string => wrap('\x1b[90m', '\x1b[39m', t);

/** Red background. */
export const bgRed = (t: string): string => wrap('\x1b[41m', '\x1b[49m', t);
/** Green background. */
export const bgGreen = (t: string): string => wrap('\x1b[42m', '\x1b[49m', t);
/** Yellow background. */
export const bgYellow = (t: string): string => wrap('\x1b[43m', '\x1b[49m', t);

// ---------------------------------------------------------------------------
// Semantic theme
// ---------------------------------------------------------------------------

/** Style a priority key (`P0`..`P3`) according to the theme. */
export function priorityStyle(priority: string): string {
  switch (priority) {
    case 'P0':
      return bold(red(priority));
    case 'P1':
      return yellow(priority);
    case 'P2':
      return cyan(priority);
    default:
      return dim(priority);
  }
}

/** Single status glyph (`○` todo, `▸` doing, `✔` done). */
export function statusGlyph(status: string): string {
  if (status === 'done') return '✔';
  if (status === 'doing') return '▸';
  return '○';
}

/** Style a status word consistently across commands. */
export function statusStyle(status: string): string {
  if (status === 'done') return dim(status);
  if (status === 'doing') return blue(status);
  return white(status);
}

/** Urgency buckets a due date can fall into. */
export type DueTone = 'overdue' | 'today' | 'tomorrow' | 'soon' | 'later' | 'none';

/** Style a due-date label according to its urgency bucket. */
export function dueStyle(tone: DueTone, label: string): string {
  switch (tone) {
    case 'overdue':
      return bold(red(label));
    case 'today':
      return bold(yellow(label));
    case 'tomorrow':
      return cyan(label);
    case 'soon':
      return blue(label);
    case 'later':
      return white(label);
    default:
      return dim(label);
  }
}

/** Positive confirmation text (check marks, success lines). */
export const success = (t: string): string => green(t);
/** Warning text. */
export const warn = (t: string): string => yellow(t);
/** Error text. */
export const danger = (t: string): string => red(t);
/** Neutral informational text. */
export const info = (t: string): string => cyan(t);
/** Section headers. */
export const heading = (t: string): string => bold(underline(t));
/** Count annotations like `(3 tasks)`. */
export const count = (t: string): string => dim(t);
