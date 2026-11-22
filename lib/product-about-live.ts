/**
 * A product's long description written by the application (the product editor, an import, a store copy, the demo,
 * the agent), fenced by the store's erasure (Codex L, L-20261120-1755). Server only: it reads lib/store.ts, whose
 * modules (node:crypto, node:perf_hooks) must never reach a browser bundle, and lib/product-about.ts is read by the
 * studio's product editor in the browser (#4969, Claude 5 ibqho's H1; tests/product-about-client-bundle.test.ts).
 */
import { redisPipeline } from "@/lib/redis";
import { aboutKey } from "@/lib/product-about";
import { ERASING_KEY, STORE_ID_PATTERN, type Store, ensureStoreId, erasingField, storeIdCommand, storeRef } from "@/lib/store";
import { giveData, needData, noteData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

/**
 * A store's own description write, fenced by its erasure (Codex L, L-20261120-1755): the same write as writeAbout or
 * writeAboutIf, in one step with the check that the store is still live. A description write can land after the
 * setter that asked for it returned and let go of the store's lock, or after an import or a copy read the store; a
 * plain SET then would put a deleted store's private text back after the closing walk passed its key. The fence is
 * lib/store-live-cache.ts's: the erasing mark (lib/store.ts ERASING_KEY) must be absent and the store's id key must
 * still hold its ref (closeStoreRecord deletes the id key and the record in the same fenced step as the mark). A store from before
 * ids is given its id first, once and for good (storeNamedForAbout), so the fence never has to read a whole record.
 *
 * The store is live only while its id key still holds this store's own ref, never only while it exists (v2; Claude 5
 * ibqho on #4969, the rule of lib/live-fence.ts store-cache-live:v3): moveAccount repoints the id key to the new
 * owner's ref, and an erasure begun after a move marks the new ref's field, so a write read under the old ref would
 * pass an EXISTS and an HGET of the old field while the new owner's erasure is under way.
 *
 * KEYS: the store's id key, ERASING_KEY, the description. ARGV: the store's erasing field, "1" to write only over
 * `expected`, `expected`, the text ("" deletes), the store's ref. Answers {1} written; {0, length now} when `expected`
 * no longer holds (nothing written); {-1} the store is gone, moved or erasing (nothing written). Inner commands: HGET
 * and the id key's GET, the GET of a compare, then SET or DEL: at most ABOUT_FENCE_EXTRA_COMMANDS more than the
 * unfenced write billed.
 */
export const ABOUT_WRITE_IF_STORE_LIVE = `-- marktmorgen:about-write-live:v2
if redis.call('HGET', KEYS[2], ARGV[1]) then return {-1} end
if redis.call('GET', KEYS[1]) ~= ARGV[5] then return {-1} end
if ARGV[2] == '1' then
  local now = redis.call('GET', KEYS[3]) or ''
  if now ~= ARGV[3] then return {0, string.len(now)} end
end
if ARGV[4] == '' then redis.call('DEL', KEYS[3]) else redis.call('SET', KEYS[3], ARGV[4]) end
return {1}`;

/**
 * What the fence adds to one description write, as Upstash bills a script (the EVAL and its inner commands): a plain
 * SET was 1, fenced it is 4 (EVAL, HGET, GET, SET); a compared write was 3 (EVAL, GET, SET), fenced 5. Priced on
 * every request that may write one (tests/plan-cost-registry.ts, aboutFenceUsd).
 */
export const ABOUT_FENCE_EXTRA_COMMANDS = 3;

/** A store's description write refused because the store is gone or its erasure has begun: nothing was written. */
export class AboutStoreGoneError extends Error {
  constructor() {
    super("the store is gone or being erased, so its product description was not written");
    this.name = "AboutStoreGoneError";
  }
}

/**
 * The store as its description writes need it: with its id. A store from before ids gets one now (ensureStoreId, once
 * for good, as the owner's studio does), and only while its record is still this store's: a different statsId under
 * the same owner is a new store, and the old one's write is refused (AboutStoreGoneError), never put under the new one.
 */
export async function storeNamedForAbout(store: Store): Promise<Store> {
  if (STORE_ID_PATTERN.test(store.sid)) return store;
  const named = await ensureStoreId(storeRef(store));
  if (!named || !STORE_ID_PATTERN.test(named.sid) || !store.statsId || named.statsId !== store.statsId) throw new AboutStoreGoneError();
  return named;
}

/** One fenced description write: true written, "changed" when `expected` no longer held; throws for anything else. */
async function writeWhileStoreLive(store: Store, productId: string, text: string, expected: string | null): Promise<true | "changed"> {
  const statsId = store.statsId;
  if (!statsId) throw new Error("a product description needs the store's statsId");
  const named = await storeNamedForAbout(store);
  const reply: unknown = await redisPipeline([
    ["EVAL", ABOUT_WRITE_IF_STORE_LIVE, 3, storeIdCommand(named.sid)[1], ERASING_KEY, aboutKey(statsId, productId), await erasingField(storeRef(named)), expected === null ? "0" : "1", expected ?? "", text, storeRef(named)],
  ]);
  const answer = Array.isArray(reply) && reply.length === 1 && Array.isArray(reply[0]) ? (reply[0] as unknown[]) : null;
  if (answer && answer.length === 1 && answer[0] === 1) return true;
  if (expected !== null && answer && answer.length === 2 && answer[0] === 0 && Number.isSafeInteger(answer[1]) && (answer[1] as number) >= 0) return "changed";
  if (answer && answer.length === 1 && answer[0] === -1) throw new AboutStoreGoneError();
  throw new Error("a description's write could not be confirmed");
}

/**
 * writeAbout for a live store: the room taken first as before, then the write fenced by the store's erasure. Every
 * application writer (the product editor, an import, a store copy, the demo) uses this one; writeAbout itself is the
 * unfenced step the tests' small data rooms use. AboutStoreGoneError when the store is gone or erasing.
 */
export async function writeStoreAbout(store: Store, productId: string, text: string, always = false): Promise<void> {
  const changes = [{ slot: `ab:${productId}`, bytes: text ? dataBytes([text], 1) : 0, set: true }];
  if (always) await noteData(store, changes);
  else await needData(store, changes);
  await writeWhileStoreLive(store, productId, text, null);
}

/**
 * writeAboutIf for a live store (an agent's proposal confirmed or undone): the same room moves, with the compare and
 * the write fenced by the store's erasure in one step. AboutStoreGoneError when the store is gone or erasing: what this
 * step took stays counted, as on an unknown answer, and the closing walk takes the store's room with it.
 */
export async function writeStoreAboutIf(store: Store, productId: string, expected: string, text: string): Promise<true | "changed"> {
  const weight = (t: string) => (t ? dataBytes([t], 1) : 0);
  const grown = weight(text) - weight(expected);
  const slot = `ab:${productId}`;
  if (grown > 0) await needData(store, [{ slot, bytes: grown }]);
  const written = await writeWhileStoreLive(store, productId, text, expected);
  if (written === true && grown < 0) await giveData(store, [{ slot, bytes: -grown }]);
  return written;
}
