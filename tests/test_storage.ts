/**
 * Tests for src/storage.ts — data dir resolution, atomic persistence, backup
 * rotation, corruption recovery and the CRUD helpers. Uses disposable temp
 * directories; never touches a real ~/.taskflow.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  backupFile,
  emptyStore,
  findTaskMatches,
  listAllTasks,
  loadStore,
  mainFile,
  mergeTasks,
  patchTask,
  removeTasks,
  requireTask,
  resolveDataDir,
  saveStore,
  storeInfo,
  withStore,
} from '../src/storage.ts';
import { createTask, sanitizeTask } from '../src/task.ts';
import { CliError, type StoreFile, type Task } from '../src/types.ts';
import { formatISODateTime } from '../src/dateparse.ts';
import { DATA_ENV } from '../src/storage.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-test-'));
}

function fixedNow(): Date {
  return new Date(2026, 4, 4, 8, 0, 0);
}

test('resolveDataDir precedence: flag > env > home default', () => {
  const original = process.env[DATA_ENV];
  try {
    delete process.env[DATA_ENV];
    assert.ok(resolveDataDir().endsWith('.taskflow'));
    process.env[DATA_ENV] = '/tmp/env-override';
    assert.equal(resolveDataDir(), '/tmp/env-override');
    assert.equal(resolveDataDir('/tmp/flag-override'), '/tmp/flag-override');
  } finally {
    if (original === undefined) delete process.env[DATA_ENV];
    else process.env[DATA_ENV] = original;
  }
});

test('saveStore writes atomically and creates the directory', () => {
  const dir = path.join(tmpDir(), 'nested', 'data');
  const now = fixedNow();
  const store: StoreFile = { version: 1, tasks: [], savedAt: '' };
  saveStore(dir, store, now);
  assert.ok(fs.existsSync(mainFile(dir)));
  const written = JSON.parse(fs.readFileSync(mainFile(dir), 'utf8'));
  assert.equal(written.savedAt, formatISODateTime(now));
  assert.equal(written.version, 1);
  // No temp files left behind.
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('loadStore returns an empty store on first run', () => {
  const dir = tmpDir();
  const result = loadStore(dir, fixedNow());
  assert.equal(result.recovered, false);
  assert.equal(result.warning, null);
  assert.deepEqual(result.store.tasks, []);
});

test('withStore mutates and persists in one shot', () => {
  const dir = tmpDir();
  const now = fixedNow();
  const task = createTask({ title: 'Persisted' }, now);
  withStore(dir, (tasks) => ({ tasks: [...tasks, task], result: undefined }), now);
  const again = listAllTasks(dir, now);
  assert.equal(again.length, 1);
  assert.equal(again[0].title, 'Persisted');
});

test('rotating backups keep the last three states', () => {
  const dir = tmpDir();
  const now = fixedNow();
  for (let i = 0; i < 5; i += 1) {
    const store = emptyStore();
    store.tasks = [createTask({ title: `gen-${i}` }, now)];
    saveStore(dir, store, now);
  }
  const backups = [1, 2, 3].filter((n) => fs.existsSync(backupFile(dir, n)));
  assert.deepEqual(backups, [1, 2, 3]);
  // bak.1 is the state just before the last write (gen-3); gen-4 is live.
  const bak1 = JSON.parse(fs.readFileSync(backupFile(dir, 1), 'utf8'));
  assert.equal(bak1.tasks[0].title, 'gen-3');
  const live = JSON.parse(fs.readFileSync(mainFile(dir), 'utf8'));
  assert.equal(live.tasks[0].title, 'gen-4');
});

test('loadStore recovers from a corrupt main file via backups', () => {
  const dir = tmpDir();
  const now = fixedNow();
  const store = emptyStore();
  store.tasks = [createTask({ title: 'Survivor' }, now)];
  saveStore(dir, store, now); // creates bak.1 (empty) + live (1 task)
  const second = emptyStore();
  second.tasks = [createTask({ title: 'Survivor' }, now), createTask({ title: 'Second' }, now)];
  saveStore(dir, second, now); // live = 2 tasks, bak.1 = 1 task, bak.2 = empty

  fs.writeFileSync(mainFile(dir), '{corrupt!!', 'utf8');
  const result = loadStore(dir, now);
  assert.equal(result.recovered, true);
  assert.ok(result.warning !== null && result.warning.includes('recovered'));
  assert.equal(result.store.tasks.length, 1);
  assert.equal(result.store.tasks[0].title, 'Survivor');
  // The recovered file is in place again.
  assert.equal(loadStore(dir, now).store.tasks.length, 1);
});

test('loadStore quarantines a store that no backup can fix', () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(mainFile(dir), 'not json at all', 'utf8');
  const result = loadStore(dir, fixedNow());
  assert.equal(result.recovered, true);
  assert.equal(result.store.tasks.length, 0);
  assert.ok(result.warning !== null && (result.warning.includes('quarantined') || result.warning.includes('unreadable')));
  const quarantined = fs.readdirSync(dir).filter((f) => f.startsWith('tasks.json.corrupt-'));
  assert.equal(quarantined.length, 1);
});

test('requireTask resolves prefixes and reports ambiguity', () => {
  const tasks: Task[] = [
    createTask({ title: 'One' }, new Date(2026, 0, 1)),
    createTask({ title: 'Two' }, new Date(2026, 0, 1)),
  ];
  const exact = requireTask(tasks, tasks[0].id);
  assert.equal(exact.title, 'One');
  const prefix = requireTask(tasks, tasks[1].id.slice(0, 16));
  assert.equal(prefix.title, 'Two');
  assert.throws(() => requireTask(tasks, 'ZZZZZZZZZZZZ'), CliError);
  assert.throws(() => requireTask(tasks, tasks[0].id.slice(0, 6)), CliError); // shared timestamp prefix
});

test('findTaskMatches handles exact ids and prefixes', () => {
  const tasks: Task[] = [createTask({ title: 'Solo' }, new Date(2026, 0, 2))];
  assert.deepEqual(findTaskMatches(tasks, tasks[0].id), [tasks[0]]);
  assert.deepEqual(findTaskMatches(tasks, tasks[0].id.slice(0, 20)), [tasks[0]]);
  assert.deepEqual(findTaskMatches(tasks, 'QQQQQQQQQQQQ'), []);
});

test('patchTask applies a function and reports before/after', () => {
  const dir = tmpDir();
  const now = fixedNow();
  const task = createTask({ title: 'Before' }, now);
  withStore(dir, (tasks) => ({ tasks: [...tasks, task], result: undefined }), now);
  const { before, after } = patchTask(dir, task.id, (t) => ({ ...t, title: 'After' }), now);
  assert.equal(before.title, 'Before');
  assert.equal(after.title, 'After');
  assert.equal(listAllTasks(dir, now)[0].title, 'After');
});

test('removeTasks is all-or-nothing', () => {
  const dir = tmpDir();
  const now = fixedNow();
  const a = createTask({ title: 'Keep' }, now);
  const b = createTask({ title: 'Gone' }, now);
  withStore(dir, (tasks) => ({ tasks: [...tasks, a, b], result: undefined }), now);
  assert.throws(() => removeTasks(dir, [a.id, 'ZZZZZZZZZZZZ'], now), CliError);
  assert.equal(listAllTasks(dir, now).length, 2);
  const removed = removeTasks(dir, [b.id], now);
  assert.equal(removed.length, 1);
  const left = listAllTasks(dir, now);
  assert.equal(left.length, 1);
  assert.equal(left[0].title, 'Keep');
});

test('mergeTasks adds, skips or replaces by id', () => {
  const dir = tmpDir();
  const now = fixedNow();
  const existing = createTask({ title: 'Existing' }, now);
  withStore(dir, (tasks) => ({ tasks: [...tasks, existing], result: undefined }), now);

  const incomingSameId = { ...existing, title: 'Incoming' };
  const fresh = createTask({ title: 'Fresh' }, now);

  const keep = mergeTasks(dir, [incomingSameId, fresh], { replaceExisting: false }, now);
  assert.deepEqual(keep, { added: 1, updated: 0, skipped: 1 });
  assert.ok(listAllTasks(dir, now).some((t) => t.title === 'Existing'));

  const overwrite = mergeTasks(dir, [incomingSameId], { replaceExisting: true }, now);
  assert.deepEqual(overwrite, { added: 0, updated: 1, skipped: 0 });
  assert.ok(listAllTasks(dir, now).every((t) => t.title !== 'Existing'));
});

test('storeInfo reports the filesystem picture', () => {
  const dir = tmpDir();
  const now = fixedNow();
  const info0 = storeInfo(dir, now);
  assert.equal(info0.exists, false);
  assert.equal(info0.taskCount, null);

  const store = emptyStore();
  store.tasks = [createTask({ title: 'X' }, now)];
  saveStore(dir, store, now);
  const info = storeInfo(dir, now);
  assert.equal(info.exists, true);
  assert.ok(info.bytes > 0);
  assert.equal(info.taskCount, 1);
  assert.deepEqual(info.backups, [1]);
  assert.deepEqual(info.corruptFiles, []);
});

test('loads sanitize every stored record', () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const hostile = { version: 1, savedAt: '', tasks: [{ title: 'Ok' }, { totally: 'garbage' }, 42, null] };
  fs.writeFileSync(mainFile(dir), JSON.stringify(hostile), 'utf8');
  const { store } = loadStore(dir, fixedNow());
  assert.equal(store.tasks.length, 4);
  for (const task of store.tasks) {
    assert.ok(typeof task.title === 'string' && task.title.length > 0);
    assert.ok(typeof task.id === 'string');
  }
  // All four are normalized through sanitizeTask.
  assert.deepEqual(store.tasks.map((t) => t.title).includes('(untitled task)'), true);
});

test('sanitizeTask is idempotent for well-formed tasks', () => {
  const now = fixedNow();
  const task = createTask({ title: 'Stable', tags: 'a,b', due: 'tomorrow' }, now);
  const again = sanitizeTask(task, now);
  assert.equal(again.id, task.id);
  assert.equal(again.title, task.title);
  assert.equal(again.due, task.due);
  assert.deepEqual(again.tags, task.tags);
});
