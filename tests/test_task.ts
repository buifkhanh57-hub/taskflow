/**
 * Tests for src/task.ts — construction, validation, lifecycle and rendering.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEdit,
  completeTask,
  createTask,
  dueStateOf,
  estimateLabel,
  isOverdue,
  normalizeProject,
  normalizeTag,
  normalizeTags,
  parseEstimateMinutes,
  reopenTask,
  sanitizeTask,
  taskText,
  nextOccurrence,
} from '../src/task.ts';
import { CliError, type Task } from '../src/types.ts';
import { formatISODateTime, parseISODateTime, parseRecurrence } from '../src/dateparse.ts';
import { isValidId, SHORT_ID_LEN } from '../src/id.ts';

function fixedNow(): Date {
  return new Date(2026, 2, 11, 9, 0, 0); // 2026-03-11 09:00
}

test('normalizeTag trims, lowercases and strips decoration', () => {
  assert.equal(normalizeTag('#Work'), 'work');
  assert.equal(normalizeTag('  Deep Work '), 'deep-work');
  assert.equal(normalizeTag('API/v2'), 'api/v2');
  assert.throws(() => normalizeTag('!!!'), CliError);
  assert.throws(() => normalizeTag('x'.repeat(64)), CliError);
});

test('normalizeTags deduplicates and caps the count', () => {
  assert.deepEqual(normalizeTags('#a, B, b, c'), ['a', 'b', 'c']);
  assert.deepEqual(normalizeTags(['x', 'y']), ['x', 'y']);
  assert.throws(() => normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`)), CliError);
});

test('normalizeProject clears with keywords and slugs the rest', () => {
  assert.equal(normalizeProject('Web App'), 'web-app');
  assert.equal(normalizeProject('none'), null);
  assert.equal(normalizeProject('-'), null);
  assert.equal(normalizeProject(''), null);
  assert.equal(normalizeProject(null), null);
});

test('parseEstimateMinutes parses the accepted sizes', () => {
  assert.equal(parseEstimateMinutes('30m'), 30);
  assert.equal(parseEstimateMinutes('45'), 45);
  assert.equal(parseEstimateMinutes('2h'), 120);
  assert.equal(parseEstimateMinutes('2h30m'), 150);
  assert.equal(parseEstimateMinutes('1d'), 1440);
  assert.equal(parseEstimateMinutes(''), null);
  assert.equal(parseEstimateMinutes('none'), null);
  assert.throws(() => parseEstimateMinutes('2(parse)h'), CliError);
  assert.throws(() => parseEstimateMinutes('-5'), CliError);
});

test('estimateLabel formats compactly', () => {
  assert.equal(estimateLabel(45), '45m');
  assert.equal(estimateLabel(120), '2h');
  assert.equal(estimateLabel(150), '2h30m');
  assert.equal(estimateLabel(1440), '1d');
  assert.equal(estimateLabel(null), '—');
});

test('createTask applies defaults and validation', () => {
  const now = fixedNow();
  const task = createTask({ title: '  Fix   the  bug  ' }, now);
  assert.equal(task.title, 'Fix the bug');
  assert.equal(task.status, 'todo');
  assert.equal(task.priority, 'P2');
  assert.equal(task.due, null);
  assert.equal(task.recurrence, null);
  assert.ok(isValidId(task.id));
  assert.equal(task.createdAt, formatISODateTime(now));
  assert.equal(task.completedAt, null);

  const dated = createTask({ title: 'X', priority: 'urgent', due: 'tomorrow', tags: 'a,b' }, now);
  assert.equal(dated.priority, 'P0');
  assert.equal(dated.due, '2026-03-12');
  assert.deepEqual(dated.tags, ['a', 'b']);

  assert.throws(() => createTask({ title: '' }, now), CliError);
  assert.throws(() => createTask({ title: 'X', priority: 'P9' }, now), CliError);
  assert.throws(() => createTask({ title: 'X', due: 'nope' }, now), CliError);
  assert.throws(() => createTask({ title: 'X', recurrence: 'weekly' }, now), CliError);
  const recurring = createTask({ title: 'X', recurrence: 'weekly', due: 'monday' }, now);
  assert.deepEqual(recurring.recurrence, { freq: 'weekly', interval: 1 });
});

test('nextOccurrence advances daily, weekly and monthly rules', () => {
  const due = new Date(2026, 0, 31);
  assert.deepEqual(nextOccurrence(due, { freq: 'daily', interval: 3 }), new Date(2026, 1, 3));
  assert.deepEqual(nextOccurrence(due, { freq: 'weekly', interval: 1 }), new Date(2026, 1, 7));
  // Monthly clamps Jan 31 → Feb 28.
  assert.deepEqual(nextOccurrence(due, { freq: 'monthly', interval: 1 }), new Date(2026, 1, 28));
});

test('completeTask stamps completion and spawns recurring occurrences', () => {
  const now = fixedNow();
  const plain = createTask({ title: 'One-off', due: 'today' }, new Date(2026, 2, 10));
  const plainDone = completeTask(plain, now);
  assert.equal(plainDone.task.status, 'done');
  assert.equal(plainDone.task.completedAt, formatISODateTime(now));
  assert.equal(plainDone.spawned, null);

  const rec = createTask({ title: 'Chore', due: '2026-03-09', recurrence: 'weekly' }, new Date(2026, 2, 1));
  const recDone = completeTask(rec, now);
  assert.ok(recDone.spawned !== null);
  assert.equal(recDone.spawned.due, '2026-03-16');
  assert.equal(recDone.spawned.status, 'todo');
  assert.equal(recDone.spawned.recurringParent, rec.id);
  assert.notEqual(recDone.spawned.id, rec.id);
});

test('reopenTask clears the completion stamp', () => {
  const now = fixedNow();
  const task = createTask({ title: 'X' }, now);
  const done = completeTask(task, now).task;
  const back = reopenTask(done, now);
  assert.equal(back.status, 'todo');
  assert.equal(back.completedAt, null);
  assert.equal(back.updatedAt, formatISODateTime(now));
});

test('applyEdit patches fields and keeps lifecycle stamps consistent', () => {
  const now = fixedNow();
  const task = createTask({ title: 'X', tags: 'a,b', project: 'p1', due: 'tomorrow' }, now);
  const edited = applyEdit(
    task,
    { title: 'Y', priority: 'P1', tags: 'c', project: 'none', due: 'none', estimate: '2h' },
    now,
  );
  assert.equal(edited.title, 'Y');
  assert.equal(edited.priority, 'P1');
  assert.deepEqual(edited.tags, ['c']);
  assert.equal(edited.project, null);
  assert.equal(edited.due, null);
  assert.equal(edited.estimateMinutes, 120);

  const done = applyEdit(task, { status: 'done' }, now);
  assert.equal(done.status, 'done');
  assert.ok(done.completedAt !== null);
  const reopened = applyEdit(done, { status: 'todo' }, now);
  assert.equal(reopened.completedAt, null);

  assert.throws(() => applyEdit(task, { priority: 'nope' }, now), CliError);
  assert.throws(() => applyEdit(task, { due: 'zzz' }, now), CliError);
});

test('isOverdue and dueStateOf classify urgency buckets', () => {
  const now = fixedNow(); // 2026-03-11 09:00
  const mk = (due: string | null, status = 'todo'): Task =>
    createTask({ title: 'T', due, status }, new Date(2026, 2, 1));
  assert.equal(dueStateOf(mk('2026-03-09'), now), 'overdue');
  assert.equal(isOverdue(mk('2026-03-09'), now), true);
  // Done tasks are never overdue.
  assert.equal(isOverdue(mk('2026-03-09', 'done'), now), false);
  assert.equal(dueStateOf(mk('2026-03-11'), now), 'today');
  assert.equal(dueStateOf(mk('2026-03-12'), now), 'tomorrow');
  assert.equal(dueStateOf(mk('2026-03-13'), now), 'soon');
  assert.equal(dueStateOf(mk('2026-03-20'), now), 'later');
  assert.equal(dueStateOf(mk(null), now), 'none');
});

test('taskText joins the searchable haystack', () => {
  const task = createTask({ title: 'Ship the API', notes: 'rate limits', tags: 'infra', project: 'core' }, fixedNow());
  const hay = taskText(task);
  assert.ok(hay.includes('ship the api'));
  assert.ok(hay.includes('rate limits'));
  assert.ok(hay.includes('infra'));
  assert.ok(hay.includes('core'));
});

test('sanitizeTask repairs hostile input without crashing', () => {
  const now = fixedNow();
  const repaired = sanitizeTask(
    {
      id: 'garbage',
      title: '   ',
      status: 'bogus',
      priority: 99,
      tags: 'not,an,array',
      due: 'yesterday-not-a-date',
      estimateMinutes: Number.NaN,
      recurrence: { freq: 'annually', interval: 1 },
    },
    now,
  );
  assert.equal(repaired.title, '(untitled task)');
  assert.equal(repaired.status, 'todo');
  assert.equal(repaired.priority, 'P2');
  assert.deepEqual(repaired.tags, []);
  assert.equal(repaired.due, null);
  assert.equal(repaired.estimateMinutes, null);
  assert.equal(repaired.recurrence, null);
  assert.ok(isValidId(repaired.id) === false || repaired.id === 'garbage'); // id kept as-is when non-empty

  const good = sanitizeTask(
    {
      title: 'Real task',
      status: 'done',
      completedAt: '2026-03-10T10:00',
      createdAt: '2026-03-01T08:00',
      recurrence: 'every 2 weeks',
      estimateMinutes: 45,
    },
    now,
  );
  assert.equal(good.title, 'Real task');
  assert.equal(good.status, 'done');
  assert.equal(good.completedAt, '2026-03-10T10:00');
  assert.deepEqual(good.recurrence, parseRecurrence('every 2 weeks'));
  assert.equal(good.estimateMinutes, 45);
});

test('ids generated in the same millisecond keep unique short prefixes', () => {
  const t = Date.now();
  const seen = new Set<string>();
  for (let i = 0; i < 50; i += 1) {
    const task = createTask({ title: `bulk ${i}` }, new Date(t));
    seen.add(task.id.slice(0, SHORT_ID_LEN));
  }
  assert.equal(seen.size, 50);
});
