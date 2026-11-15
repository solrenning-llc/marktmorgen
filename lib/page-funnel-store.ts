/**
 * Where a store's funnels of pages are kept (lib/page-funnel.ts says what one
 * is), how a page finds the one it is a step of, and how many people each
 * step reached.
 *
 *   nl:pfunnels:<statsId>                      -> hash: funnel id -> the funnel, as JSON
 *   nl:pfunnel:seen:<statsId>:<id>:<since>:<i> -> HyperLogLog: the people who opened step i
 *   nl:pfunnel:done:<statsId>:<id>:<since>:<i> -> HyperLogLog: those who signed up or paid there
 *   nl:pfunnel:seen:<statsId>:<id>:<since>:<i>:<v>, nl:pfunnel:done:...:<i>:<v>
 *                                              -> the same two, for version v (a-d) of a split
 *                                                 step i; such a step has no count of its own,
 *                                                 its people are its versions' together (526 [FN2])
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
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import type { Listing, Store } from "@/lib/store";
import { readListings } from "@/lib/catalog";
import { pageOut } from "@/lib/site-page-rules";
import { productSegment } from "@/lib/product-slug";
import {
  type FunnelPlace,
  MAX_FUNNEL_PAGES,
  MAX_PAGE_FUNNELS,
  type PageFunnel,
  type PageFunnelStep,
  STEP_WHY,
  funnelPlaces,
  nextOpen,
  placeVersion,
  parsePageFunnels,
  productStepProblem,
  splitPick,
  stepIndex,
  stepPlaces,
  withMark,
} from "@/lib/page-funnel";
import { splitVersion } from "@/lib/funnel-split-rules";

const funnelsKey = (statsId: string) => `nl:pfunnels:${statsId}`;
const seenKey = (statsId: string, funnel: PageFunnel, index: number) => `nl:pfunnel:seen:${statsId}:${funnel.id}:${funnel.since}:${index}`;
const doneKey = (statsId: string, funnel: PageFunnel, index: number) => `nl:pfunnel:done:${statsId}:${funnel.id}:${funnel.since}:${index}`;
const KEEP_SECONDS = 400 * 86_400;
/** A split step's versions, a-d, in its order: the keys their counts are kept under. */
const splitVersions = (step: PageFunnelStep): string[] =>
  step.kind === "split" ? step.options.map((_, place) => splitVersion(place)).filter((version): version is string => version !== null) : [];
/** The keys of step i's count: its own, or for a split every version's (read together with one PFCOUNT, each person once). */
const stepKeys = (key: (statsId: string, funnel: PageFunnel, index: number) => string, statsId: string, funnel: PageFunnel, index: number): string[] => {
  const versions = splitVersions(funnel.steps[index]);
  return versions.length ? versions.map((version) => `${key(statsId, funnel, index)}:${version}`) : [key(statsId, funnel, index)];
};

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

/**
 * One funnel by its id, or null when Redis confirms it is not kept (an HGET
 * that answers null). Any other answer (no reply, more than one, a slot that
 * is not a text, a kept record that is not a funnel, as readPageFunnelsStrict
 * refuses one) throws UnknownReplyError, so a funnel that is there is never
 * said to be gone (CX-123 rule 24). The visitor's reads (funnelHere,
 * app/api/store/hit) catch it and show the page on its own, as before.
 */
export async function readPageFunnel(statsId: string | null, id: string): Promise<PageFunnel | null> {
  if (!statsId || !id || !isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["HGET", funnelsKey(statsId), id]]), 1);
  if (!replies) throw new UnknownReplyError("a funnel read");
  const raw = replies[0];
  if (raw === null) return null;
  if (typeof raw !== "string") throw new UnknownReplyError("a kept funnel");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new UnknownReplyError("a kept funnel");
  }
  const funnel = parsePageFunnels([value])[0];
  if (!funnel) throw new UnknownReplyError("a kept funnel");
  return funnel;
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
 * opened it, who signed up or paid there), each at most 12 KB with its key;
 * a split step has two for each of its versions instead (funnelCountsBytes).
 * Counted in the store's data room with the funnel, before it is saved, and
 * for KEEP_SECONDS once its steps change or it is removed: its counts are
 * kept that long after their last visitor, and from then on have none.
 */
export const FUNNEL_COUNT_BYTES_PER_STEP = 2 * (12_304 + 128);
/** What a funnel's counts can weigh: two counts for each page it can land a visitor on, so a split's for each version. */
export const funnelCountsBytes = (funnel: Pick<PageFunnel, "steps">) => funnelPlaces(funnel).length * FUNNEL_COUNT_BYTES_PER_STEP;
const countsBytes = funnelCountsBytes;
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
  /** Its own address, without the funnel's mark; a split has none of its own (stepTarget draws one). */
  path: string | null;
  /** A product's step: free (an email asked for) or paid. */
  free: boolean;
  /** A split: while one of its destinations can be shown. */
  open: boolean;
  /** Said to the creator when it is not open. */
  why: string;
  /** A split's destinations, each as the store stands, in its order (versions a–d). */
  options?: StepState[];
  /** Studio-only opt-in; never serialized by the public navigation callers. */
  reviewProduct?: Listing;
};

/** Said to the creator when none of a split's destinations can be shown. */
export const SPLIT_CLOSED_WHY = "None of this split test's pages can be shown right now. Visitors go on to the next step.";

/**
 * Every step of a funnel as the store stands, read with one look at the
 * catalog for the products it names (a split's included): what the studio
 * shows, and what a page needs to know where "next" is.
 */
export async function stepStates(store: Store, funnel: Pick<PageFunnel, "steps">, options: { strictProducts?: boolean; includeReviewProduct?: boolean } = {}): Promise<StepState[]> {
  const productIds = funnelPlaces(funnel).filter((s) => s.kind === "product").map((s) => s.id);
  const listings: Listing[] = productIds.length
    ? options.strictProducts ? await readListings(store, productIds) : await readListings(store, productIds).catch(() => [])
    : [];
  if (options.strictProducts) {
    const existing = new Set(store.catalog.items.map(item => item.id));
    const loaded = new Set(listings.map(product => product.id));
    if (productIds.some(id => existing.has(id) && !loaded.has(id))) throw new Error("Funnel product availability could not be checked");
  }
  const now = Math.floor(Date.now() / 1000);
  const placeState = (step: FunnelPlace): StepState => {
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
  };
  return funnel.steps.map((step) => {
    if (step.kind !== "split") return placeState(step);
    const each = step.options.map((option) => placeState({ kind: option.kind, id: option.id }));
    const open = each.some((state) => state.open && state.path !== null);
    return { step, title: `Split test: ${each.map((state) => state.title).join(" / ")}`, path: null, free: false, open, why: open ? "" : SPLIT_CLOSED_WHY, options: each };
  });
}

/** A number in [0, 1) from a secure source, fresh for each visit: nothing about the person, no cookie. */
export function visitDraw(): number {
  const one = new Uint32Array(1);
  globalThis.crypto.getRandomValues(one);
  return one[0] / 2 ** 32;
}

/**
 * Where a step sends a visitor, without the funnel's mark: its own address,
 * or for a split the address of one destination that can be shown, drawn by
 * its shares (splitPick). Null when it cannot be shown.
 */
export function stepTarget(state: StepState, draw: number = visitDraw()): string | null {
  if (state.step.kind !== "split") return state.open ? state.path : null;
  const each = state.options ?? [];
  const at = (place: FunnelPlace) => each.find((s) => s.step.kind === place.kind && s.step.id === place.id) ?? null;
  const picked = splitPick(state.step, (place) => {
    const found = at(place);
    return Boolean(found?.open && found.path);
  }, draw);
  return picked ? at(picked)?.path ?? null : null;
}

/** Whether a page of the funnel can be shown, from the states of its steps (a split's destinations included). */
const placeOpenIn = (states: readonly StepState[]) => (place: FunnelPlace) =>
  states.some((state) => [state, ...(state.options ?? [])].some((s) => s.step.kind === place.kind && s.step.id === place.id && s.open && s.path !== null));

/** Where a visitor goes after step `from` of this funnel: the next step that can be shown, with the funnel's mark, or null at the end. */
export function nextHref(funnel: PageFunnel, states: StepState[], from: number, draw: number = visitDraw()): string | null {
  const at = nextOpen(funnel, from, placeOpenIn(states));
  const path = at >= 0 && states[at] ? stepTarget(states[at], draw) : null;
  return path ? withMark(path, funnel.id) : null;
}

/**
 * The funnel a page was opened in, and where in it the page is, from the mark
 * in its address: only a funnel that is on, and only when this page or product
 * is one of its steps or one of a split's destinations (then it is at the
 * split's place). Anything else is a page opened on its own. A split next is
 * drawn afresh for this visit (`draw`, injected only by tests).
 */
export async function funnelHere(
  store: Store,
  mark: string,
  kind: FunnelPlace["kind"],
  id: string,
  draw: () => number = visitDraw,
): Promise<{ funnel: PageFunnel; index: number; place: FunnelPlace; next: string | null } | null> {
  if (!mark) return null;
  const funnel = await readPageFunnel(store.statsId, mark).catch(() => null);
  if (!funnel || !funnel.on) return null;
  const index = stepIndex(funnel, kind, id);
  if (index < 0) return null;
  // Only what comes after this step is looked at.
  const rest = funnel.steps.slice(index + 1);
  const states = await stepStates(store, { steps: rest });
  const at = nextOpen({ steps: rest }, -1, placeOpenIn(states));
  const path = at >= 0 ? stepTarget(states[at], draw()) : null;
  return { funnel, index, place: { kind, id }, next: path ? withMark(path, funnel.id) : null };
}

/** A person, for one funnel only: a fingerprint of their connection and browser, never kept as it is. */
export function funnelVisitor(statsId: string, funnelId: string, ip: string, userAgent: string): string {
  return createHash("sha256").update(`funnel|${statsId}|${funnelId}|${ip}|${userAgent}`).digest("hex").slice(0, 24);
}

/**
 * The key a person is counted under at step `index`: the step's own, or for a
 * split the key of the version `place` is (the page they are on). A split
 * counted without one of its pages has no key: nothing is counted, never a
 * guess at the version.
 */
function countKey(key: typeof seenKey, statsId: string, funnel: PageFunnel, index: number, place?: FunnelPlace): string | null {
  const step = funnel.steps[index];
  if (step.kind !== "split") return key(statsId, funnel, index);
  const version = placeVersion(step, place);
  return version ? `${key(statsId, funnel, index)}:${version}` : null;
}

/** Counts a person opening step `index`, on page `place` (which version, for a split). Never throws: a count must not stop a page. */
export async function countFunnelStep(statsId: string, funnel: PageFunnel, index: number, visitor: string, place?: FunnelPlace): Promise<void> {
  if (!isRedisConfigured() || index < 0 || index >= funnel.steps.length) return;
  const key = countKey(seenKey, statsId, funnel, index, place);
  if (!key) return;
  await redisPipeline([["PFADD", key, visitor], ["EXPIRE", key, KEEP_SECONDS]]).catch(() => {});
}

/** Counts a person signing up or paying at step `index`, on page `place` (which version, for a split). Never throws. */
export async function countFunnelDone(statsId: string, funnel: PageFunnel, index: number, visitor: string, place?: FunnelPlace): Promise<void> {
  if (!isRedisConfigured() || index < 0 || index >= funnel.steps.length) return;
  const key = countKey(doneKey, statsId, funnel, index, place);
  if (!key) return;
  await redisPipeline([["PFADD", key, visitor], ["EXPIRE", key, KEEP_SECONDS]]).catch(() => {});
}

/** Two reads a step, as always: a split's read counts its versions' people together, each once. */
const countCommands = (statsId: string, funnel: PageFunnel) =>
  funnel.steps.flatMap((_, i) => [["PFCOUNT", ...stepKeys(seenKey, statsId, funnel, i)], ["PFCOUNT", ...stepKeys(doneKey, statsId, funnel, i)]]);

/** How many people opened each step, and how many signed up or paid at each product step, since the steps last changed. */
export async function readFunnelCounts(statsId: string | null, funnel: PageFunnel): Promise<{ seen: number; done: number }[]> {
  if (!statsId || !isRedisConfigured()) return funnel.steps.map(() => ({ seen: 0, done: 0 }));
  const commands = countCommands(statsId, funnel);
  const replies = await redisPipeline(commands).catch(() => [] as unknown[]);
  return funnel.steps.map((_, i) => ({ seen: Number(replies[i * 2] ?? 0) || 0, done: Number(replies[i * 2 + 1] ?? 0) || 0 }));
}

/** Studio analytics: failed, incomplete or malformed reads remain unknown. */
export async function readFunnelCountsStrict(statsId: string | null, funnel: PageFunnel): Promise<{ seen: number; done: number }[]> {
  if (!statsId || !isRedisConfigured()) throw new Error("Funnel counts unavailable");
  const commands = countCommands(statsId, funnel);
  const counts = strictCounts(await redisPipeline(commands), commands.length);
  return funnel.steps.map((_, i) => ({ seen: counts[i * 2], done: counts[i * 2 + 1] }));
}

/** Every reply a whole count, as many as were asked; anything else throws (rule 24: unknown, never 0). */
function strictCounts(replies: unknown, expected: number): number[] {
  if (!Array.isArray(replies) || replies.length !== expected) throw new Error("Incomplete funnel counts");
  const counts: number[] = [];
  for (let index = 0; index < replies.length; index += 1) {
    const reply: unknown = replies[index];
    const value = typeof reply === "number" ? reply : typeof reply === "string" && /^\d+$/.test(reply) ? Number(reply) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid funnel count");
    counts.push(value);
  }
  return counts;
}

/** A split's figures for one version: the people who opened that page and those who signed up or paid there. */
export type SplitCount = { version: string; seen: number; done: number };

/**
 * How many versions' counts one of the store's studio requests pays for: two
 * reads a version, against the twenty commands a studio request is priced at
 * (tests/plan-cost-registry.ts, UNIT_COST.studio; line studio).
 */
export const SPLIT_COUNTS_PER_UNIT = 10;

/** The studio requests a funnel's reads per version take first: none for a funnel without a split. */
export function splitCountUnits(funnel: Pick<PageFunnel, "steps">): number {
  const versions = funnel.steps.reduce((sum, step) => sum + (step.kind === "split" ? stepPlaces(step).length : 0), 0);
  return Math.ceil(versions / SPLIT_COUNTS_PER_UNIT);
}

/**
 * Each split step's counts per version, in its order (versions a-d); null for
 * a step that is not a split. The same counts the step's own read folds
 * together, read one version at a time. Strict: a failed, short or odd reply
 * throws, never 0. The studio takes splitCountUnits(funnel) of its requests
 * before calling it.
 */
export async function readSplitCountsStrict(statsId: string | null, funnel: PageFunnel): Promise<(SplitCount[] | null)[]> {
  if (!statsId || !isRedisConfigured()) throw new Error("Funnel counts unavailable");
  const commands = funnel.steps.flatMap((step, i) =>
    splitVersions(step).flatMap((version) => [["PFCOUNT", `${seenKey(statsId, funnel, i)}:${version}`], ["PFCOUNT", `${doneKey(statsId, funnel, i)}:${version}`]]),
  );
  if (!commands.length) return funnel.steps.map(() => null);
  const counts = strictCounts(await redisPipeline(commands), commands.length);
  let at = 0;
  return funnel.steps.map((step) => {
    if (step.kind !== "split") return null;
    return splitVersions(step).map((version) => {
      const count = { version, seen: counts[at], done: counts[at + 1] };
      at += 2;
      return count;
    });
  });
}
