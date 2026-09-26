/**
 * JSON persistence layer for taskflow.
 *
 * Responsibilities:
 *
 * - resolve the data directory (`--data` flag → `TASKFLOW_DATA` env →
 *   `$HOME/.taskflow`)
 * - load `tasks.json`, tolerating corruption by falling back to rotating
 *   `.bak.1..3` backups and finally quarantining the unreadable file
 * - save atomically: write a temp file in the same directory, then `rename`
 *   over the target (POSIX atomicity), after rotating the previous store
 *   into the backup chain
 * - CRUD helpers used by every command
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { StoreFile, Task } from './types.ts';
import { CliError, STORE_VERSION } from './types.ts';
import { formatISODateTime } from './dateparse.ts';
import { matchesPrefix, sanitizeTask } from './task.ts';

/** Environment variable overriding the default data directory. */
export const DATA_ENV = 'TASKFLOW_DATA';

/** Default directory name inside `$HOME`. */
const DEFAULT_DIRNAME = '.taskflow';

/** Number of rotating backups kept (`tasks.json.bak.1` .. `.bak.3`). */
export const BACKUP_COUNT = 3;

/** Name of the main store file inside the data directory. */
export const STORE_FILENAME = 'tasks.json';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Resolve the effective data directory.
 * Precedence: explicit flag → `TASKFLOW_DATA` env → `$HOME/.taskflow`.
 */
export function resolveDataDir(explicit?: string): string {
  const fromFlag = typeof explicit === 'string' ? explicit.trim() : '';
  const fromEnv = process.env[DATA_ENV];
  const fromEnvTrimmed = typeof fromEnv === 'string' ? fromEnv.trim() : '';
  const base = fromFlag || fromEnvTrimmed || join(os.homedir(), DEFAULT_DIRNAME);
  return join(base, '.').length > 0 ? base : DEFAULT_DIRNAME;
}

/** Create the data directory (and parents) when missing. */
export function ensureDataDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Absolute path of the main store file. */
export function mainFile(dir: string): string {
  return join(dir, STORE_FILENAME);
}

/** Absolute path of rotating backup `n` (1-based). */
export function backupFile(dir: string, n: number): string {
  return join(dir, `${STORE_FILENAME}.bak.${n}`);
}

/** Absolute path of a temp file used for atomic writes. */
function tmpFile(dir: string): string {
  return join(dir, `.${STORE_FILENAME}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export interface LoadResult {
  /** The loaded (or freshly created) store. */
  store: StoreFile;
  /** True when recovery machinery had to run. */
  recovered: boolean;
  /** Human-readable warning describing any recovery action, or null. */
  warning: string | null;
}

/** Build an empty store. */
export function emptyStore(): StoreFile {
  return { version: STORE_VERSION, tasks: [], savedAt: '' };
}

/** Read and validate a store file; null when missing/unreadable/corrupt. */
function readStoreFile(path: string, now: Date): StoreFile | null {
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const obj = raw as Record<string, unknown>;
    const tasksRaw = Array.isArray(obj.tasks) ? obj.tasks : [];
    const tasks: Task[] = tasksRaw.map((t) => sanitizeTask(t, now));
    const savedAt = typeof obj.savedAt === 'string' ? obj.savedAt : '';
    const version = typeof obj.version === 'number' ? obj.version : STORE_VERSION;
    return { version, tasks, savedAt };
  } catch {
    return null;
  }
}

/**
 * Load the store, with corruption recovery.
 *
 * Recovery order when `tasks.json` is unreadable or malformed:
 * 1. `tasks.json.bak.1`, `.bak.2`, `.bak.3` — the newest valid backup is
 *    copied back over the main file.
 * 2. Otherwise the broken file is quarantined as
 *    `tasks.json.corrupt-<millis>` and an empty store is started.
 *
 * A missing main file (first run) is not an error: an empty store is returned
 * with `recovered: false`.
 */
export function loadStore(dir: string, now: Date = new Date()): LoadResult {
  const main = mainFile(dir);
  const parsed = readStoreFile(main, now);
  if (parsed !== null) {
    return { store: parsed, recovered: false, warning: null };
  }
  if (!fs.existsSync(main)) {
    return { store: emptyStore(), recovered: false, warning: null };
  }

  for (let n = 1; n <= BACKUP_COUNT; n += 1) {
    const bak = backupFile(dir, n);
    if (!fs.existsSync(bak)) continue;
    const fromBackup = readStoreFile(bak, now);
    if (fromBackup !== null) {
      try {
        fs.copyFileSync(bak, main);
      } catch {
        // Copy failure is non-fatal; the caller still gets valid data.
      }
      return {
        store: fromBackup,
        recovered: true,
        warning: `main store was corrupt — recovered ${fromBackup.tasks.length} task(s) from ${STORE_FILENAME}.bak.${n}`,
      };
    }
  }

  const quarantined = `${main}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(main, quarantined);
  } catch (err) {
    throw new CliError('STORE_UNWRITABLE', `cannot quarantine corrupt store: ${(err as Error).message}`);
  }
  return {
    store: emptyStore(),
    recovered: true,
    warning: `store was unreadable and has been moved to ${quarantined} — starting fresh`,
  };
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/** Shift backups: bak2→bak3, bak1→bak2, main→bak1. On the very first save
 * the pre-save state was an empty store, and that is what bak.1 records. */
function rotateBackups(dir: string): void {
  const main = mainFile(dir);
  for (let n = BACKUP_COUNT; n >= 2; n -= 1) {
    const older = backupFile(dir, n);
    const newer = backupFile(dir, n - 1);
    if (fs.existsSync(newer)) {
      fs.rmSync(older, { force: true });
      fs.renameSync(newer, older);
    }
  }
  fs.rmSync(backupFile(dir, 1), { force: true });
  if (fs.existsSync(main)) {
    fs.renameSync(main, backupFile(dir, 1));
  } else {
    fs.writeFileSync(backupFile(dir, 1), JSON.stringify(emptyStore()), 'utf8');
  }
}

/**
 * Persist the store atomically:
 * 1. rotate the previous main file into the backup chain,
 * 2. write JSON to a temp file in the same directory,
 * 3. `rename` the temp file over the main path.
 *
 * The store's `savedAt` field is stamped with `now` before writing.
 */
export function saveStore(dir: string, store: StoreFile, now: Date = new Date()): void {
  ensureDataDir(dir);
  rotateBackups(dir);
  const payload: StoreFile = { ...store, version: STORE_VERSION, savedAt: formatISODateTime(now) };
  const tmp = tmpFile(dir);
  const main = mainFile(dir);
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, main);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort cleanup
    }
    throw new CliError('STORE_UNWRITABLE', `cannot save store to ${main}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

/**
 * Load, mutate and save in one shot.
 * `fn` receives the task array and must return the (possibly new) array plus
 * a result value for the caller.
 */
export function withStore<T>(dir: string, fn: (tasks: Task[]) => { tasks: Task[]; result: T }, now: Date = new Date()): T {
  const { store } = loadStore(dir, now);
  const out = fn(store.tasks);
  store.tasks = out.tasks;
  saveStore(dir, store, now);
  return out.result;
}

/** Read-only snapshot of every task. */
export function listAllTasks(dir: string, now: Date = new Date()): Task[] {
  return loadStore(dir, now).store.tasks;
}

/** Collect tasks matching an id or unique id prefix. */
export function findTaskMatches(tasks: Task[], idOrPrefix: string): Task[] {
  const exact = tasks.filter((t) => t.id === idOrPrefix);
  if (exact.length > 0) return exact;
  return tasks.filter((t) => matchesPrefix(t, idOrPrefix));
}

/**
 * Require exactly one task for an id/prefix.
 *
 * @throws {CliError} `TASK_NOT_FOUND` (exit 1) or `AMBIGUOUS_ID` (exit 1).
 */
export function requireTask(tasks: Task[], idOrPrefix: string): Task {
  const matches = findTaskMatches(tasks, idOrPrefix);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new CliError('TASK_NOT_FOUND', `no task matches "${idOrPrefix}" — run \`taskflow list\` to see ids`);
  }
  const ids = matches.map((t) => t.id.slice(0, 12)).join(', ');
  throw new CliError('AMBIGUOUS_ID', `"${idOrPrefix}" matches ${matches.length} tasks (${ids}) — use more characters`);
}

/** Insert freshly created tasks and persist. */
export function insertTasks(dir: string, newTasks: Task[], now: Date = new Date()): void {
  if (newTasks.length === 0) return;
  withStore(
    dir,
    (tasks) => ({ tasks: [...tasks, ...newTasks], result: undefined }),
    now,
  );
}

/**
 * Patch a single task through `patchFn` and persist.
 * Returns the task before and after the edit.
 */
export function patchTask(
  dir: string,
  idOrPrefix: string,
  patchFn: (task: Task) => Task,
  now: Date = new Date(),
): { before: Task; after: Task } {
  return withStore(
    dir,
    (tasks) => {
      const target = requireTask(tasks, idOrPrefix);
      const after = patchFn(target);
      const next = tasks.map((t) => (t.id === target.id ? after : t));
      return { tasks: next, result: { before: target, after } };
    },
    now,
  );
}

/**
 * Resolve every selector first (all-or-nothing), then remove the matched
 * tasks and persist.
 *
 * @throws {CliError} when any selector matches nothing or is ambiguous —
 * in that case nothing is removed.
 */
export function removeTasks(dir: string, idOrPrefixes: readonly string[], now: Date = new Date()): Task[] {
  return withStore(
    dir,
    (tasks) => {
      const targets: Task[] = [];
      for (const selector of idOrPrefixes) {
        targets.push(requireTask(tasks, selector));
      }
      const ids = new Set(targets.map((t) => t.id));
      return { tasks: tasks.filter((t) => !ids.has(t.id)), result: targets };
    },
    now,
  );
}

/** Replace the entire task list (used by `import --replace`). */
export function replaceTasks(dir: string, tasks: Task[], now: Date = new Date()): void {
  withStore(dir, (existing) => ({ tasks, result: { previous: existing.length } }), now);
}

export interface MergeReport {
  added: number;
  updated: number;
  skipped: number;
}

/**
 * Merge imported tasks into the store by id.
 * With `replaceExisting` the incoming record wins; otherwise existing tasks
 * are kept and the incoming one is skipped.
 */
export function mergeTasks(dir: string, incoming: Task[], opts: { replaceExisting: boolean }, now: Date = new Date()): MergeReport {
  return withStore(
    dir,
    (tasks) => {
      const byId = new Map<string, Task>();
      for (const t of tasks) byId.set(t.id, t);
      let added = 0;
      let updated = 0;
      let skipped = 0;
      for (const t of incoming) {
        if (byId.has(t.id)) {
          if (opts.replaceExisting) {
            byId.set(t.id, t);
            updated += 1;
          } else {
            skipped += 1;
          }
        } else {
          byId.set(t.id, t);
          added += 1;
        }
      }
      return { tasks: [...byId.values()], result: { added, updated, skipped } };
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

export interface StoreInfo {
  dir: string;
  path: string;
  exists: boolean;
  bytes: number;
  backups: number[];
  corruptFiles: string[];
  taskCount: number | null;
}

/** Filesystem-level overview of the data directory (used by `stats --json`). */
export function storeInfo(dir: string, now: Date = new Date()): StoreInfo {
  const main = mainFile(dir);
  const info: StoreInfo = {
    dir,
    path: main,
    exists: fs.existsSync(main),
    bytes: 0,
    backups: [],
    corruptFiles: [],
    taskCount: null,
  };
  if (info.exists) {
    try {
      info.bytes = fs.statSync(main).size;
    } catch {
      info.bytes = 0;
    }
  }
  for (let n = 1; n <= BACKUP_COUNT; n += 1) {
    if (fs.existsSync(backupFile(dir, n))) info.backups.push(n);
  }
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(`${STORE_FILENAME}.corrupt-`)) info.corruptFiles.push(entry);
    }
  } catch {
    // directory may not exist yet
  }
  if (info.exists) {
    const loaded = readStoreFile(main, now);
    info.taskCount = loaded === null ? null : loaded.tasks.length;
  }
  return info;
}
