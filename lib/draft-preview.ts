/**
 * A private preview link for a draft product (754 [STN1], unit 4a): whoever
 * can edit the store's products makes one for a product that is not on the
 * store yet, to show it to someone before publishing it.
 *
 *   nl:dpv:<sha256(code)>            the link: whose draft it opens and when it ends
 *   nl:dpv:p:<statsId>:<productId>   the one link a draft has now: its code's hash
 *
 * Both expire with the link (PREVIEW_SECONDS). The code is shown once, when the
 * link is made, and never stored: only its SHA-256 is. 128 random bits need no
 * slow hash. A link opens only while its own record is there, has not ended,
 * and is still the one its draft points to, so a link replaced by a newer one
 * (even made at the same moment) or revoked never opens again. A read that
 * fails throws: the caller answers that it could not check, never with the draft.
 */
import { createHash, randomBytes } from "node:crypto";
import { redisPipeline } from "@/lib/redis";

/** How long a link opens: seven days. */
export const PREVIEW_SECONDS = 7 * 86_400;

/** A code as made here: 16 random bytes, base64url, 22 characters. */
export const PREVIEW_CODE = /^[A-Za-z0-9_-]{22}$/;

const HASH = /^[0-9a-f]{64}$/;
const hashOf = (code: string) => createHash("sha256").update(code).digest("hex");
const lookupKey = (hash: string) => `nl:dpv:${hash}`;
const pointerKey = (statsId: string, productId: string) => `nl:dpv:p:${statsId}:${productId}`;

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
  const [before] = await redisPipeline([["GET", pointerKey(statsId, productId)]]);
  const record = JSON.stringify({ s: statsId, p: productId, e: expiresAt });
  const commands: (string | number)[][] = [
    ["SET", lookupKey(hash), record, "EX", PREVIEW_SECONDS],
    ["SET", pointerKey(statsId, productId), hash, "EX", PREVIEW_SECONDS],
  ];
  // The one it replaces stops opening by the pointer at once; its record goes too.
  if (typeof before === "string" && HASH.test(before) && before !== hash) commands.push(["DEL", lookupKey(before)]);
  await redisPipeline(commands);
  return { code, expiresAt };
}

/** Ends the draft's link at once. */
export async function revokeDraftPreview(store: Owner, productId: string): Promise<void> {
  const statsId = statsOf(store);
  const [hash] = await redisPipeline([["GET", pointerKey(statsId, productId)]]);
  // The pointer goes first: from then on no record opens, whatever is left of it.
  const commands: (string | number)[][] = [["DEL", pointerKey(statsId, productId)]];
  if (typeof hash === "string" && HASH.test(hash)) commands.push(["DEL", lookupKey(hash)]);
  await redisPipeline(commands);
}

/**
 * What a code opens, or null: a code of another shape (never read), no record,
 * a record that is not exactly one of ours, one that has ended, or one its
 * draft no longer points to. A read that fails throws.
 */
export async function readDraftPreview(code: string, now = Math.floor(Date.now() / 1000)): Promise<DraftPreview | null> {
  if (typeof code !== "string" || !PREVIEW_CODE.test(code)) return null;
  const hash = hashOf(code);
  const [raw] = await redisPipeline([["GET", lookupKey(hash)]]);
  if (typeof raw !== "string") return null;
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
  const [current] = await redisPipeline([["GET", pointerKey(s, p)]]);
  if (current !== hash) return null;
  return { statsId: s, productId: p, expiresAt: e };
}
