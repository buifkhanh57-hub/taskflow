/**
 * Terminal progress and micro-visualization primitives.
 *
 * Pure string-in/string-out helpers used by `stats`, `gantt` and list
 * summaries: progress bars, sparklines, percentages and trend arrows.
 * They never write to stdout themselves, so callers stay in control of layout.
 *
 * @packageDocumentation
 */

import { dim, green, red, visibleWidth, yellow } from './colors.ts';

/** Clamp a number into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export interface BarOptions {
  /** Total width in terminal cells, including any rendered label. Default 20. */
  width?: number;
  /** Glyph used for the filled part. Default `█`. */
  fill?: string;
  /** Glyph used for the empty part. Default `░`. */
  empty?: string;
  /** Optional custom styler for the filled segment (default green). */
  fillStyle?: (text: string) => string;
}

/**
 * Render a single-line progress bar.
 *
 * ```
 * bar(3, 4)      → ██████████████████░░░░░░  (colored when enabled)
 * bar(7, 10)     → ██████████████░░░░░░
 * ```
 *
 * When `total` is zero or negative the bar renders completely empty.
 */
export function bar(value: number, total: number, opts: BarOptions = {}): string {
  const width = Math.max(1, Math.floor(opts.width ?? 20));
  const fill = opts.fill ?? '█';
  const empty = opts.empty ?? '░';
  const frac = total > 0 ? clamp(value / total, 0, 1) : 0;
  const filledCount = Math.round(frac * width);
  const emptyCount = Math.max(0, width - filledCount);
  const filledPart = fill.repeat(filledCount);
  const emptyPart = empty.repeat(emptyCount);
  const style = opts.fillStyle ?? green;
  return style(filledPart) + dim(emptyPart);
}

/** Render a compact `n/m (42%)` progress annotation. */
export function barLabel(value: number, total: number): string {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return `${value}/${total} (${pct}%)`;
}

/** Blocks used by {@link sparkline}, from lowest to highest. */
const SPARK_BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Render a numeric series as a Unicode sparkline.
 *
 * ```
 * sparkline([1, 3, 2, 8, 5]) → ▂▄▃█▆
 * ```
 *
 * All-zero series render as the lowest block repeated. Non-finite and negative
 * values are clamped into range first.
 */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return '';
  const finite = values.map((v) => (Number.isFinite(v) ? Math.max(0, v) : 0));
  const max = Math.max(...finite);
  const min = Math.min(...finite);
  const range = max - min;
  return finite
    .map((v) => {
      const idx =
        range === 0
          ? max === 0
            ? 0
            : SPARK_BLOCKS.length - 1
          : Math.round(((v - min) / range) * (SPARK_BLOCKS.length - 1));
      return SPARK_BLOCKS[clamp(idx, 0, SPARK_BLOCKS.length - 1)];
    })
    .join('');
}

/**
 * Format a share as a percentage string, e.g. `42%`. Empty totals yield `0%`.
 */
export function percent(part: number, total: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '0%';
  const pct = (part / total) * 100;
  if (pct >= 100) return `${Math.round(pct)}%`;
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/**
 * Colored trend indicator comparing `current` with `previous`:
 * `↑ +2` (green), `↓ -1` (red) or `→ ±0` (dim).
 */
export function trend(current: number, previous: number): string {
  const delta = current - previous;
  if (delta > 0) return green(`↑ +${delta}`);
  if (delta < 0) return red(`↓ ${delta}`);
  return dim('→ ±0');
}

/** Spinner frames (braille), usable with an interval timer for long jobs. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/**
 * Render one spinner frame with a label, e.g. `⠙ importing…`.
 * Purely cosmetic — taskflow's operations are fast, but the helper is exposed
 * for embedding the engine into longer-running host applications.
 */
export function spinnerFrame(index: number, label: string, enabled: boolean = isColorEnabled()): string {
  const glyph = SPINNER_FRAMES[((index % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length];
  const text = `${glyph} ${label}`;
  return enabled ? yellow(text) : text;
}

/**
 * Build a right-aligned numeric ruler such as `1  2  3  4` padded to `width`
 * cells — used by the gantt view for day numbers.
 */
export function ruler(width: number, step: number = 1): string {
  const cells: string[] = [];
  for (let i = 1; i <= width; i += 1) cells.push(i % step === 0 ? String(i) : ' ');
  return cells.join('').slice(0, Math.max(0, width));
}

/**
 * Pad a string with spaces on the right so its *visible* width equals
 * `width` (ANSI sequences count as zero cells).
 */
export function padEndVisible(text: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(text));
  return text + ' '.repeat(pad);
}

/**
 * Pad a string with spaces on the left so its *visible* width equals
 * `width` (ANSI sequences count as zero cells).
 */
export function padStartVisible(text: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(text));
  return ' '.repeat(pad) + text;
}
