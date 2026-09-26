/**
 * Natural-language date parsing and date utilities for taskflow.
 *
 * The parser understands the due-date expressions accepted on the command
 * line (all resolved against the *current local time zone*):
 *
 * | Expression                      | Meaning                                   |
 * |---------------------------------|-------------------------------------------|
 * | `today`, `tomorrow`, `yesterday`| Calendar days relative to now             |
 * | `fri`, `friday`, `next mon`, `last sat` | Weekday resolution                |
 * | `+3d`, `+2w`, `+1m`, `-1d`, `+4h` | Offsets from today                      |
 * | `in 3 days`, `2 weeks ago`      | Verbal offsets                            |
 * | `2026-01-15`, `2026/01/15`, `15.01.2026` | Calendar dates                   |
 * | `jan 15`, `15 jan`, `jan 15 2027`, `mar 3rd` | Month/day (nearest future)   |
 * | `15`                            | Day of month (rolls to next month if past)|
 * | `next week`, `next month`, `weekend` | Coarse buckets                       |
 * | `eod`, `eow`, `noon`, `midnight`, `now` | Time-of-day aware shortcuts       |
 * | `... at 3pm`, `... 14:30`, `... 9am` | Optional time suffix on any date     |
 *
 * The module also hosts the recurrence-rule parser (`daily`, `every 3 days`,
 * `biweekly`, `every 6 months`, …) and the human-friendly relative labels
 * shown in tables (`overdue 2d`, `tomorrow`, `in 3d`).
 *
 * @packageDocumentation
 */

import type { Recurrence } from './types.ts';
import { MAX_INTERVAL } from './types.ts';

// ---------------------------------------------------------------------------
// Calendar primitives
// ---------------------------------------------------------------------------

/** A wall-clock time within a day. */
interface TimeOfDay {
  hour: number;
  minute: number;
}

/** Number of days in a month (0-based month index). */
export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** Copy of `date` truncated to local midnight. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Copy of `date` set to 23:59:59.999 local time. */
export function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

/** Copy of `date` shifted by `n` whole days (preserves time of day). */
export function addDays(date: Date, n: number): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + n,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

/**
 * Copy of `date` shifted by `months` calendar months, clamping the day of
 * month when the target month is shorter (Jan 31 + 1 month → Feb 28/29).
 */
export function addMonths(date: Date, months: number): Date {
  const total = date.getMonth() + months;
  const targetYear = date.getFullYear() + Math.floor(total / 12);
  const targetMonth = ((total % 12) + 12) % 12;
  const day = Math.min(date.getDate(), daysInMonth(targetYear, targetMonth));
  return new Date(
    targetYear,
    targetMonth,
    day,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

/** Copy of `date` shifted by `n` minutes. */
export function addMinutes(date: Date, n: number): Date {
  return new Date(date.getTime() + n * 60_000);
}

/** Monday-based start of the ISO week containing `date`. */
export function startOfWeek(date: Date): Date {
  const base = startOfDay(date);
  const shift = (base.getDay() + 6) % 7;
  return addDays(base, -shift);
}

/** True when both dates fall on the same calendar day. */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/** Whole calendar days from `b`'s midnight to `a`'s midnight (negative when `a` is earlier). */
export function calendarDayDiff(a: Date, b: Date): number {
  const ms = startOfDay(a).getTime() - startOfDay(b).getTime();
  return Math.round(ms / 86_400_000);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Zero-pad to two digits. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Format as a local `YYYY-MM-DD` string. */
export function formatISODate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Format as a local `HH:MM` string. */
export function formatTimeOfDay(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Format as a local `YYYY-MM-DDTHH:MM` string. */
export function formatISODateTime(date: Date): string {
  return `${formatISODate(date)}T${formatTimeOfDay(date)}`;
}

/**
 * Convert a date into the canonical due-date string stored on tasks:
 * `YYYY-MM-DD` when the time is exactly midnight, otherwise
 * `YYYY-MM-DDTHH:MM`.
 */
export function toDueISO(date: Date): string {
  if (date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0) {
    return formatISODate(date);
  }
  return formatISODateTime(date);
}

/** True when the date carries a non-midnight time component. */
export function hasTimeComponent(date: Date): boolean {
  return date.getHours() !== 0 || date.getMinutes() !== 0;
}

/**
 * Parse a stored due string (`YYYY-MM-DD`, `YYYY-MM-DDTHH:MM` or a full
 * ISO-8601 timestamp with offset) into a local `Date`.
 * Returns null for anything unparsable.
 */
export function parseISODateTime(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v === '') return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[Tt ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (m) {
    return buildLocal(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0),
    );
  }
  const parsed = new Date(v); // full ISO with Z / timezone offset
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Construct a validated local date, or null when the components are impossible. */
function buildLocal(year: number, month1: number, day: number, hour = 0, minute = 0, second = 0): Date | null {
  if (!Number.isFinite(year) || !Number.isFinite(month1) || !Number.isFinite(day)) return null;
  if (month1 < 1 || month1 > 12) return null;
  if (day < 1 || day > daysInMonth(year, month1 - 1)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  return new Date(year, month1 - 1, day, hour, minute, second);
}

// ---------------------------------------------------------------------------
// Vocabulary tables
// ---------------------------------------------------------------------------

/** Full English weekday names indexed by `Date#getDay()`. */
export const WEEKDAY_FULL = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** Short capitalized month names indexed by month (0 = Jan). */
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Weekday letters starting Monday — used by the gantt header. */
export const WEEKDAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

/** Month name aliases (3-letter and full forms) mapped to month index. */
const MONTH_ALIASES: Readonly<Record<string, number>> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/** Weekday name aliases mapped to `Date#getDay()` values. */
const WEEKDAY_ALIASES: Readonly<Record<string, number>> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

// ---------------------------------------------------------------------------
// Time-of-day extraction
// ---------------------------------------------------------------------------

/** Common time-of-day words and the times they stand for. */
const TIME_KEYWORDS: ReadonlyArray<readonly [RegExp, TimeOfDay]> = [
  [/\bnoon\b/, { hour: 12, minute: 0 }],
  [/\bmidnight\b/, { hour: 0, minute: 0 }],
  [/\bmorning\b/, { hour: 9, minute: 0 }],
  [/\bafternoon\b/, { hour: 15, minute: 0 }],
  [/\bevening\b/, { hour: 19, minute: 0 }],
  [/\btonight\b/, { hour: 21, minute: 0 }],
];

/** Normalize hour/minute/meridiem into a {@link TimeOfDay}, or null. */
function normalizeTime(hourStr: string, minuteStr: string | undefined, meridiem: string | undefined): TimeOfDay | null {
  let hour = Number.parseInt(hourStr, 10);
  const minute = minuteStr !== undefined ? Number.parseInt(minuteStr, 10) : 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  if (meridiem !== undefined && meridiem !== '') {
    const p = meridiem.replace(/\./g, '').toLowerCase();
    if (hour < 1 || hour > 12) return null;
    if (p === 'am') {
      if (hour === 12) hour = 0;
    } else if (hour !== 12) {
      hour += 12;
    }
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  return { hour, minute };
}

/** Collapse runs of whitespace and strip stray comma/punctuation edges. */
function cleanPart(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim();
}

/** Remove the substring at `index` with length `len`, then tidy whitespace. */
function cutOut(text: string, index: number, len: number): string {
  return cleanPart(text.slice(0, index) + ' ' + text.slice(index + len));
}

export interface ExtractedTime {
  /** First time of day found, or null. */
  time: TimeOfDay | null;
  /** Remaining date-expression text. */
  rest: string;
}

/**
 * Pull a time-of-day out of a raw expression (`at 3pm`, `14:30`, `10 am`,
 * `noon`, …), removing the matched fragment from the remainder.
 */
export function extractTime(raw: string): ExtractedTime {
  const lower = raw.toLowerCase();

  const at = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/.exec(lower);
  if (at) {
    const time = normalizeTime(at[1], at[2], at[3]);
    if (time) return { time, rest: cutOut(lower, at.index, at[0].length) };
  }

  for (const [re, time] of TIME_KEYWORDS) {
    const m = re.exec(lower);
    if (m) return { time, rest: cutOut(lower, m.index, m[0].length) };
  }

  const hm = /(?:^|\s)(\d{1,2}):(\d{2})(?=\s|$)/.exec(lower);
  if (hm) {
    const time = normalizeTime(hm[1], hm[2], undefined);
    if (time) return { time, rest: cutOut(lower, hm.index, hm[0].length) };
  }

  const am = /\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)\b/.exec(lower);
  if (am) {
    const time = normalizeTime(am[1], undefined, am[2]);
    if (time) return { time, rest: cutOut(lower, am.index, am[0].length) };
  }

  return { time: null, rest: cleanPart(lower) };
}

/** Apply a {@link TimeOfDay} onto a date's calendar day. */
function applyTime(date: Date, time: TimeOfDay): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), time.hour, time.minute, 0, 0);
}

// ---------------------------------------------------------------------------
// Date-part resolution
// ---------------------------------------------------------------------------

/** Strip leading prepositions users habitually type (`on friday`, `by jan 5`). */
function stripPrepositions(text: string): string {
  let out = text;
  for (;;) {
    const next = out.replace(/^(on|by|due|before|after|at)\s+/, '');
    if (next === out) return out;
    out = next;
  }
}

interface ResolvedDate {
  date: Date;
  /** Time implied by the phrase itself (`eod` → 18:00) when no explicit time was given. */
  implied: TimeOfDay | null;
}

/** Resolve a weekday word with an optional next/this/last prefix. */
function resolveWeekday(prefix: string, word: string, now: Date): Date | null {
  const target = WEEKDAY_ALIASES[word.replace(/\.$/, '')];
  if (target === undefined) return null;
  const base = startOfDay(now);
  const current = now.getDay();
  if (prefix === 'next' || prefix === 'coming') {
    const ahead = ((target - current + 7) % 7) || 7;
    return addDays(base, ahead);
  }
  if (prefix === 'last' || prefix === 'past') {
    const back = ((current - target + 7) % 7) || 7;
    return addDays(base, -back);
  }
  // "this X" (or bare weekday): today counts when it already is X.
  return addDays(base, (target - current + 7) % 7);
}

/** Resolve a month/day (optionally with explicit year) to the nearest future date. */
function resolveMonthDay(monthIdx: number, day: number, year: number | undefined, now: Date): Date | null {
  if (day < 1 || day > 31) return null;
  const thisYear = now.getFullYear();
  const chosenYear = year ?? thisYear;
  if (year === undefined) {
    const candidate = buildLocal(chosenYear, monthIdx + 1, day);
    if (candidate !== null && candidate.getTime() < startOfDay(now).getTime()) {
      return buildLocal(chosenYear + 1, monthIdx + 1, day);
    }
  }
  return buildLocal(chosenYear, monthIdx + 1, day);
}

/** Resolve a bare day-of-month, rolling forward when it would land in the past. */
function resolveBareDay(day: number, now: Date): Date | null {
  if (day < 1 || day > 31) return null;
  const built = buildLocal(now.getFullYear(), now.getMonth() + 1, day);
  const today = startOfDay(now);
  if (built !== null && built.getTime() >= today.getTime()) return built;
  const firstNext = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const dim = daysInMonth(firstNext.getFullYear(), firstNext.getMonth());
  return new Date(firstNext.getFullYear(), firstNext.getMonth(), Math.min(day, dim), 0, 0, 0, 0);
}

/** Map a duration unit token onto milliseconds/flag metadata. */
function unitToShift(n: number, unit: string): { days?: number; months?: number; hours?: number; minutes?: number } {
  switch (unit) {
    case 'd':
    case 'day':
    case 'days':
      return { days: n };
    case 'w':
    case 'week':
    case 'weeks':
      return { days: n * 7 };
    case 'm':
    case 'month':
    case 'months':
      return { months: n };
    case 'h':
    case 'hour':
    case 'hours':
    case 'hr':
    case 'hrs':
      return { hours: n };
    case 'min':
    case 'mins':
    case 'minute':
    case 'minutes':
      return { minutes: n };
    default:
      return {};
  }
}

/**
 * Resolve the cleaned date part (time already stripped) into a concrete date.
 * Returns null when the text is not recognized.
 */
function resolveDatePart(text: string, now: Date): ResolvedDate | null {
  const s = stripPrepositions(text);
  if (s === '') return { date: startOfDay(now), implied: null };
  const today = startOfDay(now);

  // ISO calendar date, optionally with a T-separated time.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t ](\d{1,2}):(\d{2}))?$/.exec(s);
  if (iso) {
    const built = buildLocal(Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4] ?? 0), Number(iso[5] ?? 0));
    return built === null ? null : { date: built, implied: null };
  }

  // Slash/dot dates: YYYY/MM/DD or smart M/D vs D/M when a 4-digit year ends the token.
  const isoSlash = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s);
  if (isoSlash) {
    const built = buildLocal(Number(isoSlash[1]), Number(isoSlash[2]), Number(isoSlash[3]));
    return built === null ? null : { date: built, implied: null };
  }
  const dmy = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s);
  if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    // Ambiguous by nature: values >12 disambiguate, otherwise month-first (US).
    const month1 = a > 12 ? b : a;
    const day = a > 12 ? a : b;
    const built = buildLocal(Number(dmy[3]), month1, day);
    return built === null ? null : { date: built, implied: null };
  }

  // Compact offsets: +3d / -1w / +2m / +4h
  const offset = /^([+-])(\d+)([dwmh])$/.exec(s);
  if (offset) {
    const n = Number.parseInt(offset[2], 10);
    const sign = offset[1] === '-' ? -1 : 1;
    const shift = unitToShift(n, offset[3]);
    // Hour/minute offsets slide the current clock; day-level offsets land on a calendar day.
    let date = shift.hours !== undefined || shift.minutes !== undefined ? new Date(now) : new Date(today);
    if (shift.days !== undefined) date = addDays(date, sign * shift.days);
    if (shift.months !== undefined) date = addMonths(date, sign * shift.months);
    if (shift.hours !== undefined) date = addMinutes(date, sign * shift.hours * 60);
    return { date, implied: null };
  }

  // "in 3 days" / "in 2 weeks" / "in 45 min" and "3 days ago"
  const inRel = /^in\s+(\d+)\s*(days?|d|weeks?|w|months?|m|hours?|hrs?|hr|min(?:ute)?s?)$/.exec(s);
  if (inRel) {
    const n = Number.parseInt(inRel[1], 10);
    const shift = unitToShift(n, inRel[2]);
    let date = new Date(now);
    if (shift.days !== undefined) date = addDays(startOfDay(date), shift.days);
    if (shift.months !== undefined) date = addMonths(startOfDay(date), shift.months);
    if (shift.hours !== undefined) date = addMinutes(date, shift.hours * 60);
    if (shift.minutes !== undefined) date = addMinutes(date, shift.minutes);
    return { date, implied: null };
  }
  const agoRel = /^(\d+)\s*(days?|d|weeks?|w|months?|m)\s+ago$/.exec(s);
  if (agoRel) {
    const n = Number.parseInt(agoRel[1], 10);
    const shift = unitToShift(n, agoRel[2]);
    let date = startOfDay(now);
    if (shift.days !== undefined) date = addDays(date, -shift.days);
    if (shift.months !== undefined) date = addMonths(date, -shift.months);
    return { date, implied: null };
  }

  // Fixed keywords.
  if (s === 'today' || s === 'tod') return { date: today, implied: null };
  if (s === 'tomorrow' || s === 'tmr' || s === 'tmrw') return { date: addDays(today, 1), implied: null };
  if (s === 'yesterday' || s === 'yest') return { date: addDays(today, -1), implied: null };
  if (s === 'now') return { date: new Date(now), implied: null };
  if (s === 'eod') return { date: today, implied: { hour: 18, minute: 0 } };
  if (s === 'eow') {
    const fri = resolveWeekday('', 'fri', now);
    return fri === null ? null : { date: fri, implied: { hour: 17, minute: 0 } };
  }
  if (s === 'weekend') {
    const ahead = ((6 - now.getDay() + 7) % 7) || 7;
    return { date: addDays(today, ahead), implied: null };
  }
  if (s === 'next week') return { date: addDays(today, 7), implied: null };
  if (s === 'last week') return { date: addDays(today, -7), implied: null };
  if (s === 'this week') return { date: today, implied: null };
  if (s === 'next month') return { date: addMonths(today, 1), implied: null };
  if (s === 'last month') return { date: addMonths(today, -1), implied: null };
  if (s === 'next year') return { date: addMonths(today, 12), implied: null };

  // Bare weekday word: "fri", "friday", "sat." (today counts when it is X).
  const singleWord = /^([a-z]+)\.?$/.exec(s);
  if (singleWord) {
    const word = singleWord[1];
    if (WEEKDAY_ALIASES[word] !== undefined) {
      const resolved = resolveWeekday('', word, now);
      if (resolved !== null) return { date: resolved, implied: null };
    }
  }

  // Weekdays with a prefix: "next mon", "last friday", "coming thu".
  const weekday = /^([a-z]+)\s+([a-z]+)\.?$/.exec(s);
  if (weekday) {
    const prefix = weekday[1];
    const word = weekday[2];
    if (WEEKDAY_ALIASES[word] !== undefined) {
      const resolved = resolveWeekday(prefix, word, now);
      if (resolved !== null) return { date: resolved, implied: null };
    }
  }

  // Month + day combinations: "jan 15", "15 january", "feb 3rd 2027", "jan 15, 2027".
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?(?:\s+(\d{4}))?$/.exec(s);
  if (dayFirst && MONTH_ALIASES[dayFirst[2]] !== undefined) {
    const year = dayFirst[3] !== undefined ? Number.parseInt(dayFirst[3], 10) : undefined;
    const resolved = resolveMonthDay(MONTH_ALIASES[dayFirst[2]], Number.parseInt(dayFirst[1], 10), year, now);
    return resolved === null ? null : { date: resolved, implied: null };
  }
  const monthFirst = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(s);
  if (monthFirst && MONTH_ALIASES[monthFirst[1]] !== undefined) {
    const year = monthFirst[3] !== undefined ? Number.parseInt(monthFirst[3], 10) : undefined;
    const resolved = resolveMonthDay(MONTH_ALIASES[monthFirst[1]], Number.parseInt(monthFirst[2], 10), year, now);
    return resolved === null ? null : { date: resolved, implied: null };
  }

  // Bare day of month: "15", "1st", "31".
  const bareDay = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(s);
  if (bareDay) {
    const resolved = resolveBareDay(Number.parseInt(bareDay[1], 10), now);
    return resolved === null ? null : { date: resolved, implied: null };
  }

  return null;
}

/**
 * Parse a natural-language date expression.
 *
 * @param input Raw user text, e.g. `"fri at 3pm"` or `"2026-01-15"`.
 * @param now Reference "current time" (defaults to the real clock; tests pass
 *            a fixed date for determinism).
 * @returns The resolved local `Date`, or null when the expression is not
 *          recognized or lies outside the 1971–2999 sanity window.
 */
export function parseDateExpression(input: string, now: Date = new Date()): Date | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 120) return null;
  const { time, rest } = extractTime(raw);
  const resolved = resolveDatePart(rest, now);
  if (resolved === null) return null;
  const chosen = time ?? resolved.implied;
  const date = chosen !== null ? applyTime(resolved.date, chosen) : resolved.date;
  const year = date.getFullYear();
  if (year < 1971 || year > 2999) return null;
  return date;
}

/** Convenience alias used by commands — identical to {@link parseDateExpression}. */
export function parseDue(input: string, now: Date = new Date()): Date | null {
  return parseDateExpression(input, now);
}

// ---------------------------------------------------------------------------
// Relative labels
// ---------------------------------------------------------------------------

/** Coarse urgency bucket of a due date relative to a reference time. */
export type DueRelation = 'past' | 'today' | 'tomorrow' | 'soon' | 'later';

/** Classify `due` against `now`: past / today / tomorrow / within 3 days / later. */
export function relationOf(due: Date, now: Date): DueRelation {
  const days = calendarDayDiff(due, now);
  if (days < 0) return 'past';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 3) return 'soon';
  return 'later';
}

/**
 * Human-facing due label used in tables:
 * `overdue 2d`, `today 14:30`, `tomorrow`, `friday`, `in 12d`, `2027-01-05`.
 * Returns `—` for null/empty input.
 */
export function describeDue(dueISO: string | null | undefined, now: Date): string {
  const due = parseISODateTime(dueISO);
  if (due === null) return '—';
  const days = calendarDayDiff(due, now);
  const timeSuffix = hasTimeComponent(due) ? ' ' + formatTimeOfDay(due) : '';
  if (days < 0) return `overdue ${-days}d`;
  if (days === 0) return `today${timeSuffix}`;
  if (days === 1) return `tomorrow${timeSuffix}`;
  if (days <= 6) return `${WEEKDAY_FULL[due.getDay()]}${timeSuffix}`;
  if (days <= 29) return `in ${days}d`;
  return formatISODate(due);
}

// ---------------------------------------------------------------------------
// Recurrence rules
// ---------------------------------------------------------------------------

/** Body of an `every …` expression after the keyword is stripped. */
const RECURRENCE_BODY = /^(other\s+)?(\d+)?\s*(days?|d|weeks?|w|months?|m)$/;

/**
 * Parse a recurrence rule expression.
 *
 * Accepted: `daily`, `every day`, `everyday`, `weekly`, `every week`,
 * `biweekly`, `fortnightly`, `every other week`, `monthly`, `every month`,
 * `quarterly`, and `every N days|weeks|months` (N = 1..365).
 *
 * @returns A {@link Recurrence}, or null when the text is not a valid rule.
 */
export function parseRecurrence(input: string | null | undefined): Recurrence | null {
  if (typeof input !== 'string') return null;
  const v = input.trim().toLowerCase();
  if (v === '') return null;
  if (v === 'daily' || v === 'everyday' || v === 'every day') return { freq: 'daily', interval: 1 };
  if (v === 'weekly' || v === 'every week') return { freq: 'weekly', interval: 1 };
  if (v === 'biweekly' || v === 'fortnightly' || v === 'every other week') return { freq: 'weekly', interval: 2 };
  if (v === 'monthly' || v === 'every month') return { freq: 'monthly', interval: 1 };
  if (v === 'quarterly') return { freq: 'monthly', interval: 3 };
  const stripped = v.replace(/^(?:every|each)\s+/, '');
  const m = RECURRENCE_BODY.exec(stripped);
  if (!m) return null;
  const other = m[1] !== undefined;
  const nRaw = m[2] !== undefined ? Number.parseInt(m[2], 10) : 1;
  if (!Number.isFinite(nRaw) || nRaw < 1 || nRaw > MAX_INTERVAL) return null;
  const interval = other ? Math.min(MAX_INTERVAL, nRaw * 2) : nRaw;
  const unit = m[3];
  if (unit === 'd' || unit === 'day' || unit === 'days') return { freq: 'daily', interval };
  if (unit === 'w' || unit === 'week' || unit === 'weeks') return { freq: 'weekly', interval };
  return { freq: 'monthly', interval };
}

/** Render a {@link Recurrence} back into a human-friendly label. */
export function recurrenceLabel(rec: Recurrence): string {
  if (rec.interval === 1) return rec.freq;
  if (rec.interval === 2 && rec.freq === 'weekly') return 'biweekly';
  const unit = rec.freq === 'daily' ? 'days' : rec.freq === 'weekly' ? 'weeks' : 'months';
  return `every ${rec.interval} ${unit}`;
}
