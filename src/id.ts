/**
 * ULID-style identifier generation for taskflow.
 *
 * Ids are 26-character, upper-case Crockford-base32 strings:
 *
 *   TTTTTTTTTTRRRRRRRRRRRRRRRR
 *   \________/\_____________/
 *     10 chars    16 chars
 *     48-bit      80 bits of
 *     timestamp   crypto randomness
 *
 * The layout gives lexicographic ordering by creation time (ids generated in
 * the same millisecond sort by their random tail, and a monotonic counter
 * guarantees strictly increasing ids within one process).
 *
 * Only `node:crypto` is used — no external dependencies.
 *
 * @packageDocumentation
 */

import { randomBytes } from 'node:crypto';

/** Crockford base32 alphabet (no I, L, O or U to avoid transcription errors). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Character length of the encoded timestamp part. */
const TIME_LEN = 10;

/** Character length of the random part. */
const RANDOM_LEN = 16;

/**
 * Characters shown for the short, human-facing form of an id.
 *
 * The first 10 characters are the timestamp, so eight characters would only
 * cover the top 40 timestamp bits — every task created within the same
 * ~4-minute window would collide. Twelve characters always include ≥ 12 bits
 * of the random tail (1-in-4096 same-millisecond collision odds per pair).
 */
export const SHORT_ID_LEN = 12;

/** Total id length (10 + 16). */
export const ID_LEN = TIME_LEN + RANDOM_LEN;

/** Largest value the 48-bit timestamp part can hold. */
const TIME_LIMIT = 0x1_0000_0000_0000; // 2^48

/** Monotonic state: last millisecond handed out. */
let lastTime = 0;

/** Encode an unsigned integer as `len` Crockford-base32 characters (big-endian). */
function encodeBits(value: bigint | number, len: number): string {
  let n = BigInt(value);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out = ALPHABET[Number(n % 32n)] + out;
    n >>= 5n;
  }
  return out;
}

/** Draw 80 unbiased random bits and encode them as 16 base32 characters. */
function encodeRandom(): string {
  // 10 bytes = 80 bits = exactly 16 base32 characters, so plain BigInt
  // conversion is uniformly distributed (no modulo bias).
  const n = BigInt('0x' + randomBytes(10).toString('hex'));
  return encodeBits(n, RANDOM_LEN);
}

/**
 * Generate a fresh monotonic ULID-style id.
 *
 * Within a single process, ids strictly increase. When several ids are
 * requested inside the same millisecond (a bulk import, a tight loop), the
 * timestamp component is advanced by 1 ms per extra id instead of mutating
 * only the random tail — this keeps the *timestamp prefix itself unique*, so
 * short display prefixes ({@link SHORT_ID_LEN} chars) never collide within a
 * burst. The embedded time may then run a few milliseconds ahead of the real
 * creation clock, which is harmless for ordering and diagnostics.
 *
 * @param now Millisecond timestamp to encode (defaults to the current time).
 * @returns A 26-character identifier such as `01JT5Z9M3K7ABCD23456789ABC`.
 */
export function newId(now: number = Date.now()): string {
  let time = Math.floor(now);
  if (!Number.isFinite(time) || time < 0) time = 0;
  if (time >= TIME_LIMIT) time = TIME_LIMIT - 1;
  if (time <= lastTime) time = lastTime + 1;
  if (time >= TIME_LIMIT) time = TIME_LIMIT - 1;
  lastTime = time;
  return encodeBits(time, TIME_LEN) + encodeRandom();
}

/** Type guard: does the value look like a well-formed taskflow id? */
export function isValidId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length !== ID_LEN) return false;
  for (const ch of id) {
    if (!ALPHABET.includes(ch)) return false;
  }
  return true;
}

/**
 * Decode the timestamp embedded in an id.
 *
 * @returns The creation millisecond, or null when the id is malformed.
 */
export function idTimestamp(id: string): number | null {
  if (typeof id !== 'string' || id.length < TIME_LEN) return null;
  let n = 0n;
  for (let i = 0; i < TIME_LEN; i += 1) {
    const idx = ALPHABET.indexOf(id[i]);
    if (idx < 0) return null;
    n = (n << 5n) | BigInt(idx);
  }
  return Number(n);
}

/**
 * Decode the timestamp as a `Date`, or null when the id is malformed.
 */
export function idDate(id: string): Date | null {
  const ms = idTimestamp(id);
  return ms === null ? null : new Date(ms);
}

/**
 * Short human-facing prefix of an id used in tables and messages.
 * Defaults to {@link SHORT_ID_LEN} characters: the 10-character timestamp
 * plus 2 random characters, which keeps same-millisecond collisions at the
 * 1-in-4096 level while staying easy to type.
 */
export function shortId(id: string, len: number = SHORT_ID_LEN): string {
  return id.slice(0, Math.max(1, Math.min(len, id.length)));
}

/**
 * Validate that `prefix` is a usable task selector for prefix matching:
 * at least 3 characters, all drawn from the Crockford alphabet.
 */
export function isValidIdPrefix(prefix: string): boolean {
  if (typeof prefix !== 'string' || prefix.length < 3 || prefix.length > ID_LEN) return false;
  for (const ch of prefix) {
    if (!ALPHABET.includes(ch)) return false;
  }
  return true;
}
