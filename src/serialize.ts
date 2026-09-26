/**
 * Import/export serializers for taskflow: CSV, Markdown checklists and JSON.
 *
 * CSV output follows RFC-4180 quoting (commas, quotes and newlines inside
 * fields are escaped; tags use `;` separators to stay CSV-safe). The parser
 * is a small state machine that handles quoted fields, doubled quotes and
 * CRLF line endings.
 *
 * @packageDocumentation
 */

import type { ExportFormat, Task } from './types.ts';
import { parseEstimateMinutes, sanitizeTask } from './task.ts';
import { describeDue, formatISODateTime, parseISODateTime, recurrenceLabel } from './dateparse.ts';
import { estimateLabel } from './task.ts';

/** Column order used by CSV export and import. */
export const CSV_COLUMNS = [
  'id',
  'title',
  'status',
  'priority',
  'tags',
  'project',
  'due',
  'created',
  'updated',
  'completed',
  'recurrence',
  'estimate',
  'notes',
] as const;

/** Escape one CSV field per RFC-4180 (quotes doubled, commas/newlines quoted). */
export function csvEscape(field: string): string {
  if (/[",\n\r]/.test(field)) {
    return '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
}

/**
 * Serialize tasks to CSV text (LF line endings, header row included).
 */
export function toCSV(tasks: Task[]): string {
  const rows: string[] = [];
  rows.push(CSV_COLUMNS.join(','));
  for (const task of tasks) {
    const cells: string[] = [
      task.id,
      task.title,
      task.status,
      task.priority,
      task.tags.join(';'),
      task.project ?? '',
      task.due ?? '',
      task.createdAt,
      task.updatedAt,
      task.completedAt ?? '',
      task.recurrence === null ? '' : recurrenceLabel(task.recurrence),
      task.estimateMinutes === null ? '' : String(task.estimateMinutes),
      task.notes,
    ];
    rows.push(cells.map(csvEscape).join(','));
  }
  return rows.join('\n') + '\n';
}

/**
 * Parse CSV text into rows of string cells.
 * Handles quoted fields, doubled quotes, embedded commas/newlines and CRLF.
 * Blank trailing lines are ignored.
 */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    // Skip fully empty trailing rows.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

export interface ParseReport {
  tasks: Task[];
  /** Human-readable problems for rows that could not be coerced. */
  errors: string[];
}

/** Convert CSV rows (including header) into tasks. */
export function fromCSV(text: string, now: Date = new Date()): ParseReport {
  const rows = parseCSV(text);
  const errors: string[] = [];
  if (rows.length === 0) return { tasks: [], errors: ['empty CSV input'] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const expected = [...CSV_COLUMNS];
  const isHeader = header.includes('id') && header.includes('title');
  const bodyRows = isHeader ? rows.slice(1) : rows;
  const indexOf = (name: string): number => (isHeader ? header.indexOf(name) : expected.indexOf(name));

  const tasks: Task[] = [];
  for (let r = 0; r < bodyRows.length; r += 1) {
    const cells = bodyRows[r];
    const lineNo = r + (isHeader ? 2 : 1);
    if (cells.every((c) => c.trim() === '')) continue;
    const raw: Record<string, unknown> = {
      id: cells[indexOf('id')] ?? '',
      title: cells[indexOf('title')] ?? '',
      status: cells[indexOf('status')] ?? 'todo',
      priority: cells[indexOf('priority')] ?? 'P2',
      tags: (cells[indexOf('tags')] ?? '')
        .split(';')
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
      project: (cells[indexOf('project')] ?? '').trim() === '' ? null : cells[indexOf('project')],
      due: (cells[indexOf('due')] ?? '').trim() === '' ? null : cells[indexOf('due')],
      createdAt: cells[indexOf('created')] ?? '',
      updatedAt: cells[indexOf('updated')] ?? '',
      completedAt: (cells[indexOf('completed')] ?? '').trim() === '' ? null : cells[indexOf('completed')],
      recurrence: (cells[indexOf('recurrence')] ?? '').trim() === '' ? null : cells[indexOf('recurrence')],
      estimateMinutes: (cells[indexOf('estimate')] ?? '').trim() === '' ? null : Number(cells[indexOf('estimate')]),
      notes: cells[indexOf('notes')] ?? '',
    };
    if (typeof raw.title === 'string' && raw.title.trim() === '') {
      errors.push(`line ${lineNo}: missing title — row skipped`);
      continue;
    }
    tasks.push(sanitizeTask(raw, now));
  }
  return { tasks, errors };
}

/** Serialize tasks to pretty-printed JSON (store-file compatible shape). */
export function toJSON(tasks: Task[], now: Date = new Date()): string {
  return JSON.stringify({ version: 1, exportedAt: formatISODateTime(now), tasks }, null, 2) + '\n';
}

/** Parse JSON text (array or `{ tasks: [...] }`) into tasks. */
export function fromJSON(text: string, now: Date = new Date()): ParseReport {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { tasks: [], errors: [`invalid JSON: ${(err as Error).message}`] };
  }
  const list = Array.isArray(raw) ? raw : typeof raw === 'object' && raw !== null && Array.isArray((raw as Record<string, unknown>).tasks) ? ((raw as Record<string, unknown>).tasks as unknown[]) : null;
  if (list === null) {
    return { tasks: [], errors: ['JSON must be an array of tasks or an object with a "tasks" array'] };
  }
  const tasks: Task[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`item ${i}: not an object — skipped`);
      continue;
    }
    tasks.push(sanitizeTask(entry, now));
  }
  return { tasks, errors };
}

/**
 * Serialize tasks as a Markdown checklist, grouped by project.
 * Completed tasks render as `- [x]`, open tasks as `- [ ]`; priority, due,
 * estimate, recurrence and tags ride along as plain-text annotations.
 */
export function toMarkdown(tasks: Task[], opts: { title?: string; now?: Date } = {}): string {
  const now = opts.now ?? new Date();
  const lines: string[] = [];
  lines.push(`# ${opts.title ?? 'Taskflow export'}`);
  lines.push('');
  lines.push(`_Generated ${formatISODateTime(now)} — ${tasks.length} task${tasks.length === 1 ? '' : 's'}_`);
  lines.push('');

  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = task.project ?? '(no project)';
    const list = groups.get(key);
    if (list) list.push(task);
    else groups.set(key, [task]);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const aNone = a === '(no project)' ? 1 : 0;
    const bNone = b === '(no project)' ? 1 : 0;
    if (aNone !== bNone) return aNone - bNone;
    return a.localeCompare(b);
  });

  for (const key of keys) {
    lines.push(`## ${key}`);
    lines.push('');
    for (const task of groups.get(key)) {
      const box = task.status === 'done' ? 'x' : ' ';
      const bits: string[] = [];
      bits.push(`**${task.priority}**`);
      bits.push(task.title);
      if (task.due !== null) bits.push(`due: ${task.due} (${describeDue(task.due, now)})`);
      if (task.estimateMinutes !== null) bits.push(`est: ${estimateLabel(task.estimateMinutes)}`);
      if (task.recurrence !== null) bits.push(`↻ ${recurrenceLabel(task.recurrence)}`);
      if (task.tags.length > 0) bits.push(task.tags.map((t) => `\`#${t}\``).join(' '));
      lines.push(`- [${box}] ${bits.join(' — ')}`);
      if (task.notes.trim().length > 0) {
        for (const noteLine of task.notes.trim().split('\n')) {
          lines.push(`  > ${noteLine}`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Markdown checklist parsing
// ---------------------------------------------------------------------------

/** One intermediate record produced while scanning a Markdown checklist. */
interface MarkdownDraft {
  project: string | null;
  done: boolean;
  body: string;
  notes: string[];
}

/**
 * Extract the priority token (`**P0**`..`**P3**`) from a checklist item body.
 * Returns the priority (or null) plus the body with the token removed.
 */
function splitMarkdownPriority(body: string): { priority: string | null; rest: string } {
  const m = /^\*\*(P[0-3])\*\*\s*(.*)$/.exec(body.trim());
  if (m) return { priority: m[1], rest: m[2] };
  return { priority: null, rest: body.trim() };
}

/** Strip `` `#tag` `` annotations from the tail of a checklist item. */
function splitMarkdownTags(body: string): { rest: string; tags: string[] } {
  const tags: string[] = [];
  let rest = body;
  for (;;) {
    const m = /(?:^|\s)`#([a-z0-9._/-]+)`$/i.exec(rest.trimEnd());
    if (!m) break;
    tags.unshift(m[1].toLowerCase());
    rest = rest.trimEnd().slice(0, rest.trimEnd().length - m[0].length);
  }
  return { rest: rest.trim(), tags };
}

/** Pull `key: value` / `↻ rule` segments out of a `—`-separated item body. */
function splitMarkdownSegments(body: string): { title: string; fields: Map<string, string> } {
  const fields = new Map<string, string>();
  const segments = body.split('—').map((s) => s.trim()).filter((s) => s.length > 0);
  const titleParts: string[] = [];
  for (const segment of segments) {
    const kv = /^(due|est|estimate|recurrence|recur)\s*:\s*(.+)$/i.exec(segment);
    if (kv) {
      fields.set(kv[1].toLowerCase(), kv[2].trim());
      continue;
    }
    const rec = /^↻\s*(.+)$/.exec(segment);
    if (rec) {
      fields.set('recurrence', rec[1].trim());
      continue;
    }
    titleParts.push(segment);
  }
  return { title: titleParts.join(' — ').trim(), fields };
}

/** Normalize a `due: 2026-01-15 (in 3d)` markdown field down to its raw value. */
function markdownDueValue(raw: string): string {
  return raw.replace(/\s*\(.*\)\s*$/, '').trim();
}

/** Normalize `est: 2h` / `estimate: 120` down to a parseable estimate token. */
function markdownEstimateValue(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v === '' || v === '—') return null;
  if (/^\d+$/.test(v)) return `${v}m`;
  return v;
}
/**
 * Parse a Markdown checklist produced by {@link toMarkdown} back into tasks.
 *
 * Recognized per item:
 * `- [x] **P1** Title — due: 2026-01-15 (overdue 2d) — est: 2h — ↻ weekly — \`#tag\``
 *
 * `## project` headers assign the project slug; block-quoted lines (`> …`)
 * attach as notes to the previous item. Unknown lines are ignored, so hand
 * edits to other parts of the file never break the import.
 */
export function fromMarkdown(text: string, now: Date = new Date()): ParseReport {
  const errors: string[] = [];
  const drafts: MarkdownDraft[] = [];
  let project: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const header = /^##\s+(.+?)\s*$/.exec(line);
    if (header) {
      const name = header[1].trim();
      project = name === '(no project)' || name === '' ? null : name.toLowerCase();
      continue;
    }
    const note = /^>\s?(.*)$/.exec(line.trim());
    if (note && drafts.length > 0) {
      drafts[drafts.length - 1].notes.push(note[1].trim());
      continue;
    }
    const item = /^[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line.trim());
    if (item) {
      drafts.push({ project, done: item[1].toLowerCase() === 'x', body: item[2].trim(), notes: [] });
    }
  }

  const tasks: Task[] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    const draft = drafts[i];
    const { priority, rest } = splitMarkdownPriority(draft.body);
    const { rest: withoutTags, tags } = splitMarkdownTags(rest);
    const { title, fields } = splitMarkdownSegments(withoutTags);
    if (title === '') {
      errors.push(`item ${i + 1}: empty title — row skipped`);
      continue;
    }
    const dueRaw = fields.get('due');
    const notesRaw = draft.notes.join('\n');
    const estimateRaw = markdownEstimateValue(fields.get('est') ?? fields.get('estimate') ?? '');
    const estimateMinutes = estimateRaw === null ? null : parseEstimateMinutes(estimateRaw);
    tasks.push(
      sanitizeTask(
        {
          title,
          priority: priority ?? 'P2',
          status: draft.done ? 'done' : 'todo',
          tags,
          project: draft.project,
          due: dueRaw === undefined || dueRaw === '' ? null : markdownDueValue(dueRaw),
          recurrence: fields.get('recurrence') ?? null,
          estimateMinutes,
          notes: notesRaw,
        },
        now,
      ),
    );
  }
  return { tasks, errors };
}

/**
 * Guess the serialization format of a file: by extension first, then by
 * content sniffing. Returns `'unknown'` when nothing matches.
 */
export function sniffFormat(filePath: string, content: string): ExportFormat | 'unknown' {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  const head = content.slice(0, 200).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (head.includes(',') && /^[\w"]+[\w",\s]*\n/.test(head)) return 'csv';
  if (head.startsWith('#') || head.includes('- [')) return 'markdown';
  return 'unknown';
}
