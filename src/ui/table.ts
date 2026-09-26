/**
 * ANSI-aware table rendering for taskflow's list and stats views.
 *
 * Features:
 * - automatic column sizing with per-column max widths and word wrapping
 * - left/right alignment
 * - per-column or per-cell color styling applied *after* wrapping, so wrapped
 *   lines keep their color
 * - visible-width measurement that ignores ANSI escape sequences
 *
 * The renderer never writes to stdout; it returns lines.
 *
 * @packageDocumentation
 */

import { dim, visibleWidth } from './colors.ts';

/** Declaration of one table column. */
export interface Column {
  /** Header label. */
  header: string;
  /** Text alignment inside the column. Default `left`. */
  align?: 'left' | 'right';
  /** Fixed width; content wraps or pads to exactly this size. */
  width?: number;
  /** Upper bound for the auto-computed width. */
  maxWidth?: number;
  /** Styler applied to every rendered line of this column. */
  style?: (text: string) => string;
}

/** A cell is either a plain string or a string with a custom styler. */
export interface StyledCell {
  text: string;
  style?: (text: string) => string;
}

export type CellInput = string | StyledCell;

export interface TableOptions {
  /** Indentation prefix for every line. */
  indent?: string;
  /** Character used for the header underline. Default `─`. */
  underline?: string;
  /** Gap between columns. Default 2. */
  gap?: string;
}

/** Resolve a cell into text + styler. */
function cellParts(cell: CellInput, column: Column): { text: string; style: (t: string) => string } {
  const text = typeof cell === 'string' ? cell : cell.text;
  const style = typeof cell === 'string' ? (column.style ?? ((t: string): string => t)) : (cell.style ?? column.style ?? ((t: string): string => t));
  return { text, style };
}

/**
 * Word-wrap a plain string to `width` visible cells.
 * Long unbreakable words are hard-split. Existing ANSI sequences are measured
 * as zero width; styled input should therefore be styled *after* wrapping
 * (the renderer does this for you).
 */
export function wrapCellText(text: string, width: number): string[] {
  if (width <= 0) return [''];
  if (visibleWidth(text) <= width) return [text];
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (word === '') continue;
    // Hard-split words longer than the column.
    let rest = word;
    while (visibleWidth(rest) > width) {
      let piece = '';
      let used = 0;
      let cut = 0;
      for (const ch of rest) {
        if (used + 1 > width) break;
        piece += ch;
        used += 1;
        cut += 1;
      }
      if (current.length > 0) {
        lines.push(current);
        current = '';
      }
      lines.push(piece);
      rest = rest.slice(cut);
    }
    if (rest.length === 0) continue;
    if (current.length === 0) {
      current = rest;
    } else if (visibleWidth(current) + 1 + visibleWidth(rest) <= width) {
      current += ' ' + rest;
    } else {
      lines.push(current);
      current = rest;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/** Pad a string to `width` visible cells, honoring alignment. */
function padCell(text: string, width: number, align: 'left' | 'right'): string {
  const pad = Math.max(0, width - visibleWidth(text));
  return align === 'right' ? ' '.repeat(pad) + text : text + ' '.repeat(pad);
}

/** Compute the final width of every column given headers and raw cells. */
function computeWidths(columns: Column[], rows: CellInput[][]): number[] {
  return columns.map((col, i) => {
    if (col.width !== undefined) return Math.max(1, col.width);
    let natural = visibleWidth(col.header);
    for (const row of rows) {
      const cell = row[i];
      if (cell === undefined) continue;
      const text = typeof cell === 'string' ? cell : cell.text;
      for (const line of text.split('\n')) {
        natural = Math.max(natural, visibleWidth(line));
      }
    }
    const capped = col.maxWidth !== undefined ? Math.min(natural, col.maxWidth) : natural;
    return Math.max(1, capped);
  });
}

/**
 * Render a table.
 *
 * ```
 * renderTable(
 *   [{ header: 'ID' }, { header: 'DUE', align: 'right' }],
 *   [['a1b2c3d4', 'today'], ['e5f6a7b8', 'tomorrow']],
 * );
 * ```
 *
 * Cells wrap to their column width; multi-line rows expand vertically and
 * short cells are padded with empty lines so the border alignment stays
 * intact.
 */
export function renderTable(columns: Column[], rows: CellInput[][], opts: TableOptions = {}): string[] {
  const indent = opts.indent ?? '';
  const gap = opts.gap ?? '  ';
  const underline = opts.underline ?? '─';
  const widths = computeWidths(columns, rows);

  const lines: string[] = [];

  // Header row (styled dim by default) + underline.
  const headerCells = columns.map((col, i) => padCell(col.header, widths[i], col.align ?? 'left'));
  lines.push(indent + headerCells.join(gap));
  const underlineParts = columns.map((col, i) => underline.repeat(widths[i]));
  lines.push(indent + dim(underlineParts.join(gap)));

  // Body rows.
  for (const row of rows) {
    const wrapped: { lines: string[]; style: (t: string) => string; align: 'left' | 'right'; width: number }[] = [];
    let height = 1;
    for (let i = 0; i < columns.length; i += 1) {
      const col = columns[i];
      const cell = row[i];
      const { text, style } = cellParts(cell ?? '', col);
      const segments = text.split('\n').flatMap((seg) => wrapCellText(seg, widths[i]));
      const padded = segments.map((seg) => padCell(seg, widths[i], col.align ?? 'left'));
      height = Math.max(height, padded.length);
      wrapped.push({ lines: padded, style, align: col.align ?? 'left', width: widths[i] });
    }
    for (let lineIdx = 0; lineIdx < height; lineIdx += 1) {
      const parts = wrapped.map((w) => {
        const raw = w.lines[lineIdx] ?? padCell('', w.width, w.align);
        return w.style(raw);
      });
      lines.push(indent + parts.join(gap));
    }
  }
  return lines;
}

/**
 * Render a two-column `key: value` layout with the keys padded to a common
 * width — used by `show`, stats sections and error help.
 */
export function renderKeyValue(pairs: ReadonlyArray<readonly [string, string]>, opts: { keyStyle?: (t: string) => string; indent?: string } = {}): string[] {
  const indent = opts.indent ?? '';
  const keyStyle = opts.keyStyle ?? dim;
  const keyWidth = Math.max(0, ...pairs.map(([k]) => visibleWidth(k)));
  return pairs.map(([key, value]) => `${indent}${keyStyle(padCell(key, keyWidth, 'left'))}  ${value}`);
}
