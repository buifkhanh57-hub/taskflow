/**
 * ts-utils-kit — a small, dependency-free TypeScript utility library.
 * Compile with `tsc` or import directly in a bundler-based project.
 */

// ---------------------------------------------------------------- strings ---

export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function toCamelCase(input: string): string {
  return input
    .replace(/[-_\s]+(.)?/g, (_, ch: string | undefined) =>
      ch ? ch.toUpperCase() : ""
    )
    .replace(/^(.)/, (m) => m.toLowerCase());
}

export function truncate(text: string, max: number, suffix = "…"): string {
  if (max < suffix.length) throw new RangeError("max is too small");
  return text.length <= max ? text : text.slice(0, max - suffix.length) + suffix;
}

export function pad(value: number, width: number, char = "0"): string {
  return String(value).padStart(width, char);
}

// ----------------------------------------------------------------- arrays ---

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new RangeError("size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function unique<T>(items: readonly T[]): T[] {
  return Array.from(new Set(items));
}

export function groupBy<T, K extends string | number>(
  items: readonly T[],
  keyFn: (item: T, index: number) => K
): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  items.forEach((item, i) => {
    const key = keyFn(item, i);
    (out[key] ??= []).push(item);
  });
  return out;
}

export function shuffle<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function range(start: number, end: number, step = 1): number[] {
  const out: number[] = [];
  if (step === 0) throw new RangeError("step must not be zero");
  for (let v = start; step > 0 ? v < end : v > end; v += step) out.push(v);
  return out;
}

export function zip<A, B>(as: readonly A[], bs: readonly B[]): [A, B][] {
  const len = Math.min(as.length, bs.length);
  const out: [A, B][] = [];
  for (let i = 0; i < len; i++) out.push([as[i], bs[i]]);
  return out;
}

// ------------------------------------------------------------------- dates ---

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => pad(n, 2)).join(":");
}

// ------------------------------------------------------------------- async --

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

export async function retry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  backoffMs = 200
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, backoffMs * 2 ** i));
      }
    }
  }
  throw lastError;
}

// ------------------------------------------------------------------- tests --

console.assert(slugify("Hà Nội — Mùa Thu 2024!") === "ha-noi-mua-thu-2024", "slugify");
console.assert(toCamelCase("hello_world-test") === "helloWorldTest", "toCamelCase");
console.assert(truncate("hello world", 8) === "hello w…", "truncate");
console.assert(JSON.stringify(chunk([1, 2, 3, 4, 5], 2)) === "[[1,2],[3,4],[5]]", "chunk");
console.assert(unique([1, 1, 2, 3, 3]).length === 3, "unique");
console.assert(isLeapYear(2024) && !isLeapYear(1900) && isLeapYear(2000), "isLeapYear");
console.assert(formatDuration(3723) === "01:02:03", "formatDuration");

console.log("ts-utils-kit self-check complete");
