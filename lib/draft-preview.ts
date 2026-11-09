/**
 * A private preview link for a draft product (754 [STN1], unit 4a): whoever
 * can edit the store's products makes one for a product that is not on the
 * store yet, to show it to someone before publishing it.
 *
 *   nl:dpv:<sha256(code)>            the link: whose draft it opens and when it ends
 *   nl:dpv:p:<statsId>:<productId>   the one link a draft has now: its code's hash
 *   nl:dpv:down:<statsId>:<productId> a product taken down after a notice (lib/takedown.ts): no link
 *                                    opens or is made for it until it is published again
 *
 * Both expire with the link (PREVIEW_SECONDS). The code is shown once, when the
 * link is made, and never stored: only its SHA-256 is. 128 random bits need no
 * slow hash. A link opens only while its own record is there, has not ended,
 * and is still the one its draft points to, so a link replaced by a newer one
 * (even made at the same moment) or revoked never opens again. A read that
 * fails, or a reply that is not exactly what Redis answers, throws: the caller
 * answers that it could not check, never with the draft (rules 24 and 30).
 */
import { createHash, randomBytes } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";

/** How long a link opens: seven days. */
export const PREVIEW_SECONDS = 7 * 86_400;

/** A code as made here: 16 random bytes, base64url, 22 characters. */
export const PREVIEW_CODE = /^[A-Za-z0-9_-]{22}$/;

const HASH = /^[0-9a-f]{64}$/;
const hashOf = (code: string) => createHash("sha256").update(code).digest("hex");
const lookupKey = (hash: string) => `nl:dpv:${hash}`;
const pointerKey = (statsId: string, productId: string) => `nl:dpv:p:${statsId}:${productId}`;
const downKey = (statsId: string, productId: string) => `nl:dpv:down:${statsId}:${productId}`;

/** How long a taken-down mark is kept when the product is never published again: then it expires with nothing left to show. */
export const TAKEN_DOWN_SECONDS = 400 * 86_400;

/** The pipeline's replies, one per command, or a throw: a reply that is missing is never "no link". */
async function exactly(commands: (string | number)[][]): Promise<unknown[]> {
  const replies = repliesFor(await redisPipeline(commands), commands.length);
  if (!replies) throw new Error("A preview link reply could not be read");
  return replies;
}
const stringOrNull = (value: unknown, what: string): string | null => {
  if (value === null || typeof value === "string") return value;
  throw new Error(`A preview link ${what} could not be read`);
};

/** What an open link leads to. */
export type DraftPreview = { statsId: string; productId: string; expiresAt: number };

type Owner = { statsId?: string | null };

function statsOf(store: Owner): string {
  if (!store.statsId) throw new Error("This store has no stats id for a preview link");
  return store.statsId;
}

/** Makes the draft's link, in place of the one before; the code is returned once and never kept. */
export async function makeDraftPreview(store: Owner, productId: string, now = Math.floor(Date.now() / 1000)): Promise<{ code: string; expiresAt: number }> {
  const statsId = statsOf(store);
  const code = randomBytes(16).toString("base64url");
  const hash = hashOf(code);
  const expiresAt = now + PREVIEW_SECONDS;
  const before = stringOrNull((await exactly([["GET", pointerKey(statsId, productId)]]))[0], "pointer");
  const record = JSON.stringify({ s: statsId, p: productId, e: expiresAt });
  const commands: (string | number)[][] = [
    ["SET", lookupKey(hash), record, "EX", PREVIEW_SECONDS],
    ["SET", pointerKey(statsId, productId), hash, "EX", PREVIEW_SECONDS],
  ];
  // The one it replaces stops opening by the pointer at once; its record goes too.
  if (before !== null && HASH.test(before) && before !== hash) commands.push(["DEL", lookupKey(before)]);
  const replies = await exactly(commands);
  if (replies[0] !== "OK" || replies[1] !== "OK") throw new Error("A preview link could not be written");
  return { code, expiresAt };
}

/** Ends the draft's link at once. */
export async function revokeDraftPreview(store: Owner, productId: string): Promise<void> {
  const statsId = statsOf(store);
  const hash = stringOrNull((await exactly([["GET", pointerKey(statsId, productId)]]))[0], "pointer");
  // The pointer goes first: from then on no record opens, whatever is left of it.
  const commands: (string | number)[][] = [["DEL", pointerKey(statsId, productId)]];
  if (hash !== null && HASH.test(hash)) commands.push(["DEL", lookupKey(hash)]);
  await exactly(commands);
}

/**
 * A product taken down after a notice (lib/takedown.ts): its link ends at once and, until it is
 * published again (clearTakenDown, from the product route), no link opens or is made for it, so a
 * preview never shows what a notice took down (Claude 6 on #3439, MEDIUM 1).
 */
export async function markTakenDown(store: Owner, productId: string): Promise<void> {
  const statsId = statsOf(store);
  const replies = await exactly([["SET", downKey(statsId, productId), "1", "EX", TAKEN_DOWN_SECONDS]]);
  if (replies[0] !== "OK") throw new Error("A taken-down mark could not be written");
  await revokeDraftPreview(store, productId);
}

/** Whether the product was taken down and not published since; a reply that cannot be read throws. */
export async function isTakenDown(store: Owner, productId: string): Promise<boolean> {
  const mark = stringOrNull((await exactly([["GET", downKey(statsOf(store), productId)]]))[0], "taken-down mark");
  return mark !== null;
}

/** The product is published again: previews may be made for it once it is a draft again. */
export async function clearTakenDown(store: Owner, productId: string): Promise<void> {
  await exactly([["DEL", downKey(statsOf(store), productId)]]);
}

/**
 * What a code opens, or null: a code of another shape (never read), no record,
 * a record that is not exactly one of ours, one that has ended, or one its
 * draft no longer points to. A read that fails throws.
 */
export async function readDraftPreview(code: string, now = Math.floor(Date.now() / 1000)): Promise<DraftPreview | null> {
  if (typeof code !== "string" || !PREVIEW_CODE.test(code)) return null;
  const hash = hashOf(code);
  const raw = stringOrNull((await exactly([["GET", lookupKey(hash)]]))[0], "record");
  if (raw === null) return null;
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const { s, p, e } = record as Record<string, unknown>;
  if (typeof s !== "string" || !s || typeof p !== "string" || !p || typeof e !== "number" || !Number.isInteger(e)) return null;
  if (e <= now) return null;
  const [current, down] = await exactly([["GET", pointerKey(s, p)], ["GET", downKey(s, p)]]);
  if (stringOrNull(current, "pointer") !== hash) return null;
  // Taken down after a notice: whatever link was made before or since, it does not open.
  if (stringOrNull(down, "taken-down mark") !== null) return null;
  return { statsId: s, productId: p, expiresAt: e };
}
