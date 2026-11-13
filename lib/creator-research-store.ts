/**
 * Where the answers to the creator research form are kept, and how long:
 * the privacy policy promises up to 24 months, so the daily job lets older
 * answers go (app/api/cron/plans). Newest first, as the form adds them.
 *
 * "Deleted whenever you ask" (app/creators/page.tsx) and the policy's copy of
 * your data are kept by forgetResearchPerson and researchCopyPerson, which
 * find a person's answers by the address they typed (r24 unit 1).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";

export const RESPONSES_KEY = "nl:creators:responses";

/** How long an answer is kept: 24 months. */
const KEEP_MS = 730 * 24 * 60 * 60 * 1000;

/** A missing or extra result cannot establish absence or a completed removal. */
function singleResult(reply: unknown): unknown {
  if (!Array.isArray(reply) || reply.length !== 1) throw new Error("Research pruning reply is unconfirmed");
  const slot = Object.getOwnPropertyDescriptor(reply, "0");
  if (!slot || !Object.prototype.hasOwnProperty.call(slot, "value")) throw new Error("Research pruning reply is unconfirmed");
  return slot.value;
}

/** Drops the answers older than 24 months, from the oldest end. Returns how many. */
export async function pruneResearch(now = Date.now()): Promise<number> {
  if (!isRedisConfigured()) return 0;
  let dropped = 0;
  for (let step = 0; step < 500; step += 1) {
    const oldest = singleResult(await redisPipeline([["LINDEX", RESPONSES_KEY, -1]]));
    if (oldest === null) break;
    if (typeof oldest !== "string") throw new Error("Research pruning read is unconfirmed");
    let created = Number.NaN;
    try {
      created = Date.parse(String((JSON.parse(oldest) as { createdAt?: unknown }).createdAt));
    } catch {
      created = Number.NaN;
    }
    // Something unreadable at the old end is let go of too: it cannot be dated.
    if (Number.isFinite(created) && now - created < KEEP_MS) break;
    const removed = singleResult(await redisPipeline([["LREM", RESPONSES_KEY, -1, oldest]]));
    if (removed !== 0 && removed !== 1) throw new Error("Research pruning removal is unconfirmed");
    dropped += removed;
  }
  return dropped;
}

/** Answers read per command when a person's answers are looked for: one LRANGE each. */
export const RESEARCH_PAGE = 100;
/**
 * Pages one walk may read: 50,000 answers, far above what the form's per-network limit lets in within the 24 months an
 * answer is kept. A walk that has not reached the end by then is unknown, never "nothing of theirs".
 */
export const RESEARCH_PAGES = 500;
/** Walks one deletion may make: each removes what it found, the last must find nothing left. */
const FORGET_WALKS = 3;

/** The form's own test of an address (app/api/creators/route.ts). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What a person sent to the research form, every field as it was kept, for their copy of their data. */
export type ResearchAnswerCopy = Record<string, unknown>;

/**
 * A deletion that did not end confirmed: `removed` answers were deleted, and the rest is not known to be gone.
 * Never a finished deletion; the caller keeps the request open and asks again.
 */
export class ResearchForgetIncomplete extends Error {
  readonly removed: number;
  constructor(removed: number, why: string, cause?: unknown) {
    super(`Deleting a person's research answers did not finish: ${why} (${removed} deleted)`, cause === undefined ? undefined : { cause });
    this.name = "ResearchForgetIncomplete";
    this.removed = removed;
  }
}

/** The address as the form compares it: trimmed and lower case. Anything that is not an address is refused. */
function addressOf(email: string): string {
  const address = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!address || !EMAIL_PATTERN.test(address)) throw new TypeError("A research answer is looked for by an email address");
  return address;
}

/**
 * The address an answer was sent from, lower case. An answer that does not read as the form writes it (JSON, an
 * object with a non-empty string email) cannot be told apart from theirs, so it is unknown, never someone else's.
 */
function senderOf(entry: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry);
  } catch {
    throw new UnknownReplyError("a creator research answer");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UnknownReplyError("a creator research answer");
  const email = Object.getOwnPropertyDescriptor(parsed, "email")?.value;
  if (typeof email !== "string" || !email.trim()) throw new UnknownReplyError("a creator research answer");
  return email.trim().toLowerCase();
}

/** Walks one look may begin: a walk that finds the list moved under it starts again, at most this many times. */
const WALK_TRIES = 3;

/** Said when the list moved under a walk: what it read can no longer be told complete. */
class ListMoved extends Error {}

/**
 * One walk of the whole list from its newest end, each page starting at the last answer of the page before (the
 * anchor). The form's LPUSH only moves the anchor later, so what lies between is read twice and kept once; a
 * removal before it (the pruning works at the other end; another person's deletion) moves it earlier, onto the page
 * already read, and the answer after it would be passed over: so an anchor not found where it can be means the walk
 * cannot tell it read everything, and says so. A walk from the oldest end would be moved by the daily pruning.
 */
async function walkOnce(address: string): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  let start = 0;
  let anchor: string | null = null;
  for (let page = 0; page < RESEARCH_PAGES; page += 1) {
    const reply = repliesFor(await redisPipeline([["LRANGE", RESPONSES_KEY, start, start + RESEARCH_PAGE - 1]]), 1);
    const items = reply ? stringList(reply[0]) : null;
    if (!items || items.length > RESEARCH_PAGE) throw new UnknownReplyError("a page of the creator research answers");
    let from = 0;
    if (anchor !== null) {
      const at = items.indexOf(anchor);
      if (at < 0) throw new ListMoved();
      from = at + 1;
    }
    for (let i = from; i < items.length; i += 1) {
      const entry = items[i];
      if (senderOf(entry) !== address || seen.has(entry)) continue;
      seen.add(entry);
      found.push(entry);
    }
    // Only a page that reached the oldest end comes back short.
    if (items.length < RESEARCH_PAGE) return found;
    anchor = items[items.length - 1];
    start += items.length - 1;
  }
  throw new UnknownReplyError("the creator research answers (longer than one walk reads)");
}

/**
 * Every answer kept under the address, exactly as stored, newest first, from one whole walk of the list. A page not
 * read in its exact shape, an answer that cannot be read, a list longer than the walk's ceiling, or a list that moved
 * under every try throws UnknownReplyError; an empty list (no key) is confirmed absence.
 */
async function answersOf(address: string): Promise<string[]> {
  if (!isRedisConfigured()) throw new UnknownReplyError("the creator research answers (no database)");
  for (let walk = 0; walk < WALK_TRIES; walk += 1) {
    try {
      return await walkOnce(address);
    } catch (error) {
      if (!(error instanceof ListMoved)) throw error;
    }
  }
  throw new UnknownReplyError("the creator research answers (the list moved under every walk)");
}

/**
 * The person's copy of what they sent to the research form: each answer as it was kept, newest first. Unknown
 * throws (UnknownReplyError), never an empty copy; an address with nothing kept gets [].
 */
export async function researchCopyPerson(email: string): Promise<ResearchAnswerCopy[]> {
  const address = addressOf(email);
  return (await answersOf(address)).map((entry) => JSON.parse(entry) as ResearchAnswerCopy);
}

/**
 * Deletes every research answer sent from the address (its name, email, country, link and answers), and returns
 * how many went. Done only when a whole walk of the list finds none of theirs left. A page or answer that cannot be
 * read throws UnknownReplyError before anything is removed; a removal whose receipt is not an exact count, or
 * answers still found after the last walk, throw ResearchForgetIncomplete with what was removed, never a finished
 * deletion. A receipt of 0 is an answer another job (the 24-month pruning) took first.
 */
export async function forgetResearchPerson(email: string): Promise<number> {
  const address = addressOf(email);
  let removed = 0;
  for (let walk = 0; walk < FORGET_WALKS; walk += 1) {
    let found: string[];
    try {
      found = await answersOf(address);
    } catch (error) {
      if (removed === 0) throw error;
      throw new ResearchForgetIncomplete(removed, "the list could not be read again", error);
    }
    if (found.length === 0) return removed;
    for (const entry of found) {
      let count: number | null = null;
      let cause: unknown;
      try {
        const reply = repliesFor(await redisPipeline([["LREM", RESPONSES_KEY, 0, entry]]), 1);
        count = reply ? countOf(reply[0]) : null;
      } catch (error) {
        cause = error;
      }
      if (count === null) throw new ResearchForgetIncomplete(removed, "a removal was not confirmed", cause);
      removed += count;
    }
  }
  throw new ResearchForgetIncomplete(removed, "answers were still found after the last walk");
}
