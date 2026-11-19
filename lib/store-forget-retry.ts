/**
 * A deleted store's webhooks, API keys and assistant notes whose forgetting failed (added
 * 5 November 2026, review of #2556, LEVE 3 of Reviewer 1): never left to a
 * log line. The store's delete (app/api/store/stores) puts it in line, and
 * the daily closing job (app/api/cron/closing) tries it again, at most
 * FORGET_TRIES times in all, FORGET_PER_RUN stores a run. What is still kept
 * after the last try stays in line, marked, and is counted every month for
 * the owner's report (storeForgetMonth): numbers only, no store, no person.
 * The closing walk tries a deleted store once more when it admits it, its
 * record read gone (lib/closed-store-data.ts, admitDeleted: a delete whose
 * reply was lost may never have forgotten anything), and puts it in this
 * line only when that try fails.
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
 *   nl:forget:files             hash  <sid> → "1": a deleted store whose files were all seen to, by the delete's own
 *                                     try (every folder listed) or by a round of this line that finished; its field
 *                                     is taken out by the closing walk with the store's other keys (an index of
 *                                     lib/data-families.ts), after which no round of the walk starts for it
 *
 * Its cost is Redis commands only, no supplier: each try runs
 * forgetStoreWebhooks (two pipelines: 13 + 2 × LOG_SIZE commands, and 3 more
 * for each endpoint it names: the MAX_ENDPOINTS configured and up to
 * MAX_ENDPOINTS told on each of the last three days, lib/webhooks.ts, so
 * 4 × MAX_ENDPOINTS) and revokeAllKeys (4 + MAX_KEYS: the list read, each key's
 * lookup, and the list, its holds and its uses deleted) and forgetMemory (its
 * MEMORY_FORGET_COMMANDS: the assistant's notes, added 5 November 2026), plus at most five for
 * the line itself (four until #4348; now queueStoreForget's two exact reads, given up and files seen to, and its three
 * writes, and a try's end at most four): FORGET_TRY_COMMANDS, its worst (review of #2556 at c6267d1ef). At most FORGET_TRIES tries
 * a deleted store in each round, at most FORGET_PER_RUN stores a day, and only for a store
 * whose try at the delete (held in tests/sg2-unknown-replies.test.ts) or at the walk's
 * admission failed; another round starts only when a try at the walk's admission fails
 * while the line no longer holds the store (each such try is the walk's: one a run).
 *
 * Since #4348 a try also deletes the store's files (lib/deleted-store-files.ts), whose Blob listings, deletes and
 * Redis DEL are priced in the line deleted-store-files of tests/plan-cost-registry.ts: a pass the deadline cuts off
 * (OutOfTime) spends no try up to FORGET_LATE_PASSES times a round, and counts as a failed try after that, so a round
 * takes at most FORGET_TRIES tries and FORGET_LATE_PASSES late passes (review of #4348, Claude 7's MÉDIO on
 * f0320f0425). A round that lists the files ends only once that is noted (nl:forget:files, its reply read exactly, or
 * the try failed) or once it is given up (nl:forget:kept); the delete's own try that listed every folder notes it too
 * (noteStoreFilesForgotten). A round started while either says so (a round the walk starts) forgets the keys only,
 * never the files again (`files: false`), and either read in another shape puts nothing in line: the walk tries again
 * on its next run, and nothing is taken as done (rule 24). So a deleted store's files take the delete's own try and
 * one round of this line at most: the round is entered with one try spent (`tries: 1`), so it lists FORGET_TRIES − 1
 * times and FORGET_LATE_PASSES late passes, FORGET_TRIES + FORGET_LATE_PASSES passes with the delete's own (Claude 6's
 * MEDIUM on 8a05d01969: a round that finished noted nothing, and the walk's next round listed the files again).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, replyList, stringList } from "@/lib/redis-reply";
import { LOG_SIZE, forgetStoreWebhooks } from "@/lib/webhooks";
import { MAX_ENDPOINTS } from "@/lib/webhook-limits";
import { MAX_KEYS, revokeAllKeys } from "@/lib/api-keys";
import { MEMORY_FORGET_COMMANDS, forgetMemory } from "@/lib/assistant-memory-store";
import { OutOfTime, removeDeletedStoreFiles } from "@/lib/deleted-store-files";
import { COMMUNITY_ID } from "@/lib/community-text";

/** Tries in all, the first one at the delete included: a week of daily runs and one more. */
export const FORGET_TRIES = 8;
/** Passes of a round the deadline may cut off (OutOfTime) without spending a try; past them, a cut-off pass is a failed try. */
export const FORGET_LATE_PASSES = 8;
/** Stores tried again in one run of the closing job. */
export const FORGET_PER_RUN = 25;
/** The most Redis commands one try can send (see above). */
export const FORGET_TRY_COMMANDS = 13 + 2 * LOG_SIZE + 3 * 4 * MAX_ENDPOINTS + 4 + MAX_KEYS + MEMORY_FORGET_COMMANDS + 5;
/** Redis commands one monthly owner-report read sends; company cost, not a store allowance. */
export const STORE_FORGET_MONTH_READ_COMMANDS = 4;
/** How long a month's counts are kept: past the next yearly look at them. */
const MONTH_SECONDS = 400 * 86_400;

const QUEUE = "nl:forget:q";
const KEPT = "nl:forget:kept";

/**
 * A finished try's end, in one step: the store out of the line and the month's done counted only when that very field
 * was taken out, and the month's counts kept their term. Answers [1, done], or [0, 0] when the field was not there
 * (Codex G on main, G-20261119-0610).
 */
const COMPLETE_FORGET = `-- marktmorgen:store-forget-complete:v1
if redis.call("HDEL", KEYS[1], ARGV[1]) ~= 1 then return {0, 0} end
local done = redis.call("HINCRBY", KEYS[2], "done", 1)
redis.call("EXPIRE", KEYS[2], ARGV[2])
return {1, done}`;
const FILES = "nl:forget:files";
const monthKey = (month: string) => `nl:forget:month:${month}`;
const monthOf = (now: number) => new Date(now).toISOString().slice(0, 7);
const STATS_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SID = /^[0-9a-f]{32}$/;

/**
 * `community`: the deleted store's community id, the one folder of its files not made from its id
 * (lib/deleted-store-files.ts); `late`: passes of this round the deadline cut off; `files: false`: a round started
 * after one was given up or after its files were seen to (nl:forget:files), which forgets the keys only.
 */
type Entry = { tries: number; first: number; last: number; community?: string; late?: number; files?: false };

function parseEntry(raw: unknown): Entry | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Entry>;
    if (!Number.isSafeInteger(v.tries) || (v.tries as number) < 1 || !Number.isSafeInteger(v.first) || !Number.isSafeInteger(v.last)) return null;
    const community = typeof v.community === "string" && COMMUNITY_ID.test(v.community) ? { community: v.community } : {};
    if (v.late !== undefined && (!Number.isSafeInteger(v.late) || (v.late as number) < 0)) return null;
    if (v.files !== undefined && v.files !== false) return null;
    const late = v.late ? { late: v.late as number } : {};
    const files = v.files === false ? { files: false as const } : {};
    return { tries: v.tries as number, first: v.first as number, last: v.last as number, ...community, ...late, ...files };
  } catch {
    return null;
  }
}

/** The line's own name for a store: its stats id (or "-" when it had none) and its id. */
function fieldOf(statsId: string | null, sid: string): string | null {
  if (!SID.test(sid) || (statsId !== null && !STATS_ID.test(statsId))) return null;
  return `${statsId ?? "-"}|${sid}`;
}

/** HEXISTS's answer read exactly: 1 there, 0 not, null for anything else (rule 24). */
const presence = (reply: unknown): 0 | 1 | null => (reply === 0 || reply === 1 ? reply : null);

/**
 * Notes that a deleted store's files were all seen to: by the delete's own try once it listed every folder
 * (app/api/store/stores, forgetStoreFiles), or by a round of the line that deleted them. A round started after it
 * forgets the keys only. Throws when the note is not confirmed (HSET's own count, 0 or 1), so nothing takes it as made.
 */
export async function noteStoreFilesForgotten(sid: string): Promise<void> {
  if (!SID.test(sid) || !isRedisConfigured()) throw new Error("a deleted store's files could not be noted as seen to");
  const written = countOf(repliesFor(await redisPipeline([["HSET", FILES, sid, "1"]]), 1)?.[0]);
  if (written !== 0 && written !== 1) throw new Error("noting a deleted store's files as seen to answered in an unknown shape");
}

/**
 * Puts a deleted store in line, after its first try failed. Once: a store
 * already in line keeps its count. Throws when the line cannot be written,
 * so the caller says so.
 */
export async function queueStoreForget(statsId: string | null, sid: string, now = Date.now(), community: string | null = null): Promise<void> {
  const field = fieldOf(statsId, sid);
  if (!field || !isRedisConfigured()) throw new Error("a deleted store's forgetting could not be put in line");
  // Given up before, or its files already seen to (the walk starting another round): its keys are tried again, its
  // files are not. Each read exactly: one in another shape puts nothing in line, never a round taken as done.
  const replies = repliesFor(await redisPipeline([["HEXISTS", KEPT, field], ["HEXISTS", FILES, sid]]), 2);
  const givenUp = presence(replies?.[0]);
  const filesSeen = presence(replies?.[1]);
  if (givenUp === null || filesSeen === null) throw new Error("reading whether a deleted store's forgetting was given up, or its files seen to, answered in an unknown shape");
  const entry: Entry = { tries: 1, first: now, last: now, ...(community && COMMUNITY_ID.test(community) ? { community } : {}), ...(givenUp === 1 || filesSeen === 1 ? { files: false as const } : {}) };
  const [added] = await redisPipeline([["HSETNX", QUEUE, field, JSON.stringify(entry)]]);
  const n = countOf(added);
  if (n === null) throw new Error("putting a deleted store's forgetting in line answered in an unknown shape");
  if (n === 1) await redisPipeline([["HINCRBY", monthKey(monthOf(now)), "queued", 1], ["EXPIRE", monthKey(monthOf(now)), MONTH_SECONDS]]);
}

/**
 * What one try does: the forgets, each safe to run again (lib/webhooks.ts,
 * lib/api-keys.ts, lib/assistant-memory-store.ts). The assistant's notes give
 * their room back to the store's data room, which outlives the store.
 */
export type ForgetWork = (statsId: string | null, sid: string, community: string | null, until: number, files: boolean) => Promise<void>;
/** The Redis forgets alone: what the closing walk's admission does again (lib/closed-store-data.ts, admitDeleted). */
export const forgetBoth = async (statsId: string | null, sid: string): Promise<void> => {
  // Independent families must all be attempted, even while one cannot be read.
  // A failed family keeps the overall attempt incomplete and retryable.
  const results = await Promise.allSettled([
    forgetStoreWebhooks(statsId),
    revokeAllKeys(sid),
    // A deleted store has no plan: its room is given back as a store without one.
    forgetMemory(statsId, { sid, statsId, subscriptionActive: false, subscriptionId: null, trialEnds: 0, planEndedAt: "" }),
  ]);
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "a deleted store's forgetting is incomplete");
};
/**
 * One try from the line: the Redis forgets, and, while its files are not seen to (`files`), its files: pictures, community
 * pictures, anything left in its folders (lib/deleted-store-files.ts), stopped at the line's deadline (OutOfTime) so a
 * slow file store cannot run into the closing job's own time.
 */
const forgetTry: ForgetWork = async (statsId, sid, community, until, files) => {
  let redisFailure: { error: unknown } | null = null;
  try { await forgetBoth(statsId, sid); } catch (error) { redisFailure = { error }; }
  // Readable file folders are independent of the Redis families. Give them their bounded turn even when one of
  // those families failed; otherwise the whole round can be spent without listing a single readable folder.
  // OutOfTime still propagates directly, so the existing late-pass bound and unspent try stay in force.
  if (files) await removeDeletedStoreFiles(sid, community, undefined, until);
  if (redisFailure) throw redisFailure.error;
};

/**
 * The closing job's pass (until `deadline`, ms): each store in line not given
 * up is tried again; done, it leaves the line; failed, its count goes up, and
 * at FORGET_TRIES it is marked given up and counted for the month. A try the
 * work stopped at the deadline (OutOfTime) is not a failure: the store stays
 * in line as it was, counted as left, and no try is spent. A line read
 * in another shape throws: the job says so, and runs again tomorrow.
 */
export async function retryStoreForgets(deadline: number, now = Date.now(), work: ForgetWork = forgetTry): Promise<{ done: number; failed: number; gaveUp: number; left: number }> {
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
    let failed: { error: unknown } | null = null;
    try {
      if (!known) throw new Error("an entry in an unknown shape");
      const filesToo = entry?.files !== false;
      await work(statsId, sid, entry?.community ?? null, deadline, filesToo);
      // Its files deleted: noted before the round leaves the line, so a round the walk starts later does not list
      // them again; a note not confirmed throws, and this try counts as failed (Claude 6's MEDIUM on 8a05d01969).
      if (filesToo) await noteStoreFilesForgotten(sid);
    } catch (error) {
      failed = { error };
    }
    if (failed === null) {
      // The work is done; its end is read exactly, outside the try's catch, so a lost answer after the end was written
      // is never taken for another failed try nor counted done: it is unknown, and the run stops on it (rule 24; Codex
      // G on main, G-20261119-0610). The line is left as it was when nothing was written.
      const month = monthKey(monthOf(now));
      const completed = replyList(repliesFor(await redisPipeline([["EVAL", COMPLETE_FORGET, 2, QUEUE, month, field, MONTH_SECONDS]]), 1)?.[0]);
      const removed = completed?.length === 2 ? countOf(completed[0]) : null;
      const done = completed?.length === 2 ? countOf(completed[1]) : null;
      if (removed !== 1 || done === null || done < 1) throw new UnknownReplyError("a deleted store's finished forgetting");
      out.done += 1;
    } else {
      const error = failed.error;
      const carried = { ...(entry?.community ? { community: entry.community } : {}), ...(entry?.files === false ? { files: false as const } : {}) };
      if (known && entry && error instanceof OutOfTime && (entry.late ?? 0) < FORGET_LATE_PASSES) {
        // Cut off by the deadline, not failed: left for the next run, its tries untouched (review of #4348, MÉDIO 2),
        // up to FORGET_LATE_PASSES times a round; past them a cut-off pass is a failed try, so the round ends.
        await redisPipeline([["HSET", QUEUE, field, JSON.stringify({ tries: entry.tries, first: entry.first, last: now, ...carried, late: (entry.late ?? 0) + 1 })]]);
        out.left += 1;
        continue;
      }
      const tries = (entry?.tries ?? FORGET_TRIES - 1) + 1;
      const gaveUp = !known || tries >= FORGET_TRIES;
      console.error(gaveUp ? "forgetting a deleted store's webhooks, keys and assistant notes was given up" : "forgetting a deleted store's webhooks, keys and assistant notes failed again", error);
      // The line keeps the community while it may still walk the files; the given-up record does not (Codex N1,
      // N1-20261119-1017, LOW 2 on #4348): a kept field puts the store back in line with files: false, so the id of a
      // deleted community there would only be kept for good with no use.
      const keptCarried = gaveUp ? (entry?.files === false ? { files: false as const } : {}) : carried;
      const kept = JSON.stringify({ tries, first: entry?.first ?? now, last: now, ...keptCarried, ...(entry?.late ? { late: entry.late } : {}) });
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
