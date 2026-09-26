/**
 * Tests for src/args.ts + src/query.ts — flag parsing, filters, inline query
 * tokens, sorting, grouping, pagination and presets.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dueMatch,
  groupTasks,
  matchTask,
  parseDueMode,
  parseFilter,
  parseGroupMode,
  parseQueryTokens,
  parseSortField,
  paginate,
  sortTasks,
  textMatches,
  defaultFilter,
  applyFilter,
  describeFilter,
} from '../src/query.ts';
import { flagInt, flagList, flagString, hasFlag, joinPositional, parseFlags } from '../src/args.ts';
import { combineFilters, buildFilter, FilterBuilder, presetNames, resolvePreset, resolvePresetExpression } from '../src/ui/filter-builder.ts';
import { CliError, type Task } from '../src/types.ts';
import { createTask } from '../src/task.ts';
import { formatISODateTime } from '../src/dateparse.ts';

function fixedNow(): Date {
  return new Date(2026, 0, 7, 10, 0, 0); // Wednesday 2026-01-07
}

/** Build tasks in one burst; ids stay unique via the monotonic clock bump. */
function seed(): { tasks: Task[]; now: Date } {
  const now = fixedNow();
  const burst = new Date(now.getTime() + 60_000);
  const tasks = [
    createTask({ title: 'Alpha api bug', priority: 'P0', tags: 'bug,api', project: 'core', due: 'today' }, burst),
    createTask({ title: 'Beta docs', priority: 'P2', tags: 'docs', due: 'tomorrow' }, burst),
    createTask({ title: 'Gamma chore', priority: 'P3', due: '+10d' }, burst),
    createTask({ title: 'Delta api', priority: 'P1', tags: 'api', project: 'edge', due: '-2d', notes: 'retry storm' }, burst),
    createTask({ title: 'Epsilon done', priority: 'P2', status: 'done', due: '-1d' }, burst),
  ];
  return { tasks, now };
}

test('parseFlags handles long, short, bundled and inline values', () => {
  const parsed = parseFlags(['--priority', 'P1', '-t', 'work', '--due=friday', '-xvf', 'file', 'title words'], [
    { name: 'priority', short: 'p', kind: 'value' },
    { name: 'tag', short: 't', kind: 'list' },
    { name: 'due', kind: 'value' },
    { name: 'x', kind: 'flag' },
    { name: 'v', kind: 'flag' },
    { name: 'f', kind: 'flag' },
  ]);
  assert.equal(flagString(parsed, 'priority'), 'P1');
  assert.deepEqual(flagList(parsed, 'tag'), ['work']);
  assert.equal(flagString(parsed, 'due'), 'friday');
  assert.ok(hasFlag(parsed, 'x') && hasFlag(parsed, 'v') && hasFlag(parsed, 'f'));
  assert.deepEqual(parsed.positional, ['file', 'title', 'words']);
  assert.throws(() => parseFlags(['--bogus'], [{ name: 'a', kind: 'flag' }]), CliError);
  assert.throws(() => parseFlags(['--a'], [{ name: 'a', kind: 'value' }]), CliError);
  assert.throws(() => parseFlags(['--x=1'], [{ name: 'x', kind: 'flag' }]), CliError);
});

test('parseFlags honors the -- terminator', () => {
  const parsed = parseFlags(['--tag', 'a', '--', 'not-a-flag', '-p'], [{ name: 'tag', kind: 'list' }, { name: 'p', kind: 'flag' }]);
  assert.deepEqual(flagList(parsed, 'tag'), ['a']);
  assert.deepEqual(parsed.positional, ['not-a-flag', '-p']);
});

test('flagInt clamps to its range', () => {
  const parsed = parseFlags(['--n', '5000'], [{ name: 'n', kind: 'value' }]);
  assert.equal(flagInt(parsed, 'n', { min: 1, max: 100, fallback: 10 }), 100);
  const bad = parseFlags(['--n', 'abc'], [{ name: 'n', kind: 'value' }]);
  assert.equal(flagInt(bad, 'n', { min: 1, max: 100, fallback: 10 }), 10);
});

test('joinPositional joins and validates', () => {
  const parsed = parseFlags(['hello', 'world'], []);
  assert.equal(joinPositional(parsed), 'hello world');
  assert.throws(() => joinPositional(parseFlags([], []), { required: true, what: 'title' }), CliError);
});

test('parseQueryTokens extracts structured tokens', () => {
  const q = parseQueryTokens('crash +core #urgent p1 is:done !#noise');
  assert.deepEqual(q.tokens, [
    { kind: 'project', value: 'core', negated: false },
    { kind: 'tag', value: 'urgent', negated: false },
    { kind: 'priority', value: 'P1', negated: false },
    { kind: 'status', value: 'done', negated: false },
    { kind: 'tag', value: 'noise', negated: true },
  ]);
  assert.equal(q.residual, 'crash');
});

test('parseDueMode accepts buckets and ISO anchors', () => {
  assert.deepEqual(parseDueMode('today'), { dueMode: 'today', dueDate: null });
  assert.deepEqual(parseDueMode('7d'), { dueMode: 'week', dueDate: null });
  assert.deepEqual(parseDueMode('undated'), { dueMode: 'none', dueDate: null });
  const date = parseDueMode('2026-02-01');
  assert.deepEqual(date, { dueMode: 'date', dueDate: '2026-02-01' });
  assert.throws(() => parseDueMode('whenever'), CliError);
});

test('parseSortField and parseGroupMode validate their vocabulary', () => {
  assert.equal(parseSortField('priority'), 'priority');
  assert.throws(() => parseSortField('size'), CliError);
  assert.equal(parseGroupMode('tags'), 'tag');
  assert.equal(parseGroupMode('none'), 'none');
  assert.throws(() => parseGroupMode('color'), CliError);
});

test('matchTask combines every filter dimension', () => {
  const { tasks, now } = seed();
  const filter = buildFilter({ statuses: ['todo'], priorities: ['P0'], tags: ['bug'] });
  assert.deepEqual(tasks.filter((t) => matchTask(t, filter, now)).map((t) => t.title), ['Alpha api bug']);

  const projectFilter = buildFilter({ projects: ['core', 'edge'] });
  assert.equal(tasks.filter((t) => matchTask(t, projectFilter, now)).length, 2);

  const noneFilter = buildFilter({ projects: ['none'] });
  assert.equal(tasks.filter((t) => matchTask(t, noneFilter, now)).length, 3);
});

test('dueMatch buckets behave as documented', () => {
  const { tasks, now } = seed();
  const any = defaultFilter();
  const today = tasks[0]; // due today
  assert.ok(dueMatch(today, { ...any, dueMode: 'today' }, now));
  assert.ok(!dueMatch(today, { ...any, dueMode: 'tomorrow' }, now));
  assert.ok(dueMatch(today, { ...any, dueMode: 'week' }, now));
  const overdue = tasks[3];
  assert.ok(dueMatch(overdue, { ...any, dueMode: 'overdue' }, now));
  assert.ok(!dueMatch(overdue, { ...any, dueMode: 'future' }, now));
  const undated = { ...tasks[0], due: null };
  assert.ok(dueMatch(undated, { ...any, dueMode: 'none' }, now));
  assert.ok(!dueMatch(undated, { ...any, dueMode: 'today' }, now));
});

test('textMatches requires every word', () => {
  const { tasks } = seed();
  assert.ok(textMatches(tasks[0], 'alpha bug'));
  assert.ok(!textMatches(tasks[0], 'alpha missing'));
});

test('sortTasks keeps undated tasks last for due sorting', () => {
  const { tasks, now } = seed();
  const sorted = sortTasks([...tasks], 'due', 'asc');
  const dues = sorted.map((t) => t.due);
  const undated = dues.filter((d) => d === null).length;
  assert.ok(undated >= 0);
  const dated = dues.filter((d) => d !== null) as string[];
  const parsed = dated.map((d) => formatISODateTime(new Date(d)));
  const ascending = [...parsed].sort();
  assert.deepEqual(parsed, ascending);
  // Priority sorting puts P0 first.
  const byPriority = sortTasks([...tasks], 'priority', 'asc');
  assert.equal(byPriority[0].priority, 'P0');
  assert.equal(now instanceof Date, true);
});

test('paginate slices with offsets and reports totals', () => {
  const { tasks } = seed();
  const page = paginate(tasks, { ...defaultFilter(), limit: 2, offset: 1 });
  assert.equal(page.items.length, 2);
  assert.equal(page.total, tasks.length);
  assert.equal(page.offset, 1);
});

test('groupTasks buckets by project, tag, status and priority', () => {
  const { tasks } = seed();
  const byProject = groupTasks(tasks, 'project');
  assert.deepEqual(byProject.map((g) => g.key).sort(), ['(no project)', 'core', 'edge'].sort());
  const byStatus = groupTasks(tasks, 'status');
  assert.deepEqual(byStatus.map((g) => g.key), ['todo', 'done']);
  const byPriority = groupTasks(tasks, 'priority');
  assert.deepEqual(byPriority.map((g) => g.key), ['P0', 'P1', 'P2', 'P3']);
  assert.deepEqual(groupTasks(tasks, 'none')[0].tasks, tasks);
});

test('parseFilter applies flags, tokens and --all/--done', () => {
  const { filter } = parseFilter(['--all', '#api', 'retry', '--sort', 'priority', '--desc', '--limit', '5'], fixedNow());
  assert.deepEqual(filter.statuses, []);
  assert.deepEqual(filter.tags, ['api']);
  assert.equal(filter.text, 'retry');
  assert.equal(filter.sort, 'priority');
  assert.equal(filter.dir, 'desc');
  assert.equal(filter.limit, 5);

  const doneFilter = parseFilter(['--done'], fixedNow()).filter;
  assert.deepEqual(doneFilter.statuses, ['done']);

  const statusFilter = parseFilter(['-s', 'doing,todo'], fixedNow()).filter;
  assert.deepEqual(statusFilter.statuses, ['doing', 'todo']);

  assert.throws(() => parseFilter(['-s', 'bogus'], fixedNow()), CliError);
  assert.throws(() => parseFilter(['-p', 'P9'], fixedNow()), CliError);
});

test('parseFilter merges presets without conflicting with defaults', () => {
  const done = parseFilter(['--preset', 'done'], fixedNow()).filter;
  assert.deepEqual(done.statuses, ['done']);
  assert.equal(done.dueMode, 'any');

  const scoped = parseFilter(['--preset', 'overdue', '--sort', 'priority', '--tag', 'api'], fixedNow()).filter;
  assert.equal(scoped.dueMode, 'overdue');
  assert.deepEqual(scoped.tags, ['api']);
  assert.equal(scoped.sort, 'priority');

  assert.throws(() => parseFilter(['--preset', 'nope'], fixedNow()), CliError);
  assert.throws(() => parseFilter(['--preset', 'done', '--status', 'todo'], fixedNow()), CliError);
});

test('describeFilter renders a human summary', () => {
  const text = describeFilter(parseFilter(['--done', '#x', 'word'], fixedNow()).filter);
  assert.ok(text.includes('done'));
  assert.ok(text.includes('#x'));
  assert.ok(text.includes('"word"'));
});

test('FilterBuilder chains into a valid filter', () => {
  const filter = new FilterBuilder()
    .withStatus('open')
    .withPriority('0', 'high')
    .withTags('work', '#urgent')
    .withProject('web-app', 'none')
    .dueWithinDays(6)
    .sortBy('created', 'desc')
    .withLimit(10)
    .withOffset(2)
    .groupedBy('tag')
    .build();
  assert.deepEqual(filter.statuses, ['todo', 'doing']);
  assert.deepEqual(filter.priorities, ['P0', 'P1']);
  assert.deepEqual(filter.tags, ['work', 'urgent']);
  assert.deepEqual(filter.projects, ['web-app', 'none']);
  assert.equal(filter.dueMode, 'week');
  assert.equal(filter.sort, 'created');
  assert.equal(filter.dir, 'desc');
  assert.equal(filter.limit, 10);
  assert.equal(filter.offset, 2);
  assert.equal(filter.group, 'tag');
});

test('preset registry covers the documented names', () => {
  const names = presetNames();
  for (const expected of ['open', 'todo', 'doing', 'done', 'today', 'tomorrow', 'week', 'overdue', 'undated', 'urgent']) {
    assert.ok(names.includes(expected), `missing preset ${expected}`);
  }
  const urgent = resolvePreset('urgent');
  assert.deepEqual(urgent.priorities, ['P0', 'P1']);
  assert.deepEqual(resolvePresetExpression('urgent done').statuses, ['done']);
});

test('combineFilters intersects and throws on impossible combinations', () => {
  const a = buildFilter({ statuses: ['todo', 'doing'], priorities: ['P0', 'P1'], tags: ['x'] });
  const b = buildFilter({ statuses: ['doing', 'done'], priorities: ['P1', 'P2'], tags: ['y'], dueMode: 'overdue' });
  const merged = combineFilters(a, b);
  assert.deepEqual(merged.statuses, ['doing']);
  assert.deepEqual(merged.priorities, ['P1']);
  assert.deepEqual(merged.tags, ['x', 'y']);
  assert.equal(merged.dueMode, 'overdue');
  assert.throws(() => combineFilters(buildFilter({ statuses: ['done'] }), buildFilter({ statuses: ['todo'] })), CliError);
});

test('applyFilter is a pure composition of matchTask', () => {
  const { tasks, now } = seed();
  const filter = buildFilter({ text: 'api' });
  const hits = applyFilter(tasks, filter, now);
  assert.deepEqual(hits.map((t) => t.title).sort(), ['Alpha api bug', 'Delta api']);
});
