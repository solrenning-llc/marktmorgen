/**
 * A deleted store's webhooks, API keys and assistant notes whose forgetting failed (added
 * 5 November 2026, review of #2556, LEVE 3 of Reviewer 1): never left to a
 * log line. The store's delete (app/api/store/stores) puts it in line, and
 * the daily closing job (app/api/cron/closing) tries it again, at most
 * FORGET_TRIES times in all, FORGET_PER_RUN stores a run. What is still kept
 * after the last try stays in line, marked, and is counted every month for
 * the owner's report (storeForgetMonth): numbers only, no store, no person.
 *
 *   nl:forget:q                 hash  "<statsId>|<sid>" → { tries, first, last }: tried again daily
 *   nl:forget:kept              hash  the same, given up: never read by the daily run
 *
 * A given-up entry leaves the line for nl:forget:kept, so the daily HGETALL
 * holds only the stores of the last FORGET_TRIES days (review of #2556 at
 * c6267d1ef). It is kept there for good, on purpose: it is what tells the
 * owner that data is still kept. It is shown to the owner only once
 * storeForgetMonth / storeForgetLine are wired into the monthly owner report
 * (lib/company-margin-report.ts, queue item 465 [MR2], reserved by Codex E);
 * until then it is counted here and logged by the closing job, and nothing
 * takes it out.
 *   nl:forget:month:<YYYY-MM>   hash  queued, done, gaveUp counts for the month, 400 days
 *
 * Its cost is Redis commands only, no supplier: each try runs
 * forgetStoreWebhooks (two pipelines: 13 + 2 × LOG_SIZE commands, and 3 more
 * for each endpoint it names: the MAX_ENDPOINTS configured and up to
 * MAX_ENDPOINTS told on each of the last three days, lib/webhooks.ts, so
 * 4 × MAX_ENDPOINTS) and revokeAllKeys (4 + MAX_KEYS: the list read, each key's
 * lookup, and the list, its holds and its uses deleted) and forgetMemory (its
 * MEMORY_FORGET_COMMANDS: the assistant's notes, added 5 November 2026), plus at most four for
 * the line itself: FORGET_TRY_COMMANDS, its worst (review of #2556 at c6267d1ef). At most FORGET_TRIES tries
 * a deleted store, at most FORGET_PER_RUN stores a day, and only for a delete
 * whose first try failed (held in tests/sg2-unknown-replies.test.ts).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { LOG_SIZE, forgetStoreWebhooks } from "@/lib/webhooks";
import { MAX_ENDPOINTS } from "@/lib/webhook-limits";
import { MAX_KEYS, revokeAllKeys } from "@/lib/api-keys";
import { MEMORY_FORGET_COMMANDS, forgetMemory } from "@/lib/assistant-memory-store";

/** Tries in all, the first one at the delete included: a week of daily runs and one more. */
export const FORGET_TRIES = 8;
/** Stores tried again in one run of the closing job. */
export const FORGET_PER_RUN = 25;
/** The most Redis commands one try can send (see above). */
export const FORGET_TRY_COMMANDS = 13 + 2 * LOG_SIZE + 3 * 4 * MAX_ENDPOINTS + 4 + MAX_KEYS + MEMORY_FORGET_COMMANDS + 4;
/** Redis commands one monthly owner-report read sends; company cost, not a store allowance. */
export const STORE_FORGET_MONTH_READ_COMMANDS = 4;
/** How long a month's counts are kept: past the next yearly look at them. */
const MONTH_SECONDS = 400 * 86_400;

const QUEUE = "nl:forget:q";
const KEPT = "nl:forget:kept";
const monthKey = (month: string) => `nl:forget:month:${month}`;
const monthOf = (now: number) => new Date(now).toISOString().slice(0, 7);
const STATS_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SID = /^[0-9a-f]{32}$/;

type Entry = { tries: number; first: number; last: number };

function parseEntry(raw: unknown): Entry | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Entry>;
    if (!Number.isSafeInteger(v.tries) || (v.tries as number) < 1 || !Number.isSafeInteger(v.first) || !Number.isSafeInteger(v.last)) return null;
    return { tries: v.tries as number, first: v.first as number, last: v.last as number };
  } catch {
    return null;
  }
}

/** The line's own name for a store: its stats id (or "-" when it had none) and its id. */
function fieldOf(statsId: string | null, sid: string): string | null {
  if (!SID.test(sid) || (statsId !== null && !STATS_ID.test(statsId))) return null;
  return `${statsId ?? "-"}|${sid}`;
}

/**
 * Puts a deleted store in line, after its first try failed. Once: a store
 * already in line keeps its count. Throws when the line cannot be written,
 * so the caller says so.
 */
export async function queueStoreForget(statsId: string | null, sid: string, now = Date.now()): Promise<void> {
  const field = fieldOf(statsId, sid);
  if (!field || !isRedisConfigured()) throw new Error("a deleted store's forgetting could not be put in line");
  const [added] = await redisPipeline([["HSETNX", QUEUE, field, JSON.stringify({ tries: 1, first: now, last: now } satisfies Entry)]]);
  const n = countOf(added);
  if (n === null) throw new Error("putting a deleted store's forgetting in line answered in an unknown shape");
  if (n === 1) await redisPipeline([["HINCRBY", monthKey(monthOf(now)), "queued", 1], ["EXPIRE", monthKey(monthOf(now)), MONTH_SECONDS]]);
}

/**
 * What one try does: the forgets, each safe to run again (lib/webhooks.ts,
 * lib/api-keys.ts, lib/assistant-memory-store.ts). The assistant's notes give
 * their room back to the store's data room, which outlives the store.
 */
export type ForgetWork = (statsId: string | null, sid: string) => Promise<void>;
const forgetBoth: ForgetWork = async (statsId, sid) => {
  await forgetStoreWebhooks(statsId);
  await revokeAllKeys(sid);
  // A deleted store has no plan: its room is given back as a store without one.
  await forgetMemory(statsId, { sid, statsId, subscriptionActive: false, subscriptionId: null, trialEnds: 0, planEndedAt: "" });
};

/**
 * The closing job's pass (until `deadline`, ms): each store in line not given
 * up is tried again; done, it leaves the line; failed, its count goes up, and
 * at FORGET_TRIES it is marked given up and counted for the month. A line read
 * in another shape throws: the job says so, and runs again tomorrow.
 */
export async function retryStoreForgets(deadline: number, now = Date.now(), work: ForgetWork = forgetBoth): Promise<{ done: number; failed: number; gaveUp: number; left: number }> {
  const out = { done: 0, failed: 0, gaveUp: 0, left: 0 };
  if (!isRedisConfigured()) return out;
  const [raw] = await redisPipeline([["HGETALL", QUEUE]]);
  const flat = stringList(raw);
  if (!flat || flat.length % 2 !== 0) throw new Error("the line of deleted stores to forget answered in an unknown shape");
  let tried = 0;
  for (let i = 0; i < flat.length; i += 2) {
    const field = flat[i];
    const entry = parseEntry(flat[i + 1]);
    if (tried >= FORGET_PER_RUN || Date.now() > deadline) {
      out.left += 1;
      continue;
    }
    tried += 1;
    const [statsText, sid] = field.split("|");
    const statsId = statsText === "-" ? null : statsText;
    // A field or an entry this file did not write is never tried and never dropped: it is given up and counted.
    const known = entry !== null && sid !== undefined && fieldOf(statsId, sid) === field;
    try {
      if (!known) throw new Error("an entry in an unknown shape");
      await work(statsId, sid);
      await redisPipeline([["HDEL", QUEUE, field], ["HINCRBY", monthKey(monthOf(now)), "done", 1], ["EXPIRE", monthKey(monthOf(now)), MONTH_SECONDS]]);
      out.done += 1;
    } catch (error) {
      const tries = (entry?.tries ?? FORGET_TRIES - 1) + 1;
      const gaveUp = !known || tries >= FORGET_TRIES;
      console.error(gaveUp ? "forgetting a deleted store's webhooks, keys and assistant notes was given up" : "forgetting a deleted store's webhooks, keys and assistant notes failed again", error);
      const kept = JSON.stringify({ tries, first: entry?.first ?? now, last: now });
      // Given up: out of the daily line, into the kept ones, counted for the month.
      await redisPipeline(
        gaveUp
          ? [["HSET", KEPT, field, kept], ["HDEL", QUEUE, field], ["HINCRBY", monthKey(monthOf(now)), "gaveUp", 1], ["EXPIRE", monthKey(monthOf(now)), MONTH_SECONDS]]
          : [["HSET", QUEUE, field, kept]],
      );
      if (gaveUp) out.gaveUp += 1;
      else out.failed += 1;
    }
  }
  return out;
}

/** For the owner's report: a month's counts, and what is in line now. Numbers only; null when it cannot be read. */
export type StoreForgetMonth = { month: string; queued: number; done: number; gaveUp: number; waitingNow: number; keptNow: number };

export async function storeForgetMonth(month: string): Promise<StoreForgetMonth | null> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !isRedisConfigured()) return null;
  const commands = [["HGETALL", monthKey(month)], ["HLEN", monthKey(month)], ["HLEN", QUEUE], ["HLEN", KEPT]];
  let raw: unknown;
  try {
    raw = await redisPipeline(commands);
  } catch {
    return null;
  }
  const replies = repliesFor(raw, STORE_FORGET_MONTH_READ_COMMANDS);
  if (!replies) return null;
  const [counts, countFields, waiting, given] = replies;
  const flat = stringList(counts);
  const fields = countOf(countFields);
  const waitingNow = countOf(waiting);
  const keptNow = countOf(given);
  if (!flat || fields === null || flat.length !== fields * 2 || waitingNow === null || keptNow === null) return null;
  const read: Record<string, number> = { queued: 0, done: 0, gaveUp: 0 };
  const seen = new Set<string>();
  for (let i = 0; i < flat.length; i += 2) {
    if (!Object.hasOwn(read, flat[i]) || seen.has(flat[i])) return null;
    const n = /^(0|[1-9][0-9]*)$/.test(flat[i + 1]) ? Number(flat[i + 1]) : NaN;
    if (!Number.isSafeInteger(n)) return null;
    seen.add(flat[i]);
    read[flat[i]] = n;
  }
  return { month, queued: read.queued, done: read.done, gaveUp: read.gaveUp, waitingNow, keptNow };
}

/**
 * The owner's words for it, in the report (Portuguese, the owner's language;
 * numbers only). Empty when nothing is in line and nothing was given up.
 */
export function storeForgetLine(m: StoreForgetMonth | null): string {
  if (m === null) return "Apagamento de webhooks e chaves de lojas excluídas: não foi possível ler a fila neste mês; o estado é desconhecido.";
  if (!m.queued && !m.gaveUp && !m.waitingNow && !m.keptNow) return "";
  const parts = [
    `Apagamento de webhooks e chaves de lojas excluídas em ${m.month}: ${m.queued} entraram na fila de nova tentativa, ${m.done} terminaram, ${m.gaveUp} esgotaram as ${FORGET_TRIES} tentativas.`,
    `Agora: ${m.waitingNow} aguardando nova tentativa; ${m.keptNow} com dados ainda guardados depois de todas as tentativas (registros de entregas de webhooks, que podem conter dados de compradores, e chaves de API), que precisam de ação manual.`,
  ];
  return parts.join(" ");
}
