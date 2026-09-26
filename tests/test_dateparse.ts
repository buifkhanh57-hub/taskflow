/**
 * Tests for src/dateparse.ts — calendar primitives, expression parsing,
 * recurrence rules and relative labels. All cases pin `now` for determinism.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays,
  addMonths,
  calendarDayDiff,
  daysInMonth,
  describeDue,
  extractTime,
  formatISODate,
  formatISODateTime,
  parseDateExpression,
  parseISODateTime,
  parseRecurrence,
  recurrenceLabel,
  startOfDay,
  startOfWeek,
  toDueISO,
} from '../src/dateparse.ts';

/** Fixed reference: Wednesday 2026-01-07, 10:30 local. */
function fixedNow(): Date {
  return new Date(2026, 0, 7, 10, 30, 0);
}

test('daysInMonth handles ordinary and leap years', () => {
  assert.equal(daysInMonth(2026, 0), 31);
  assert.equal(daysInMonth(2026, 3), 30);
  assert.equal(daysInMonth(2026, 1), 28);
  assert.equal(daysInMonth(2024, 1), 29);
  assert.equal(daysInMonth(2000, 1), 29);
  assert.equal(daysInMonth(1900, 1), 28);
});

test('startOfDay / startOfWeek use Monday as week start', () => {
  const now = fixedNow(); // Wednesday
  assert.equal(formatISODateTime(startOfDay(now)), '2026-01-07T00:00');
  const monday = startOfWeek(now);
  assert.equal(formatISODate(monday), '2026-01-05');
  assert.equal(monday.getDay(), 1);
});

test('addDays preserves the time of day', () => {
  const now = fixedNow();
  const later = addDays(now, 3);
  assert.equal(formatISODateTime(later), '2026-01-10T10:30');
  const before = addDays(now, -10);
  assert.equal(formatISODate(before), '2025-12-28');
});

test('addMonths clamps day-of-month in shorter months', () => {
  const jan31 = new Date(2026, 0, 31, 8, 0);
  assert.equal(formatISODate(addMonths(jan31, 1)), '2026-02-28');
  assert.equal(formatISODate(addMonths(jan31, 13)), '2027-02-28');
  assert.equal(formatISODate(addMonths(new Date(2024, 0, 31), 1)), '2024-02-29');
  assert.equal(formatISODate(addMonths(new Date(2026, 4, 15), -6)), '2025-11-15');
});

test('calendarDayDiff counts whole calendar days', () => {
  const a = new Date(2026, 0, 10, 1, 0);
  const b = new Date(2026, 0, 7, 23, 0);
  assert.equal(calendarDayDiff(a, b), 3);
  assert.equal(calendarDayDiff(b, a), -3);
});

test('parseISODateTime accepts stored shapes and rejects garbage', () => {
  const date = parseISODateTime('2026-03-05T14:30');
  assert.ok(date !== null);
  assert.equal(formatISODateTime(date), '2026-03-05T14:30');
  const plain = parseISODateTime('2026-03-05');
  assert.ok(plain !== null);
  assert.equal(formatISODate(plain), '2026-03-05');
  assert.equal(parseISODateTime('nope'), null);
  assert.equal(parseISODateTime('2026-13-40'), null);
  assert.equal(parseISODateTime(''), null);
  assert.equal(parseISODateTime(undefined), null);
});

test('toDueISO omits the time for midnight dates', () => {
  assert.equal(toDueISO(new Date(2026, 5, 1)), '2026-06-01');
  assert.equal(toDueISO(new Date(2026, 5, 1, 9, 15)), '2026-06-01T09:15');
});

test('extractTime pulls times out of phrases', () => {
  const at = extractTime('friday at 3pm');
  assert.ok(at.time !== null);
  assert.equal(at.time.hour, 15);
  assert.equal(at.rest, 'friday');
  const hm = extractTime('meeting 14:30');
  assert.ok(hm.time !== null);
  assert.equal(hm.time.hour, 14);
  assert.equal(hm.time.minute, 30);
  const noon = extractTime('submit noon');
  assert.ok(noon.time !== null);
  assert.equal(noon.time.hour, 12);
  const none = extractTime('next week');
  assert.equal(none.time, null);
});

test('parseDateExpression resolves fixed keywords', () => {
  const now = fixedNow();
  assert.equal(formatISODate(parseDateExpression('today', now)), '2026-01-07');
  assert.equal(formatISODate(parseDateExpression('tomorrow', now)), '2026-01-08');
  assert.equal(formatISODate(parseDateExpression('yesterday', now)), '2026-01-06');
  assert.equal(formatISODate(parseDateExpression('next week', now)), '2026-01-14');
  assert.equal(formatISODate(parseDateExpression('last week', now)), '2025-12-31');
  assert.equal(formatISODate(parseDateExpression('next month', now)), '2026-02-07');
  assert.equal(formatISODate(parseDateExpression('weekend', now)), '2026-01-10');
});

test('parseDateExpression resolves weekdays including bare short forms', () => {
  const now = fixedNow(); // Wednesday
  assert.equal(formatISODate(parseDateExpression('fri', now)), '2026-01-09');
  assert.equal(formatISODate(parseDateExpression('friday', now)), '2026-01-09');
  assert.equal(formatISODate(parseDateExpression('mon', now)), '2026-01-12');
  assert.equal(formatISODate(parseDateExpression('tuesday.', now)), '2026-01-13');
  assert.equal(formatISODate(parseDateExpression('next mon', now)), '2026-01-12');
  assert.equal(formatISODate(parseDateExpression('last saturday', now)), '2026-01-03');
});

test('parseDateExpression combines weekdays with times', () => {
  const now = fixedNow();
  const due = parseDateExpression('fri 3pm', now);
  assert.ok(due !== null);
  assert.equal(formatISODateTime(due), '2026-01-09T15:00');
  const eod = parseDateExpression('eod', now);
  assert.ok(eod !== null);
  assert.equal(formatISODateTime(eod), '2026-01-07T18:00');
});

test('parseDateExpression resolves offsets', () => {
  const now = fixedNow();
  assert.equal(formatISODate(parseDateExpression('+3d', now)), '2026-01-10');
  assert.equal(formatISODate(parseDateExpression('-1w', now)), '2025-12-31');
  assert.equal(formatISODate(parseDateExpression('+2m', now)), '2026-03-07');
  assert.equal(formatISODate(parseDateExpression('in 3 days', now)), '2026-01-10');
  assert.equal(formatISODate(parseDateExpression('in 2 weeks', now)), '2026-01-21');
  assert.equal(formatISODate(parseDateExpression('5 days ago', now)), '2026-01-02');
  const hours = parseDateExpression('+4h', now);
  assert.ok(hours !== null);
  assert.equal(hours.getHours(), 14);
});

test('parseDateExpression resolves calendar dates', () => {
  const now = fixedNow();
  assert.equal(formatISODate(parseDateExpression('2026-01-15', now)), '2026-01-15');
  assert.equal(formatISODate(parseDateExpression('2026/02/03', now)), '2026-02-03');
  assert.equal(formatISODate(parseDateExpression('15.01.2026', now)), '2026-01-15');
  assert.equal(formatISODate(parseDateExpression('jan 20', now)), '2026-01-20');
  assert.equal(formatISODate(parseDateExpression('20 january', now)), '2026-01-20');
  assert.equal(formatISODate(parseDateExpression('mar 3rd 2027', now)), '2027-03-03');
  assert.equal(formatISODate(parseDateExpression('15', now)), '2026-01-15');
  // Past day-of-month rolls to the next month.
  assert.equal(formatISODate(parseDateExpression('2', now)), '2026-02-02');
});

test('parseDateExpression rejects nonsense and out-of-window dates', () => {
  const now = fixedNow();
  assert.equal(parseDateExpression('notadate', now), null);
  assert.equal(parseDateExpression('', now), null);
  assert.equal(parseDateExpression('1970-01-01', now), null);
  assert.equal(parseDateExpression('x'.repeat(200), now), null);
  assert.equal(parseDateExpression('2026-02-30', now), null);
});

test('parseRecurrence understands the advertised vocabulary', () => {
  assert.deepEqual(parseRecurrence('daily'), { freq: 'daily', interval: 1 });
  assert.deepEqual(parseRecurrence('every day'), { freq: 'daily', interval: 1 });
  assert.deepEqual(parseRecurrence('weekly'), { freq: 'weekly', interval: 1 });
  assert.deepEqual(parseRecurrence('biweekly'), { freq: 'weekly', interval: 2 });
  assert.deepEqual(parseRecurrence('every other week'), { freq: 'weekly', interval: 2 });
  assert.deepEqual(parseRecurrence('monthly'), { freq: 'monthly', interval: 1 });
  assert.deepEqual(parseRecurrence('quarterly'), { freq: 'monthly', interval: 3 });
  assert.deepEqual(parseRecurrence('every 3 days'), { freq: 'daily', interval: 3 });
  assert.deepEqual(parseRecurrence('every 2 weeks'), { freq: 'weekly', interval: 2 });
  assert.deepEqual(parseRecurrence('every 6 months'), { freq: 'monthly', interval: 6 });
  assert.equal(parseRecurrence('whenever'), null);
  assert.equal(parseRecurrence('every 0 days'), null);
  assert.equal(parseRecurrence(''), null);
  assert.equal(parseRecurrence(null), null);
});

test('recurrenceLabel renders compact human text', () => {
  assert.equal(recurrenceLabel({ freq: 'daily', interval: 1 }), 'daily');
  assert.equal(recurrenceLabel({ freq: 'weekly', interval: 2 }), 'biweekly');
  assert.equal(recurrenceLabel({ freq: 'daily', interval: 3 }), 'every 3 days');
  assert.equal(recurrenceLabel({ freq: 'monthly', interval: 6 }), 'every 6 months');
});

test('describeDue produces the documented relative labels', () => {
  const now = fixedNow();
  assert.equal(describeDue('2026-01-05', now), 'overdue 2d');
  assert.equal(describeDue('2026-01-07', now), 'today');
  assert.equal(describeDue('2026-01-07T15:00', now), 'today 15:00');
  assert.equal(describeDue('2026-01-08', now), 'tomorrow');
  assert.equal(describeDue('2026-01-09', now), 'friday');
  assert.equal(describeDue('2026-01-20', now), 'in 13d');
  assert.equal(describeDue('2027-01-07', now), '2027-01-07');
  assert.equal(describeDue(null, now), '—');
});
