/**
 * Emails published on the store (lib/letter-rules.ts says what one is).
 *
 *   nl:letters:s:<sid>   the store's published emails: id -> when published, in
 *                        milliseconds, plus a half for one kept for members
 *                        (listScore), so the studio's one read of the list
 *                        also says which are, without reading any copy
 *   nl:letters:i:<id>    one published email's copy, as JSON, for LETTER_KEEP_DAYS from publishing
 *
 * The copy and its entry are counted in the store's data room before they are
 * written (lib/store-data.ts), until the day the copy goes by itself.
 */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import type { Store } from "@/lib/store";
import { dataBytes } from "@/lib/store-data-rules";
import { takeData } from "@/lib/store-data";
import type { Broadcast } from "@/lib/broadcasts";
import { itemFor } from "@/lib/catalog";
import { LETTER_ID, LETTER_KEEP_DAYS, MAX_LETTER_PRODUCTS, MAX_PUBLISHED_LETTERS, type Letter, letterProducts, parseLetter } from "@/lib/letter-rules";

const DAY = 86_400_000;
const listKey = (sid: string) => `nl:letters:s:${sid}`;
const recordKey = (id: string) => `nl:letters:i:${id}`;
/**
 * An email's place in the list: when it was published, in whole
 * milliseconds, and half a millisecond more when it is kept for members. The
 * half moves nothing that reads the list by time (entries older than
 * LETTER_KEEP_DAYS leave it) and lets the studio tell a kept one apart from
 * the score it already reads.
 */
export function listScore(publishedAt: number, members: boolean): number {
  return Math.floor(publishedAt) + (members ? 0.5 : 0);
}

/** Whether a place in the list is one of an email kept for members. */
export function keptByScore(score: unknown): boolean {
  const value = Number(score);
  return Number.isFinite(value) && value % 1 !== 0;
}

/** A published email's own key, for the walk that closes a store's records (lib/closed-store-data.ts). */
export const letterRecordKey = recordKey;

/** The id an email is published under: from the store and the email, so it is always the same and never the email's own id. */
export function letterIdFor(sid: string, broadcastId: string): string {
  return createHash("sha256").update(`nimbus-letter:${sid}:${broadcastId}`).digest("hex").slice(0, 20);
}

/** What one published copy takes from the data room: itself and its entry in the list. */
export function letterRoomBytes(letter: Letter): number {
  return dataBytes([JSON.stringify(letter), letter.id], 2);
}

export type Published = { ok: true; letter: Letter } | { ok: false; reason: "not_sent" | "products" | "kept" | "full" | "too_many" | "unavailable"; message: string };

/**
 * Publishes one email the store sent: a copy of its subject and words as
 * they were sent, written once, at its own address. Publishing it again
 * writes the copy again and starts its days afresh.
 *
 * `products`: the products whose holders alone may read its words
 * (lib/letter-rules.ts, membersOnly). An array is the choice, and an empty one
 * is for everyone. Left out (undefined or null), the email keeps what it had:
 * publishing again never opens an email kept for members by itself. An empty
 * array over an email already kept for members is refused unless `open` says
 * so on purpose: the studio sends [] for every email it thinks is not
 * published, and that must not open one it could not see. Anything else is
 * refused, never read as "everyone".
 */
export async function publishLetter(store: Store, broadcast: Broadcast, now = Date.now(), products?: unknown, open = false): Promise<Published> {
  if (!isRedisConfigured() || !store.sid) return { ok: false, reason: "unavailable", message: "This can't be saved right now. Try again in a minute." };
  if (!store.listId || broadcast.listId !== store.listId || broadcast.status !== "sent") return { ok: false, reason: "not_sent", message: "Only an email this store has sent can be published." };
  const refuse: Published = { ok: false, reason: "products", message: `Check up to ${MAX_LETTER_PRODUCTS} of this store's products. Reload the page if one was just deleted.` };
  const keep = products === undefined || products === null;
  if (!keep && !Array.isArray(products)) return refuse;
  const ids = keep ? [] : letterProducts(products);
  if (!keep && (ids.length !== (products as unknown[]).length || ids.some((id) => !itemFor(store, id)))) return refuse;
  const id = letterIdFor(store.sid, broadcast.id);
  try {
    // Entries whose copy has gone by itself leave the count first; the copy
    // already there is read only to keep its products.
    const [, count, already, before] = await redisPipeline([
      ["ZREMRANGEBYSCORE", listKey(store.sid), "-inf", String(now - LETTER_KEEP_DAYS * DAY)],
      ["ZCARD", listKey(store.sid)],
      ["ZSCORE", listKey(store.sid), id],
      ...(keep ? [["GET", recordKey(id)]] : []),
    ]);
    let kept: string[] = [];
    if (!keep && ids.length === 0 && !open && keptByScore(already)) {
      return { ok: false, reason: "kept", message: "This email is on your store for members only. Take it off first if everyone should read it." };
    }
    if (keep && typeof before === "string") {
      const named = (JSON.parse(before) as { products?: unknown }).products;
      kept = letterProducts(named);
      // A copy that named products none of which can be read stays shut: it is not published again for everyone.
      if (named !== undefined && kept.length === 0) return refuse;
    }
    const chosen = keep ? kept : ids;
    const letter: Letter = {
      id,
      sid: store.sid,
      subject: broadcast.subject,
      body: broadcast.body,
      sentAt: broadcast.finishedAt ? broadcast.finishedAt * 1000 : broadcast.sendAt * 1000,
      publishedAt: now,
      ...(chosen.length ? { products: chosen } : {}),
    };
    if (already === null && Number(count) >= MAX_PUBLISHED_LETTERS) return { ok: false, reason: "too_many", message: `Your store keeps ${MAX_PUBLISHED_LETTERS} published emails at most. Take one off first.` };
    const room = await takeData(store, [{ until: now + LETTER_KEEP_DAYS * DAY, bytes: letterRoomBytes(letter) }], now);
    if (!room.ok) return room.reason === "full" ? { ok: false, reason: "full", message: room.message } : { ok: false, reason: "unavailable", message: "This can't be saved right now. Try again in a minute." };
    await redisPipeline([
      ["SET", recordKey(letter.id), JSON.stringify(letter), "EX", LETTER_KEEP_DAYS * 86_400],
      ["ZADD", listKey(store.sid), String(listScore(now, chosen.length > 0)), letter.id],
      ["EXPIRE", listKey(store.sid), LETTER_KEEP_DAYS * 86_400],
    ]);
    return { ok: true, letter };
  } catch (error) {
    console.error("publishing an email failed", error);
    return { ok: false, reason: "unavailable", message: "This can't be saved right now. Try again in a minute." };
  }
}

/** Takes a published email off the store: its copy is deleted. */
export async function unpublishLetter(store: Pick<Store, "sid">, id: string): Promise<boolean> {
  if (!LETTER_ID.test(id) || !isRedisConfigured() || !store.sid) return false;
  const [, removed] = await redisPipeline([["DEL", recordKey(id)], ["ZREM", listKey(store.sid), id]]);
  return Number(removed) === 1;
}

/** One of this store's published emails, or null. */
export async function readLetter(store: Pick<Store, "sid">, id: string): Promise<Letter | null> {
  if (!LETTER_ID.test(id) || !isRedisConfigured() || !store.sid) return null;
  const [raw] = await redisPipeline([["GET", recordKey(id)]]);
  if (typeof raw !== "string") return null;
  try {
    const letter = parseLetter(JSON.parse(raw));
    return letter && letter.sid === store.sid ? letter : null;
  } catch {
    return null;
  }
}

/** The store's published emails, newest first; [] when there are none or they cannot be read. */
export async function listLetters(store: Pick<Store, "sid">): Promise<Letter[]> {
  if (!isRedisConfigured() || !store.sid) return [];
  try {
    const [ids] = await redisPipeline([["ZREVRANGE", listKey(store.sid), 0, MAX_PUBLISHED_LETTERS - 1]]);
    const list = Array.isArray(ids) ? ids.map(String).filter((id) => LETTER_ID.test(id)) : [];
    if (!list.length) return [];
    const [raws] = await redisPipeline([["MGET", ...list.map(recordKey)]]);
    const values = Array.isArray(raws) ? raws : [];
    const out: Letter[] = [];
    list.forEach((_, i) => {
      try {
        const letter = typeof values[i] === "string" ? parseLetter(JSON.parse(values[i] as string)) : null;
        if (letter && letter.sid === store.sid) out.push(letter);
      } catch {
        // A copy that cannot be read is not shown.
      }
    });
    return out;
  } catch (error) {
    console.error("reading published emails failed", error);
    return [];
  }
}

/**
 * The store's published emails, for the studio to say which are and which are
 * kept for members (listScore), in one read. Null when they cannot be read:
 * the studio then says it does not know, never that an email is not published.
 */
export async function publishedLetters(store: Pick<Store, "sid">): Promise<Map<string, { members: boolean }> | null> {
  if (!isRedisConfigured() || !store.sid) return new Map();
  try {
    const [flat] = await redisPipeline([["ZREVRANGE", listKey(store.sid), 0, MAX_PUBLISHED_LETTERS - 1, "WITHSCORES"]]);
    if (!Array.isArray(flat)) return null;
    const out = new Map<string, { members: boolean }>();
    for (let i = 0; i + 1 < flat.length; i += 2) out.set(String(flat[i]), { members: keptByScore(flat[i + 1]) });
    return out;
  } catch (error) {
    console.error("reading which emails are published failed", error);
    return null;
  }
}
