/**
 * What each person on a store's team did, month by month (639 [GL7](37)):
 * conversations they replied to in the inbox, how long the buyer waited for
 * that reply, and the deals they were responsible for that were won. For the
 * owner and admins only, listed by name, never ranked, and nothing about
 * buyers in it.
 *
 * Counted as each reply is written (lib/inbox.ts, replyTo), so reading it
 * never reads the inbox: one hash per store and month, three numbers per
 * person, taken from the store's data room before a new person's numbers
 * are written (a store with no room left keeps answering its buyers; that
 * month's numbers are then short, and the page says the figures are counted
 * from when there was room). Deals won are read from the store's own deals.
 *
 *   nl:teamwork:<statsId>:<YYYY-MM>   hash  <person>:r replies, <person>:a buyers answered, <person>:t seconds they waited
 */
import { createHash } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, keepFor } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { readDeals, readStages } from "@/lib/crm";

/** How long a month's numbers are kept: thirteen months, so a year can be compared with the one before. */
export const TEAM_WORK_KEEP_SECONDS = 400 * 86_400;
/** What one person's three numbers in one month take in the data room: their names, values and Redis's own. */
export const TEAM_WORK_PERSON_BYTES = 3 * dataBytes(["0".repeat(16) + ":t", "9999999999"]);

const key = (statsId: string, month: string) => `nl:teamwork:${statsId}:${month}`;
const personOf = (email: string) => createHash("sha256").update(`nimbus-teamwork:${normaliseEmail(email)}`).digest("hex").slice(0, 16);

/** The month a moment falls in, as YYYY-MM (UTC). */
export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/**
 * Counts one reply by `by` (a teammate's or the owner's address). When it
 * answered a buyer's message, `waitedMs` is how long the buyer waited.
 * Never throws: a reply is sent whether or not it could be counted.
 */
export async function noteReply(store: DataStore & { statsId?: string | null }, by: string, waitedMs: number | null, now = Date.now()): Promise<void> {
  try {
    if (!store.statsId || !by || !isRedisConfigured()) return;
    const k = key(store.statsId, monthOf(now));
    const who = personOf(by);
    const [known] = await redisPipeline([["HEXISTS", k, `${who}:r`]]);
    // A person's first numbers this month take their room first; with none left, nothing is counted.
    if (Number(known) !== 1 && !(await keepFor(store, TEAM_WORK_PERSON_BYTES, TEAM_WORK_KEEP_SECONDS, now))) return;
    const answered = waitedMs !== null && Number.isFinite(waitedMs) && waitedMs >= 0;
    await redisPipeline([
      ["HINCRBY", k, `${who}:r`, 1],
      ...(answered ? [["HINCRBY", k, `${who}:a`, 1], ["HINCRBY", k, `${who}:t`, Math.round((waitedMs as number) / 1000)]] : []),
      ["EXPIRE", k, TEAM_WORK_KEEP_SECONDS],
    ]);
  } catch (error) {
    console.error("counting a team reply failed", error);
  }
}

export type PersonWork = {
  email: string;
  replies: number;
  /** Buyers' messages they answered, and how long those buyers waited on average, in seconds (null with none). */
  answered: number;
  averageWaitSeconds: number | null;
  dealsWon: number;
  wonCents: number;
};

/** Each of these people's month, in the order given (by name, never ranked). */
export async function teamWorkFor(statsId: string | null, emails: string[], month: string): Promise<PersonWork[]> {
  if (!statsId || !emails.length || !isRedisConfigured()) return emails.map((email) => ({ email, replies: 0, answered: 0, averageWaitSeconds: null, dealsWon: 0, wonCents: 0 }));
  const [raw] = await redisPipeline([["HGETALL", key(statsId, month)]]);
  const flat = Array.isArray(raw) ? raw.map(String) : [];
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < flat.length; i += 2) counts.set(flat[i], Number(flat[i + 1]) || 0);
  const stages = await readStages(statsId);
  const won = new Set(stages.filter((s) => s.kind === "won").map((s) => s.id));
  const deals = (await readDeals(statsId, stages)).filter((d) => won.has(d.stage) && monthOf(d.updatedAt) === month);
  return emails.map((email) => {
    const who = personOf(email);
    const answered = counts.get(`${who}:a`) ?? 0;
    const mine = deals.filter((d) => d.assignee && normaliseEmail(d.assignee) === normaliseEmail(email));
    return {
      email,
      replies: counts.get(`${who}:r`) ?? 0,
      answered,
      averageWaitSeconds: answered ? Math.round((counts.get(`${who}:t`) ?? 0) / answered) : null,
      dealsWon: mine.length,
      wonCents: mine.reduce((sum, d) => sum + d.cents, 0),
    };
  });
}
