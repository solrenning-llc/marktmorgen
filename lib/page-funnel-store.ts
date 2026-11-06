/**
 * Where a store's funnels of pages are kept (lib/page-funnel.ts says what one
 * is), how a page finds the one it is a step of, and how many people each
 * step reached.
 *
 *   nl:pfunnels:<statsId>                      -> hash: funnel id -> the funnel, as JSON
 *   nl:pfunnel:seen:<statsId>:<id>:<since>:<i> -> HyperLogLog: the people who opened step i
 *   nl:pfunnel:done:<statsId>:<id>:<since>:<i> -> HyperLogLog: those who signed up or paid there
 *
 * One hash field per funnel, so two people saving two funnels at once never
 * write over each other. Nobody is kept: a person is a fingerprint of their
 * connection and browser for this one funnel, folded into a count that can
 * say how many but never who (the same way the store's daily visitors are
 * counted, lib/stats.ts). The counts start again whenever the steps change,
 * because a share of people who went on means nothing across two different
 * funnels, and are forgotten 400 days after the last person counted.
 */
import { type DataChange, type DataStore, giveData, needData, noteData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import type { Listing, Store } from "@/lib/store";
import { readListings } from "@/lib/catalog";
import { pageOut } from "@/lib/site-page-rules";
import { productSegment } from "@/lib/product-slug";
import {
  MAX_FUNNEL_PAGES,
  MAX_PAGE_FUNNELS,
  type PageFunnel,
  type PageFunnelStep,
  STEP_WHY,
  nextOpen,
  parsePageFunnels,
  productStepProblem,
  withMark,
} from "@/lib/page-funnel";

const funnelsKey = (statsId: string) => `nl:pfunnels:${statsId}`;
const seenKey = (statsId: string, funnel: PageFunnel, index: number) => `nl:pfunnel:seen:${statsId}:${funnel.id}:${funnel.since}:${index}`;
const doneKey = (statsId: string, funnel: PageFunnel, index: number) => `nl:pfunnel:done:${statsId}:${funnel.id}:${funnel.since}:${index}`;
const KEEP_SECONDS = 400 * 86_400;

/** Every funnel of a store, oldest first. */
export async function readPageFunnels(statsId: string | null): Promise<PageFunnel[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["HVALS", funnelsKey(statsId)]]);
  const list = Array.isArray(raw)
    ? raw.flatMap((value) => {
        try {
          return [JSON.parse(String(value)) as unknown];
        } catch {
          return [];
        }
      })
    : [];
  return parsePageFunnels(list).sort((a, b) => a.since - b.since || a.id.localeCompare(b.id));
}

/** Management reads must distinguish confirmed empty inventory from unavailable data. */
export async function readPageFunnelsStrict(statsId: string | null): Promise<PageFunnel[]> {
  if (!statsId || !isRedisConfigured()) throw new Error("Funnel inventory unavailable");
  const replies = await redisPipeline([["HVALS", funnelsKey(statsId)]]);
  if (!Array.isArray(replies) || replies.length !== 1 || !Array.isArray(replies[0])) {
    throw new Error("Incomplete funnel inventory");
  }
  const raw = replies[0];
  const records: unknown[] = raw.map((value) => {
    if (typeof value !== "string") throw new Error("Invalid funnel inventory record");
    return JSON.parse(value) as unknown;
  });
  const funnels = parsePageFunnels(records);
  if (funnels.length !== records.length) throw new Error("Invalid funnel inventory");
  return funnels.sort((a, b) => a.since - b.since || a.id.localeCompare(b.id));
}

/** One funnel by its id, or null. */
export async function readPageFunnel(statsId: string | null, id: string): Promise<PageFunnel | null> {
  if (!statsId || !id || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["HGET", funnelsKey(statsId), id]]);
  if (typeof raw !== "string") return null;
  try {
    return parsePageFunnels([JSON.parse(raw)])[0] ?? null;
  } catch {
    return null;
  }
}

/** A single-field mutation must have exactly one explicit Redis acknowledgement. */
function confirmedMutation(replies: unknown[]): 0 | 1 {
  if (replies.length !== 1) throw new Error("Funnel mutation acknowledgement missing");
  const value = replies[0];
  if (value === 0 || value === "0") return 0;
  if (value === 1 || value === "1") return 1;
  throw new Error("Funnel mutation acknowledgement invalid");
}

/** Capacity, identity and address ownership are checked with the write. */
export const SAVE_PAGE_FUNNEL = `-- marktmorgen:funnel-save:v1
local kind = redis.call("TYPE", KEYS[1]).ok
if kind ~= "none" and kind ~= "hash" then return -3 end
local exists = redis.call("HEXISTS", KEYS[1], ARGV[1])
if ARGV[4] == "new" then
  if exists == 1 then return -2 end
  if redis.call("HLEN", KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
elseif ARGV[4] ~= "edit" or exists == 0 then return -2 end
local valid, incoming = pcall(cjson.decode, ARGV[2])
if not valid or type(incoming) ~= "table" or incoming.id ~= ARGV[1] or type(incoming.slug) ~= "string" then return -3 end
local rows = redis.call("HGETALL", KEYS[1])
for i = 1, #rows, 2 do
  local ok, held = pcall(cjson.decode, rows[i + 1])
  if not ok or type(held) ~= "table" or held.id ~= rows[i] or type(held.slug) ~= "string" then return -3 end
  if rows[i] ~= ARGV[1] and string.lower(held.slug) == string.lower(incoming.slug) then return -1 end
end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
return 1`;

/**
 * What a funnel's counts can weigh, in bytes: two HyperLogLogs a step (who
 * opened it, who signed up or paid there), each at most 12 KB with its key.
 * Counted in the store's data room with the funnel, before it is saved, and
 * for KEEP_SECONDS once its steps change or it is removed: its counts are
 * kept that long after their last visitor, and from then on have none.
 */
export const FUNNEL_COUNT_BYTES_PER_STEP = 2 * (12_304 + 128);
const countsBytes = (funnel: Pick<PageFunnel, "steps">) => funnel.steps.length * FUNNEL_COUNT_BYTES_PER_STEP;
const slotOf = (id: string) => `pf:${id}`;
const countsLeft = (funnel: PageFunnel, now: number): DataChange => ({ until: now + KEEP_SECONDS * 1000, bytes: countsBytes(funnel) });

/**
 * Keeps a funnel without exceeding capacity, duplicating an address or
 * resurrecting a removed record. Its room is taken first (DataRoomError when
 * it does not fit), and given back when the save is not confirmed.
 */
export async function writePageFunnel(statsId: string, funnel: PageFunnel, existing: readonly PageFunnel[], room: DataStore, now = Date.now()): Promise<PageFunnel> {
  const held = existing.find((f) => f.id === funnel.id) ?? null;
  const isNew = !held;
  const changes: DataChange[] = [{ slot: slotOf(funnel.id), bytes: countsBytes(funnel) + dataBytes([JSON.stringify(funnel)], 1), set: true }];
  // Counts of steps that changed stop being written to, and stay until they expire.
  if (held && held.since !== funnel.since) changes.push(countsLeft(held, now));
  await needData(room, changes, now);
  let replies: unknown[];
  try {
    replies = await redisPipeline([["EVAL", SAVE_PAGE_FUNNEL, 1, funnelsKey(statsId), funnel.id, JSON.stringify(funnel), MAX_PAGE_FUNNELS, isNew ? "new" : "edit"]]);
  } catch (error) {
    if (isNew) await giveData(room, [{ slot: slotOf(funnel.id), bytes: 0, set: true }], now);
    throw error;
  }
  if (replies.length !== 1 || replies[0] !== 1) {
    if (isNew) await giveData(room, [{ slot: slotOf(funnel.id), bytes: 0, set: true }], now);
    throw new Error("Funnel save could not be confirmed; review saved funnels before retrying");
  }
  return funnel;
}

/** Removes a funnel. Its numbers go with it, by their own expiry, and are counted until then. */
export async function dropPageFunnel(statsId: string, id: string, room: DataStore, existing: readonly PageFunnel[] = [], now = Date.now()): Promise<boolean> {
  const replies = await redisPipeline([["HDEL", funnelsKey(statsId), id]]);
  const removed = confirmedMutation(replies) === 1;
  if (removed) {
    const held = existing.find((f) => f.id === id);
    await noteData(room, [{ slot: slotOf(id), bytes: 0, set: true }, ...(held ? [countsLeft(held, now)] : [{ until: now + KEEP_SECONDS * 1000, bytes: MAX_FUNNEL_PAGES * FUNNEL_COUNT_BYTES_PER_STEP }])], now);
  }
  return removed;
}

/** What one step is, as the store stands: its title, where it is, and whether it can be shown. */
export type StepState = {
  step: PageFunnelStep;
  title: string;
  /** Its own address, without the funnel's mark. */
  path: string | null;
  /** A product's step: free (an email asked for) or paid. */
  free: boolean;
  open: boolean;
  /** Said to the creator when it is not open. */
  why: string;
  /** Studio-only opt-in; never serialized by the public navigation callers. */
  reviewProduct?: Listing;
};

/**
 * Every step of a funnel as the store stands, read with one look at the
 * catalog for the products it names: what the studio shows, and what a page
 * needs to know where "next" is.
 */
export async function stepStates(store: Store, funnel: Pick<PageFunnel, "steps">, options: { strictProducts?: boolean; includeReviewProduct?: boolean } = {}): Promise<StepState[]> {
  const productIds = funnel.steps.filter((s) => s.kind === "product").map((s) => s.id);
  const listings: Listing[] = productIds.length
    ? options.strictProducts ? await readListings(store, productIds) : await readListings(store, productIds).catch(() => [])
    : [];
  if (options.strictProducts) {
    const existing = new Set(store.catalog.items.map(item => item.id));
    const loaded = new Set(listings.map(product => product.id));
    if (productIds.some(id => existing.has(id) && !loaded.has(id))) throw new Error("Funnel product availability could not be checked");
  }
  const now = Math.floor(Date.now() / 1000);
  return funnel.steps.map((step) => {
    if (step.kind === "page") {
      const page = store.sitePages.find((p) => p.id === step.id) ?? null;
      if (!page) return { step, title: "A deleted page", path: null, free: false, open: false, why: STEP_WHY["page-gone"] };
      const out = pageOut(page, now);
      return { step, title: page.title, path: `/@${store.handle}/${page.slug}`, free: false, open: out, why: out ? "" : STEP_WHY["page-back"] };
    }
    const product = listings.find((p) => p.id === step.id) ?? null;
    const problem = productStepProblem(product);
    return {
      step,
      title: product?.title ?? "A deleted product",
      path: product && !problem ? `/@${store.handle}/p/${productSegment(product)}` : null,
      free: product ? product.priceCents === 0 : false,
      open: problem === null,
      why: problem ? STEP_WHY[problem] : "",
      ...(options.includeReviewProduct && product ? { reviewProduct: product } : {}),
    };
  });
}

/** Where a visitor goes after step `from` of this funnel: the next step that can be shown, with the funnel's mark, or null at the end. */
export function nextHref(funnel: PageFunnel, states: StepState[], from: number): string | null {
  const at = nextOpen(funnel, from, (step) => states.find((s) => s.step === step)?.open ?? false);
  const path = at >= 0 ? states[at]?.path : null;
  return path ? withMark(path, funnel.id) : null;
}

/**
 * The funnel a page was opened in, and where in it the page is, from the mark
 * in its address: only a funnel that is on, and only when this page or product
 * is one of its steps. Anything else is a page opened on its own.
 */
export async function funnelHere(
  store: Store,
  mark: string,
  kind: PageFunnelStep["kind"],
  id: string,
): Promise<{ funnel: PageFunnel; index: number; next: string | null } | null> {
  if (!mark) return null;
  const funnel = await readPageFunnel(store.statsId, mark).catch(() => null);
  if (!funnel || !funnel.on) return null;
  const index = funnel.steps.findIndex((step) => step.kind === kind && step.id === id);
  if (index < 0) return null;
  // Only what comes after this step is looked at.
  const states = await stepStates(store, { steps: funnel.steps.slice(index + 1) });
  const offset = index + 1;
  const at = nextOpen({ steps: funnel.steps.slice(offset) }, -1, (step) => states.find((s) => s.step === step)?.open ?? false);
  const path = at >= 0 ? states[at]?.path : null;
  return { funnel, index, next: path ? withMark(path, funnel.id) : null };
}

/** A person, for one funnel only: a fingerprint of their connection and browser, never kept as it is. */
export function funnelVisitor(statsId: string, funnelId: string, ip: string, userAgent: string): string {
  return createHash("sha256").update(`funnel|${statsId}|${funnelId}|${ip}|${userAgent}`).digest("hex").slice(0, 24);
}

/**
 * Counts a person opening step `index`. Never throws: a count must not stop a
 * page. Answers whether the count changed, false for somebody it already
 * had (app/api/store/hit keeps the store's signal only then).
 */
export async function countFunnelStep(statsId: string, funnel: PageFunnel, index: number, visitor: string): Promise<boolean> {
  if (!isRedisConfigured() || index < 0 || index >= funnel.steps.length) return false;
  const key = seenKey(statsId, funnel, index);
  const [added] = await redisPipeline([["PFADD", key, visitor], ["EXPIRE", key, KEEP_SECONDS]]).catch(() => [0]);
  return Number(added) === 1;
}

/** Counts a person signing up or paying at step `index`. Never throws. */
export async function countFunnelDone(statsId: string, funnel: PageFunnel, index: number, visitor: string): Promise<void> {
  if (!isRedisConfigured() || index < 0 || index >= funnel.steps.length) return;
  const key = doneKey(statsId, funnel, index);
  await redisPipeline([["PFADD", key, visitor], ["EXPIRE", key, KEEP_SECONDS]]).catch(() => {});
}

/** How many people opened each step, and how many signed up or paid at each product step, since the steps last changed. */
export async function readFunnelCounts(statsId: string | null, funnel: PageFunnel): Promise<{ seen: number; done: number }[]> {
  if (!statsId || !isRedisConfigured()) return funnel.steps.map(() => ({ seen: 0, done: 0 }));
  const commands = funnel.steps.flatMap((_, i) => [["PFCOUNT", seenKey(statsId, funnel, i)], ["PFCOUNT", doneKey(statsId, funnel, i)]]);
  const replies = await redisPipeline(commands).catch(() => [] as unknown[]);
  return funnel.steps.map((_, i) => ({ seen: Number(replies[i * 2] ?? 0) || 0, done: Number(replies[i * 2 + 1] ?? 0) || 0 }));
}

/** Studio analytics: failed, incomplete or malformed reads remain unknown. */
export async function readFunnelCountsStrict(statsId: string | null, funnel: PageFunnel): Promise<{ seen: number; done: number }[]> {
  if (!statsId || !isRedisConfigured()) throw new Error("Funnel counts unavailable");
  const commands = funnel.steps.flatMap((_, i) => [["PFCOUNT", seenKey(statsId, funnel, i)], ["PFCOUNT", doneKey(statsId, funnel, i)]]);
  const replies = await redisPipeline(commands);
  if (!Array.isArray(replies) || replies.length !== commands.length) throw new Error("Incomplete funnel counts");
  const counts: number[] = [];
  for (let index = 0; index < replies.length; index += 1) {
    const reply = replies[index];
    const value = typeof reply === "number" ? reply : typeof reply === "string" && /^\d+$/.test(reply) ? Number(reply) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid funnel count");
    counts.push(value);
  }
  return funnel.steps.map((_, i) => ({ seen: counts[i * 2], done: counts[i * 2 + 1] }));
}
