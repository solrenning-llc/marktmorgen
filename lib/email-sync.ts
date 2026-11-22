/**
 * Sending the people who agreed to hear from a creator on to the creator's
 * own email platform: Mailchimp, Kit, beehiiv or MailerLite.
 *
 * The creator pastes an API key of their account, and it is checked with the
 * platform, sealed (lib/secret-box.ts) and kept; the studio never sees it
 * again, only its last four characters. They pick the audience, form,
 * publication or group to add people to, read fresh from the platform, and
 * choose who is sent there:
 *
 *   - people who asked for a free product and confirmed their address (the
 *     moment the emailed link is used, lib/free.ts), and
 *   - buyers: of every product, of some products, or none,
 *
 * with up to MAX_TAGS_PER_PRODUCT tags per product (groups, on MailerLite).
 *
 * Consent decides, whatever the setting. Somebody is sent only if they
 * agreed to hear from the creator: on a free product, by ticking the box on
 * its form; as a buyer, by ticking "Also send me emails" on the store's
 * checkout (the checkout's metadata "news"), or by agreeing to promotional
 * emails on Stripe's own page, where Stripe asks (consent_collection
 * .promotions, "opt_in"). A buyer who did neither is never sent, and the log
 * says so without keeping their address. Choosing buyers here is what puts
 * the box on the checkout for those products (Store.emailSync), exactly as
 * writing to a list does on Pro.
 *
 * Sending works like the webhooks (lib/webhooks.ts): each person is a job,
 * tried once at once, after the answer to whatever noticed it has gone, and
 * when the platform does not take them — it did not answer, asked us to slow
 * down, refused the key, or lost the audience — again after RETRY_MINUTES (5
 * minutes, 15, 1 hour, 3, 12, 24): seven tries, then it is marked failed. A
 * platform that refuses the person themselves (an address it will not take)
 * is not asked again. Retries ride the five-minute job. The last LOG_SIZE
 * jobs of a store are kept for its studio, each for a week at most; a job
 * pushed past them is deleted unless it is still waiting, so every record
 * that holds an address stays in the log or on the queue, where a person's
 * copy and erasure find it (dropOverflow, retire). Each
 * person and event is sent once however often it is noticed, and nothing
 * that happened before the platform was connected is sent (a checkout opened
 * up to an hour before and paid after is).
 *
 *   nl:esync:cfg:<statsId>      the settings, with the key sealed
 *   nl:esync:tags:<statsId>     tag and group ids learned from the platform
 *   nl:esync:bad:<statsId>      the last problem with the key or the audience
 *   nl:esync:j:<job>            one job and how it went, for a week
 *   nl:esync:log:<statsId>      the store's last jobs, newest first
 *   nl:esync:q                  jobs waiting for a try, by when
 *   nl:esync:seen:<hash>        a person and event already sent, thirty days
 */
import { createHash, randomBytes } from "node:crypto";
import { after } from "next/server";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { normaliseEmail } from "@/lib/auth";
import { canSeal, seal, unseal } from "@/lib/secret-box";
import {
  type EmailProvider,
  PROVIDER_NAMES,
  PlatformError,
  TARGET_WORDS,
  type TagCache,
  type Target,
  addContact,
  isProvider,
  keyProblem,
  listTargets,
  ping,
} from "@/lib/email-platforms";
import { type EmailSyncRef, type Store, setEmailSyncRef, storeRef } from "@/lib/store";
import { productIds } from "@/lib/catalog";
import { SITE_URL } from "@/lib/site-url";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import type { ReadBudget } from "@/lib/copy-pages";

/** Jobs a store's studio keeps. */
export const LOG_SIZE = 50;
/**
 * The store's queued index is read a page of QUEUED_PAGE ids at a time (#5125): a copy in pages, inside its request's
 * budget (syncJobsPage); an erasure to the end, never failing closed at a fixed count (Claude 1 coord, mail 7937).
 */
export const QUEUED_PAGE = 500;

/**
 * The one-time fill of the stores' queued indexes from the shared queue (Claude 1 DKvY's MEDIUM on #5135, mail 4534;
 * design Claude 1 coord bb02): jobs already waiting when the index shipped were queued before it, so they are in no
 * index. The five-minute job (syncDue) reads the shared queue with ZSCAN from a kept position and notes each member's
 * id in its store's index (SADD and EXPIRE); at the end of the scan it sets FILL_DONE_KEY for good. ZSCAN returns every
 * member present for the whole scan, and a job queued meanwhile notes itself (queuePerson). Until the mark is set, a
 * person's copy and both erasures read the store's waiting jobs from the shared queue, as before the index
 * (waitingPage), never only from an index that may miss one.
 *
 * Cost (Claude 1 coord 4680: a one-time company cost, no registry line): one run sends at most FILL_RUN_COMMANDS
 * commands, every read and write counted before it is sent, a page larger than what is left noted in member order
 * and gone on from after its last member. A queue of Q members takes about 2.004 Q commands in all (2 a member, a
 * ZSCAN and a SET a page of QUEUED_PAGE, 3 a run): at Upstash's $2 a million, $0.000004 a member, so the queue main
 * reads at its own bound (10,000 pages of 500, 5,000,000 members) would cost about $20.04 once, over 501 runs. With
 * PLANS_ON_SALE false the queue is empty at deploy, so the fill ends on its first run (GET, GET, ZSCAN, SET, DEL).
 * If it ever holds jobs at the opening, that one-time sum belongs in the fixed costs (FX275). Recurring, once done:
 * one GET of the mark a run, 288 a day, about 8,640 commands a month ($0.017 a month), a company fixed cost of the
 * five-minute job (Claude 1 E's NIT on #5135).
 */
export const FILL_ROUNDS = 20;
/** The most commands one run of the fill sends: FILL_ROUNDS pages of one ZSCAN and two commands a member. */
export const FILL_RUN_COMMANDS = FILL_ROUNDS * (1 + 2 * QUEUED_PAGE);
const FILL_CURSOR_KEY = "nl:esync:qdfill:cursor";
const FILL_DONE_KEY = "nl:esync:qdfill:done";
/** Where the fill goes on: a ZSCAN cursor, and within that page the last member already noted (or none). */
const FILL_AT = /^(\d+)(?: (.{1,600}))?$/;

/** Whether FILL_DONE_KEY's reply says the fill finished; another shape is unknown, never "finished". */
function filledFrom(reply: unknown): boolean {
  if (reply === "1") return true;
  if (reply === null) return false;
  throw new UnknownReplyError("the mark that the stores' queued indexes were filled");
}

/**
 * One run's share of the fill: at most FILL_RUN_COMMANDS commands, none sent after the deadline. "done" once the mark
 * is set; "more" when the run stopped first. Its position is kept after each step, so a run cut short goes on from
 * where it stopped, never skips a member.
 */
export async function fillQueuedIndexes(deadline: number): Promise<"done" | "more"> {
  let left = FILL_RUN_COMMANDS;
  const send = async (commands: (string | number)[][]) => {
    left -= commands.length;
    return repliesFor(await redisPipeline(commands), commands.length);
  };
  // Once done, one GET a run and nothing else: the fill's recurring cost (Claude 1 E's NIT on #5135).
  const done = await send([["GET", FILL_DONE_KEY]]);
  if (!done) throw new UnknownReplyError("the fill of the stores' queued indexes");
  if (filledFrom(done[0])) return "done";
  const kept = await send([["GET", FILL_CURSOR_KEY]]);
  if (!kept) throw new UnknownReplyError("where the fill of the stores' queued indexes goes on");
  const at = typeof kept[0] === "string" ? FILL_AT.exec(kept[0]) : null;
  if (kept[0] !== null && !at) throw new UnknownReplyError("where the fill of the stores' queued indexes goes on");
  let cursor = at?.[1] ?? "0";
  let after = at?.[2] ?? "";
  // Each step: one ZSCAN, the notes that fit, and one write of where it goes on (or of the mark).
  let first = true;
  while (left >= 4 && Date.now() < deadline) {
    const page = (await send([["ZSCAN", QUEUE_KEY, cursor, "COUNT", QUEUED_PAGE]]))?.[0];
    const pair = Array.isArray(page) && page.length === 2 ? (page as unknown[]) : null;
    const next = typeof pair?.[0] === "number" ? String(pair[0]) : pair?.[0];
    const flat = pair ? stringList(pair[1]) : null;
    if (typeof next !== "string" || !/^\d+$/.test(next) || !flat) throw new UnknownReplyError("a page of the shared email platform queue");
    // ZSCAN answers member, score, member, score...: the members, in order, past the last one already noted.
    const members = flat.filter((_, i) => i % 2 === 0).filter((m) => m > after).sort();
    // Room is kept for the step's last write: the position (1) or the mark with the position's DEL (2).
    const fit = Math.min(members.length, Math.max(0, Math.floor((left - 2) / 2)));
    // A page that does not fit in what this run has left, but would in a whole run, is read again whole on the next run
    // from its cursor alone, never from after a member: the same cursor may answer more members once the queue's dict
    // has shrunk, and the SCAN protocol returns those only on that read (Claude 1 E's LEVE on #5135). The SADD is
    // idempotent, so a page noted twice costs only its commands. Only a page larger than a whole run goes on after its
    // last member noted, so the fill always ends.
    if (fit < members.length && !first) {
      await send([["SET", FILL_CURSOR_KEY, cursor]]);
      return "more";
    }
    first = false;
    const notes: (string | number)[][] = [];
    for (const member of members.slice(0, fit)) {
      const [statsId, id] = member.split("|");
      if (!statsId || !JOB_ID.test(id ?? "")) continue;
      notes.push(["SADD", queuedKey(statsId), id!], ["EXPIRE", queuedKey(statsId), JOB_SECONDS]);
    }
    if (notes.length && !(await send(notes))) throw new UnknownReplyError("noting waiting jobs in their stores' indexes");
    if (fit < members.length) {
      // The page goes on after its last member noted, from the same cursor.
      after = members[fit - 1] ?? after;
      await send([["SET", FILL_CURSOR_KEY, after ? `${cursor} ${after}` : cursor]]);
      return "more";
    }
    cursor = next;
    after = "";
    if (cursor === "0") {
      // The mark only at the end of the scan, and the kept position goes with it.
      await send([["SET", FILL_DONE_KEY, "1"], ["DEL", FILL_CURSOR_KEY]]);
      return "done";
    }
    await send([["SET", FILL_CURSOR_KEY, cursor]]);
  }
  return "more";
}

/**
 * One page of a store's waiting job ids, from `cursor`: from its own queued index once the indexes are filled
 * (`filled`), else from the shared queue, as before the index, its members of this store only (MATCH where the id is a
 * plain word; filtered here either way). Read exactly: another shape throws.
 */
async function waitingPage(statsId: string, filled: boolean, cursor: string): Promise<{ next: string; ids: string[] }> {
  const match = /^[A-Za-z0-9_-]+$/.test(statsId) ? ["MATCH", `${statsId}|*`] : [];
  const command = filled ? ["SSCAN", queuedKey(statsId), cursor, "COUNT", QUEUED_PAGE] : ["ZSCAN", QUEUE_KEY, cursor, ...match, "COUNT", QUEUED_PAGE];
  const reply = repliesFor(await redisPipeline([command]), 1)?.[0];
  const pair = Array.isArray(reply) && reply.length === 2 ? (reply as unknown[]) : null;
  const next = typeof pair?.[0] === "number" ? String(pair[0]) : pair?.[0];
  const flat = pair ? stringList(pair[1]) : null;
  if (typeof next !== "string" || !/^\d+$/.test(next) || !flat) throw new UnknownReplyError("a store's email platform jobs waiting on the queue");
  if (filled) return { next, ids: flat.filter((id) => JOB_ID.test(id)) };
  // ZSCAN answers member, score, member, score...: this store's members only.
  const ids: string[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const [owner, id] = flat[i]!.split("|");
    if (owner === statsId && JOB_ID.test(id ?? "")) ids.push(id!);
  }
  return { next, ids };
}

/** Minutes to wait before each try after the first. */
export const RETRY_MINUTES = [5, 15, 60, 180, 720, 1440];
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
/** Tags one product may add. */
export const MAX_TAGS_PER_PRODUCT = 3;
/** The longest tag. */
export const MAX_TAG_LENGTH = 50;
/** How long one job may take, all its requests together: at once, and in the five-minute job, which has less time. */
const JOB_MS = 20_000;
const JOB_MS_IN_RUN = 9_000;
/** Jobs tried in one run of the five-minute job, at most. */
const MAX_PER_RUN = 60;
const JOB_SECONDS = 7 * 86400;
const GRACE_MS = 3600_000;
const SEEN_SECONDS = 30 * 86400;

export type Buyers = "none" | "all" | "some";

type Config = {
  handle: string;
  provider: EmailProvider;
  /** Sealed; opened only to make a request. */
  key: string;
  last4: string;
  target: Target | null;
  free: boolean;
  buyers: Buyers;
  products: string[];
  /** Product id -> tag names. */
  tags: Record<string, string[]>;
  /** Nothing that happened before this moment (milliseconds) is sent. */
  since: number;
  connectedAt: number;
};

export type Job = {
  id: string;
  statsId: string;
  /** Empty for a person who was not sent, so their address is not kept. */
  email: string;
  firstName: string | null;
  products: string[];
  title: string;
  source: "free" | "purchase";
  attempts: number;
  state: "queued" | "added" | "retrying" | "failed" | "skipped";
  /** When the next try is due, in milliseconds; 0 once there is none. */
  next: number;
  lastError: string;
  /** What the platform did, in a few words, once it did. */
  note: string;
  lastAt: number;
  createdAt: number;
};

const cfgKey = (statsId: string) => `nl:esync:cfg:${statsId}`;
const tagsKey = (statsId: string) => `nl:esync:tags:${statsId}`;
const badKey = (statsId: string) => `nl:esync:bad:${statsId}`;
const jobKey = (id: string) => `nl:esync:j:${id}`;
const logKey = (statsId: string) => `nl:esync:log:${statsId}`;
/**
 * The store's own index of its jobs put on the queue, so a person's copy and erasure and the deleted store's forgetting
 * find every waiting job of the store by reading this store's keys, never the queue every store shares (#5125,
 * email-sync row). An id is added in the same request that puts the job on the queue and removed where the job leaves
 * it for good (retire, the erasures); one left behind by a cut-off run names a record that is gone or still alive, and
 * either is read exactly. Kept as long as a job's record.
 */
const queuedKey = (statsId: string) => `nl:esync:qd:${statsId}`;
export const QUEUE_KEY = "nl:esync:q";
const seenKey = (statsId: string, seed: string) =>
  `nl:esync:seen:${createHash("sha256").update(`${statsId}|${seed}`).digest("hex").slice(0, 40)}`;

/**
 * The tries of one person's jobs in flight at the platform (#4266, review of #4392): a set of job ids, one member a
 * try, added by FLY_IF_READ atomically with the check that the job still holds what was read, right before the
 * platform is asked; each try takes out only its own member when its request is over (two jobs of one person, one a
 * checkout, can be in flight at once), and the set is gone by itself a lease after its last try at the most. Named
 * by the store and the address, hashed: the person's erasure (forgetSyncPerson) finds it whether or not a job is
 * left, and says "not finished" while it holds any member.
 */
const flyKey = (statsId: string, email: string) =>
  `nl:esync:fly:${createHash("sha256").update(`${statsId}|${normaliseEmail(email)}`).digest("hex").slice(0, 40)}`;

const JOB_ID = /^esj_[0-9a-f]{24}$/;
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** What a sealed key is bound to: this store and this platform, nothing else. */
const context = (statsId: string, provider: EmailProvider) => `email-sync|${statsId}|${provider}`;

function parseConfig(raw: unknown): Config | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Config>;
    if (!isProvider(value.provider) || typeof value.key !== "string") return null;
    const target =
      value.target && typeof value.target.id === "string" && typeof value.target.name === "string" ? { id: value.target.id, name: value.target.name } : null;
    return {
      handle: typeof value.handle === "string" ? value.handle : "",
      provider: value.provider,
      key: value.key,
      last4: typeof value.last4 === "string" ? value.last4.slice(-4) : "",
      target,
      free: value.free !== false,
      buyers: value.buyers === "none" || value.buyers === "some" ? value.buyers : "all",
      products: Array.isArray(value.products) ? value.products.filter((id): id is string => typeof id === "string" && PRODUCT_ID.test(id)) : [],
      tags: cleanTagMap(value.tags),
      since: typeof value.since === "number" ? value.since : 0,
      connectedAt: typeof value.connectedAt === "number" ? value.connectedAt : 0,
    };
  } catch {
    return null;
  }
}

function parseJob(raw: unknown): Job | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Job;
    return typeof value.id === "string" && typeof value.state === "string" ? value : null;
  } catch {
    return null;
  }
}

/** A Redis list or pipeline envelope is evidence only when every position is
 * an own data property. Sparse or inherited cells are an unknown read, not an
 * empty connection or a shorter activity log. */
function exactOwnArray(value: unknown, length?: number): unknown[] | null {
  if (!Array.isArray(value)) return null;
  const size = Object.getOwnPropertyDescriptor(value, "length");
  if (!size || !Object.hasOwn(size, "value") || (length !== undefined && size.value !== length)) return null;
  const out: unknown[] = [];
  for (let index = 0; index < size.value; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item || !Object.hasOwn(item, "value")) return null;
    out.push(item.value);
  }
  return out;
}

/**
 * The store's email platform settings, read exactly (CX-123 rule 24): null only when none are kept. A reply in
 * another shape, or kept settings that do not read, throws UnknownReplyError: never "disconnected", which would fail
 * a consented buyer's job for good (Claude 2 (nuvem D) bug hunt).
 */
async function readConfig(statsId: string): Promise<Config | null> {
  const replies = repliesFor(await redisPipeline([["GET", cfgKey(statsId)]]), 1);
  if (!replies) throw new UnknownReplyError("a store's email platform settings");
  const [raw] = replies;
  if (raw === null) return null;
  const config = typeof raw === "string" ? parseConfig(raw) : null;
  if (!config) throw new UnknownReplyError("a store's email platform settings");
  return config;
}

/** A tag as it is kept and sent: one line, no commas, at most MAX_TAG_LENGTH characters. */
export function cleanTag(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TAG_LENGTH)
    .trim();
}

export function cleanTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const tag = cleanTag(item);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
    if (tags.length >= MAX_TAGS_PER_PRODUCT) break;
  }
  return tags;
}

function cleanTagMap(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [id, tags] of Object.entries(raw as Record<string, unknown>).slice(0, 400)) {
    if (!PRODUCT_ID.test(id)) continue;
    const clean = cleanTags(tags);
    if (clean.length) out[id] = clean;
  }
  return out;
}

/** The part of the settings the store record carries (lib/store.ts, Store.emailSync). */
function refFor(config: Config | null): EmailSyncRef | null {
  if (!config || !config.target || config.buyers === "none") return null;
  return { buyers: config.buyers, products: config.buyers === "some" ? config.products : [] };
}

async function writeConfig(store: Store, config: Config | null): Promise<void> {
  const statsId = store.statsId as string;
  if (config) await redisPipeline([["SET", cfgKey(statsId), JSON.stringify({ ...config, handle: store.handle })]]);
  else await redisPipeline([["DEL", cfgKey(statsId), tagsKey(statsId), badKey(statsId)]]);
  // By the key the store is kept under: an account's other stores are not kept under the address.
  await setEmailSyncRef(storeRef(store), refFor(config));
}

/** `legacy`: opened with the key from before NIMBUS_DATA_KEY (lib/secret-box.ts); sealed again on the next save. */
type OpenKey = { ok: true; key: string; legacy: boolean } | { ok: false; message: string };

function openKey(statsId: string, config: Config): OpenKey {
  const opened = unseal(config.key, context(statsId, config.provider));
  if (opened.ok) return { ok: true, key: opened.value, legacy: opened.legacy };
  return {
    ok: false,
    message:
      opened.reason === "other-key"
        ? `Paste your ${PROVIDER_NAMES[config.provider]} API key again: it was kept under a server key that has since changed.`
        : `Paste your ${PROVIDER_NAMES[config.provider]} API key again: the saved one could not be read.`,
  };
}

function tagCache(statsId: string, provider: EmailProvider): TagCache {
  const field = (name: string) => `${provider}|${name.toLowerCase()}`;
  return {
    get: async (name) => {
      const [id] = await redisPipeline([["HGET", tagsKey(statsId), field(name)]]);
      return typeof id === "string" && id ? id : null;
    },
    set: async (name, id) => {
      await redisPipeline([["HSET", tagsKey(statsId), field(name), id]]);
    },
  };
}

// ---- Noticing people -----------------------------------------------------------

/** Runs after the answer is sent when there is a request to wait for; otherwise now. */
function soon(task: () => Promise<unknown>): Promise<void> {
  try {
    after(() => task().catch((error) => console.error("an email platform send failed", error)));
    return Promise.resolve();
  } catch {
    return task().then(
      () => undefined,
      (error) => console.error("an email platform send failed", error),
    );
  }
}

export type Person = {
  source: "free" | "purchase";
  email: string | null;
  name?: string | null;
  /** The products it is about: the one asked for or bought, and one added at checkout. */
  products: { id: string; title: string }[];
  /** Whether they agreed to hear from the creator (see the top of this file). */
  consent: boolean;
  /** What it is about, the same every time it is noticed: a checkout, a confirmed request. */
  seed: string;
  /** When it happened, in milliseconds. */
  at: number;
};

/** The first name from a full name, when there is one that looks like a name. */
function firstName(name: string | null | undefined): string | null {
  const first = (name ?? "").replace(/[\u0000-\u001f\u007f<>"]/g, "").trim().split(/\s+/)[0] ?? "";
  return first ? first.slice(0, 50) : null;
}

/**
 * Hands one person to the creator's platform, when the creator's settings
 * take them and they agreed. Returns what happened: "off" (not connected, or
 * not wanted), "seen" (sent already), "skipped" (did not agree: logged,
 * never sent) or "queued". Throws UnknownReplyError, with nothing written,
 * when whether it was sent already cannot be read.
 */
export async function queuePerson(store: Store, person: Person, now = Date.now()): Promise<"off" | "seen" | "skipped" | "queued"> {
  if (!store.statsId || !isRedisConfigured()) return "off";
  const statsId = store.statsId;
  const config = await readConfig(statsId);
  if (!config || !config.target) return "off";
  const wanted =
    person.source === "free"
      ? config.free
      : config.buyers === "all" || (config.buyers === "some" && person.products.some((p) => config.products.includes(p.id)));
  // Nothing from before the platform was connected; a checkout is dated when
  // it was opened, so one still open then and paid after has an hour's grace.
  if (!wanted || person.at < config.since - GRACE_MS) return "off";
  const email = (person.email ?? "").trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "off";
  // Read exactly (CX-123 rule 24): only a mark that is ours writes a job. One held by another run is a person already
  // handed over; one that cannot be read writes nothing and is said as not done, so a person is never handed over twice.
  const seen = seenKey(statsId, `${person.source}|${person.seed}`);
  const mine = claimValue();
  const fresh = await claimMark(seen, SEEN_SECONDS, mine);
  if (fresh === "taken") return "seen";
  if (fresh === "unknown") {
    // A mark this run may have written is let go only while it holds this run's value, so the person is handed
    // over on the next try (Claude 3 on #2723); another's is never touched.
    await releaseMark(seen, mine);
    throw new UnknownReplyError("the mark of a person handed to an email platform");
  }

  const agreed = person.consent;
  const job: Job = {
    id: `esj_${randomBytes(12).toString("hex")}`,
    statsId,
    email: agreed ? email : "",
    firstName: agreed ? firstName(person.name) : null,
    products: person.products.map((p) => p.id).filter((id) => PRODUCT_ID.test(id)).slice(0, 2),
    title: person.products.map((p) => p.title).join(" + ").slice(0, 200),
    source: person.source,
    attempts: 0,
    state: agreed ? "queued" : "skipped",
    next: agreed ? now : 0,
    lastError: "",
    note: agreed ? "" : person.source === "free" ? "Did not check the box to hear from you, so not sent." : "Did not agree to emails at checkout, so not sent.",
    lastAt: agreed ? 0 : now,
    createdAt: now,
  };
  const written: (string | number)[][] = [
    ["SET", jobKey(job.id), JSON.stringify(job), "EX", JOB_SECONDS],
    // Noted in the store's own index in the same request that queues it (#5125), so it is found without the shared queue.
    ...(agreed ? [["SADD", queuedKey(statsId), job.id], ["EXPIRE", queuedKey(statsId), JOB_SECONDS], ["ZADD", QUEUE_KEY, now, `${statsId}|${job.id}`]] : []),
    ["LPUSH", logKey(statsId), job.id],
    // What this push moved past the studio's LOG_SIZE, read rather than trimmed blind (dropOverflow).
    ["LRANGE", logKey(statsId), LOG_SIZE, -1],
  ];
  const overflow = stringList(repliesFor(await redisPipeline(written), written.length)?.[written.length - 1]);
  // An overflow that does not read is left in the log, where the copy and the erasure still find it; the next push reads it again.
  if (overflow?.length) await dropOverflow(statsId, overflow);
  if (!agreed) return "skipped";
  await soon(async () => {
    if (await claim(statsId, job.id)) await runClaimed(statsId, job.id, JOB_MS);
  });
  return "queued";
}

// ---- Sending ------------------------------------------------------------------------

/**
 * One try of one job, read as `raw`. Returns the job as it stands after it, or null when its record no longer holds
 * what was read (the person's erasure deleted it, #4266): then nothing is tried and nothing is to be written. The
 * record is read again with the settings, right before the platform is asked, so a job erased since it was read is
 * never sent; an erasure landing during the platform's answer is caught where the outcome is written (WRITE_IF_READ).
 */
async function attempt(job: Job, raw: string, now: number, budget: number): Promise<Job | null> {
  const next: Job = { ...job, attempts: job.attempts + 1, lastAt: now };
  const read = repliesFor(await redisPipeline([["GET", cfgKey(job.statsId)], ["GET", jobKey(job.id)]]), 2);
  if (!read) throw new UnknownReplyError("an email platform job and its settings");
  if (read[1] !== raw) return null;
  const config = parseConfig(read[0]);
  if (!config || !config.target) {
    return { ...next, state: "failed", next: 0, lastError: "The email platform was disconnected before this could be sent." };
  }
  const retryIn = RETRY_MINUTES[next.attempts - 1];
  const again = (message: string): Job =>
    retryIn === undefined ? { ...next, state: "failed", next: 0, lastError: message } : { ...next, state: "retrying", next: now + retryIn * 60_000, lastError: message };
  const opened = openKey(job.statsId, config);
  if (!opened.ok) {
    await redisPipeline([["SET", badKey(job.statsId), JSON.stringify({ message: opened.message, at: now }), "EX", 30 * 86400]]);
    return again(opened.message);
  }
  const tags = cleanTags(job.products.flatMap((id) => config.tags[id] ?? [])).slice(0, MAX_TAGS_PER_PRODUCT * 2);
  // The try is marked in flight only while the job still holds what was read (#4266, review of #4392): an erasure
  // that deleted it since the read above refuses the mark, and the platform is never asked; one landing after the
  // mark, during the request, says "not finished" until the request is over (forgetSyncPerson).
  const fly = flyKey(job.statsId, job.email);
  const marked = repliesFor(await redisPipeline([["EVAL", FLY_IF_READ, 2, jobKey(job.id), fly, raw, LEASE_MS, job.id]]), 1);
  const mark = marked ? countOf(marked[0]) : null;
  if (mark === null) throw new UnknownReplyError("marking an email platform try in flight");
  if (mark !== 1) return null;
  try {
    const note = await addContact(
      config.provider,
      opened.key,
      config.target.id,
      {
        email: job.email,
        firstName: job.firstName,
        tags,
        source: job.source,
        storeUrl: `${SITE_URL}/@${config.handle}`,
      },
      tagCache(job.statsId, config.provider),
      now + budget,
    );
    await redisPipeline([["DEL", badKey(job.statsId)]]);
    return { ...next, state: "added", next: 0, lastError: "", note };
  } catch (error) {
    const problem = error instanceof PlatformError ? error : new PlatformError("server", 0, `${PROVIDER_NAMES[config.provider]} could not be reached.`);
    if (problem.kind === "key" || problem.kind === "target") {
      await redisPipeline([["SET", badKey(job.statsId), JSON.stringify({ message: problem.message, at: now }), "EX", 30 * 86400]]);
    }
    if (!problem.retry) return { ...next, state: "failed", next: 0, lastError: problem.message };
    return again(problem.message);
  } finally {
    // This try's request is over: only its own member leaves (another try of the same person may still be in flight).
    // If this does not answer, the member ends with the set's lease.
    await redisPipeline([["SREM", fly, job.id]]).catch(() => undefined);
  }
}

/**
 * Marks a try in flight (#4266): KEYS[1] the job, KEYS[2] the person's in-flight set; ARGV[1] the record as read,
 * ARGV[2] the set's milliseconds, ARGV[3] the job id. Answers 1 when marked, 0 when the record is gone or holds
 * something else; then nothing is set.
 * lib/redis-memory.ts runs it the same way.
 */
export const FLY_IF_READ = `-- marktmorgen:esync-fly-if-read:v2
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("SADD", KEYS[2], ARGV[3])
redis.call("PEXPIRE", KEYS[2], ARGV[2])
return 1`;

/** Tries a job this caller has claimed, writes down how it went, and queues its next try. */
async function runClaimed(statsId: string, id: string, budget: number, now = Date.now()): Promise<Job | null> {
  // Read exactly (CX-123 rule 24): only a record that is gone (it expired) is no job. A reply in another shape or a
  // record that does not read is unknown, and the job stays on the queue under its lease, to come back when it ends,
  // rather than being taken off it untried (Claude 5 sweep A2).
  const replies = repliesFor(await redisPipeline([["GET", jobKey(id)]]), 1);
  if (!replies) throw new UnknownReplyError("a queued email platform job");
  const [raw] = replies;
  const job = raw === null ? null : parseJob(raw);
  if (raw !== null && !job) throw new UnknownReplyError("a queued email platform job");
  if (!job || job.state === "added" || job.state === "failed" || job.state === "skipped") {
    await retire(statsId, id, now);
    return job;
  }
  // A job parses only from text (parseJob), so here the record as read is that text.
  const read = String(raw);
  const done = await attempt(job, read, now, budget);
  // Erased (or rewritten by another holder) since it was read: nothing is written back and nothing queued (#4266).
  if (!done) return unlessRewritten(statsId, id, now);
  const member = `${statsId}|${id}`;
  // Written only over the record as it was read (#4266): a job the person's erasure deleted during the try is not
  // written back with their address, nor queued for another try. A reply in another shape throws; the job stays on
  // the queue under its lease and comes back, read afresh, when it ends.
  const written = repliesFor(
    await redisPipeline([["EVAL", WRITE_IF_READ, 2, jobKey(id), QUEUE_KEY, read, JSON.stringify(done), JOB_SECONDS, done.state === "retrying" ? done.next : "", member]]),
    1,
  );
  const outcome = written ? countOf(written[0]) : null;
  if (outcome === null && written?.[0] !== -1) throw new UnknownReplyError("writing how an email platform job went");
  if (outcome !== 1) return unlessRewritten(statsId, id, now);
  if (done.state !== "retrying") await retire(statsId, id, now);
  return done;
}

/**
 * A claimed job whose record no longer holds what was read. Gone (the person's erasure, or its week ended): taken off
 * the queue as a finished one is (retire), with nothing written. Rewritten instead: left to whoever wrote it.
 */
async function unlessRewritten(statsId: string, id: string, now: number): Promise<null> {
  const replies = repliesFor(await redisPipeline([["EXISTS", jobKey(id)]]), 1);
  const exists = replies ? countOf(replies[0]) : null;
  if (exists === null) throw new UnknownReplyError("the record of an email platform job");
  if (exists === 0) await retire(statsId, id, now);
  return null;
}

/**
 * How a try went, written only over the job's record as it was read (#4266): KEYS[1] the job, KEYS[2] the queue;
 * ARGV[1] the record as read, ARGV[2] the new record, ARGV[3] its seconds, ARGV[4] when the next try is due (empty
 * when there is none), ARGV[5] the queue member. Answers 1 when written (and queued), 0 when the record is gone, -1
 * when it holds something else; then nothing is written. lib/redis-memory.ts runs it the same way.
 */
export const WRITE_IF_READ = `-- marktmorgen:esync-write-if-read:v1
local held = redis.call("GET", KEYS[1])
if not held then return 0 end
if held ~= ARGV[1] then return -1 end
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
if ARGV[4] ~= "" then redis.call("ZADD", KEYS[2], ARGV[4], ARGV[5]) end
return 1`;

/**
 * Every job record, which holds a buyer's address for a week, stays where a
 * person's copy and erasure find it (Codex Q on #2860): in the store's log, or
 * on the queue while it waits. The log keeps the studio's newest LOG_SIZE, so
 * a job pushed past them leaves it here, and its record goes with it unless it
 * is still waiting. No job leaves the log before the reply that settles its
 * record has come back (Claude 4 on #2860): a reply lost after Redis ran the
 * commands (a timeout, a dropped connection) leaves it in the log, never in
 * neither place. So where each job is on the queue is read first, with nothing
 * moved. A finished job's record is deleted, and only once that deletion has
 * answered a count is the job let go of from the log. A waiting job is let go
 * of from the log and the queue read again after, so one finishing meanwhile
 * is either still in the log when retire reads it or already off the queue
 * when this reads it; one found off the queue then, or whose second read does
 * not come back or does not read, is put back at the end of the log and, once
 * off the queue, deleted as a finished one. A reply that does not read leaves
 * the job in the log, where it is still found and the next push reads it again.
 */
async function dropOverflow(statsId: string, ids: string[]): Promise<void> {
  const log = logKey(statsId);
  const where = repliesFor(await redisPipeline(ids.map((id) => ["ZSCORE", QUEUE_KEY, `${statsId}|${id}`])), ids.length);
  if (!where) return;
  const finished = ids.filter((_, i) => where[i] === null);
  const waiting = ids.filter((_, i) => isScore(where[i]));
  if (waiting.length) {
    let again: unknown[] | null;
    try {
      again = repliesFor(await redisPipeline(waiting.flatMap((id) => [["LREM", log, 0, id], ["ZSCORE", QUEUE_KEY, `${statsId}|${id}`]])), waiting.length * 2);
    } catch (error) {
      await putBack(log, waiting);
      throw error;
    }
    const back = waiting.filter((_, i) => !isScore(again?.[i * 2 + 1]));
    if (back.length) await putBack(log, back);
    finished.push(...waiting.filter((_, i) => again?.[i * 2 + 1] === null));
  }
  await forgetFinished(log, finished);
}

/** A score on the queue, read exactly: a finite number, sent as a number or as its string. */
function isScore(reply: unknown): boolean {
  return (typeof reply === "string" || typeof reply === "number") && reply !== "" && Number.isFinite(Number(reply));
}

/** Puts jobs back at the end of a store's log, throwing when the push does not answer the log's length. */
async function putBack(log: string, ids: string[]): Promise<void> {
  const push: (string | number)[][] = [["RPUSH", log, ...ids]];
  if (!countsFor(await redisPipeline(push), push)) throw new UnknownReplyError("a store's email platform job log, putting a job back");
}

/**
 * Deletes the records of finished jobs that are in a store's log, and lets
 * them go from the log only once each deletion answered a count; one whose
 * deletion does not answer stays in the log, where it is still found.
 */
async function forgetFinished(log: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const deleted = repliesFor(await redisPipeline(ids.map((id) => ["DEL", jobKey(id)])), ids.length);
  // Each DEL names one key, so only 0 or 1 confirms it; any other count leaves the id in the log for a later cleanup
  // (Codex G, G-20261119-0446).
  const gone = ids.filter((_, i) => {
    const count = countOf(deleted?.[i]);
    return count === 0 || count === 1;
  });
  if (gone.length) await redisPipeline(gone.map((id) => ["LREM", log, 0, id]));
}

/**
 * Takes a job that is done off the queue, once how it went is written (or its
 * record is gone), and deletes its record when it is no longer in the store's log, so no
 * record holding an address is left where neither the log nor the queue finds
 * it (dropOverflow). The job leaves the queue only once its record is known to
 * be in the log or gone (Claude 4 on #2860): the log is read first, with the
 * job still on the queue under its lease. One out of the log has its record
 * deleted first and leaves the queue after. One in the log leaves the queue
 * and the log is read again after, so a push moving it out of the log
 * meanwhile is seen here or sees it still waiting. A reply that does not come
 * back or does not read, once the job may be off the queue, puts it back on
 * the queue, to be retired again when its lease would have ended, and throws
 * (CX-123 rule 24); before that, the job is still there.
 */
async function retire(statsId: string, id: string, now: number): Promise<void> {
  const member = `${statsId}|${id}`;
  const log = logKey(statsId);
  const logged = stringList(repliesFor(await redisPipeline([["LRANGE", log, 0, -1]]), 1)?.[0]);
  if (!logged) throw new UnknownReplyError("a store's email platform job log, retiring a job");
  if (!logged.includes(id)) {
    const drop: (string | number)[][] = [["DEL", jobKey(id)]];
    if (!countsFor(await redisPipeline(drop), drop)) throw new UnknownReplyError("the record of an email platform job, retiring it");
    // Off the queue, and out of the store's own index with it (#5125): its record is already gone.
    await redisPipeline([["ZREM", QUEUE_KEY, member], ["SREM", queuedKey(statsId), id]]);
    return;
  }
  try {
    // Off the queue for good, and out of the store's own index in the same request (#5125).
    const again = repliesFor(await redisPipeline([["ZREM", QUEUE_KEY, member], ["SREM", queuedKey(statsId), id], ["LRANGE", log, 0, -1]]), 3);
    const still = stringList(again?.[2]);
    if (still?.includes(id)) return;
    const drop: (string | number)[][] = [["DEL", jobKey(id)]];
    if (still && countsFor(await redisPipeline(drop), drop)) return;
  } catch (error) {
    await redisPipeline([["SADD", queuedKey(statsId), id], ["ZADD", QUEUE_KEY, now + LEASE_MS, member]]);
    throw error;
  }
  await redisPipeline([["SADD", queuedKey(statsId), id], ["ZADD", QUEUE_KEY, now + LEASE_MS, member]]);
  throw new UnknownReplyError("a store's email platform job log, retiring a job");
}

/**
 * Takes an item that is due on the queue for a while (a lease) rather than
 * off it: a run that dies half way, a function cut off by its time limit,
 * leaves it to come back when the lease ends instead of losing it. Only one
 * caller at a time gets it.
 */
const LEASE_SCRIPT = [
  'local due = redis.call("ZSCORE", KEYS[1], ARGV[1])',
  "if not due or tonumber(due) > tonumber(ARGV[2]) then return 0 end",
  'redis.call("ZADD", KEYS[1], ARGV[3], ARGV[1])',
  "return 1",
].join("\n");
const LEASE_MS = 10 * 60 * 1000;

/** Takes a job that is due, for the length of a lease. Only the caller that took it tries it. */
async function claim(statsId: string, id: string, now = Date.now()): Promise<boolean> {
  const [taken] = await redisPipeline([["EVAL", LEASE_SCRIPT, 1, QUEUE_KEY, `${statsId}|${id}`, now, now + LEASE_MS]]);
  return Number(taken) === 1;
}

/**
 * Tries every job that is due, for the five-minute job: at most MAX_PER_RUN,
 * five at a time, none started after the deadline.
 */
export async function syncDue(deadline: number, now = Date.now()): Promise<{ tried: number; added: number }> {
  const counts = { tried: 0, added: 0 };
  if (!isRedisConfigured()) return counts;
  // The one-time fill of the stores' queued indexes, a run's share at a time; a failure is logged and tried again on
  // the next run, never stops the sending.
  await fillQueuedIndexes(deadline).catch((error) => console.error("filling the stores' email platform queued indexes failed", error));
  const [due] = await redisPipeline([["ZRANGEBYSCORE", QUEUE_KEY, "-inf", now, "LIMIT", 0, MAX_PER_RUN]]);
  const members = Array.isArray(due) ? (due as unknown[]).map(String) : [];
  for (let i = 0; i < members.length && Date.now() < deadline; i += 5) {
    await Promise.all(
      members.slice(i, i + 5).map(async (member) => {
        const [statsId, id] = member.split("|");
        if (!statsId || !JOB_ID.test(id ?? "")) {
          await redisPipeline([["ZREM", QUEUE_KEY, member]]);
          return;
        }
        if (!(await claim(statsId, id, now))) return;
        counts.tried += 1;
        const done = await runClaimed(statsId, id, JOB_MS_IN_RUN).catch((error) => {
          console.error("an email platform retry failed", error);
          return null;
        });
        if (done?.state === "added") counts.added += 1;
      }),
    );
  }
  return counts;
}

// ---- The studio -------------------------------------------------------------------

export type JobView = Pick<Job, "id" | "email" | "title" | "source" | "state" | "attempts" | "next" | "lastError" | "note" | "lastAt" | "createdAt">;

export type SyncView = {
  /** Whether keys can be kept sealed here; without it nothing can be connected. */
  available: boolean;
  connected: {
    provider: EmailProvider;
    last4: string;
    target: Target | null;
    free: boolean;
    buyers: Buyers;
    products: string[];
    tags: Record<string, string[]>;
    connectedAt: number;
    /** The last problem with the key or the audience, until a send works again. */
    problem: { message: string; at: number } | null;
  } | null;
  /** Null means recent-send history could not be read exactly. */
  log: JobView[] | null;
};

function connectedView(config: Config | null, problem: NonNullable<SyncView["connected"]>["problem"]): SyncView["connected"] {
  return config ? {
    provider: config.provider,
    last4: config.last4,
    target: config.target,
    free: config.free,
    buyers: config.buyers,
    products: config.products,
    tags: config.tags,
    connectedAt: config.connectedAt,
    problem,
  } : null;
}

export async function syncView(store: Store): Promise<SyncView> {
  const available = canSeal() && isRedisConfigured();
  if (!store.statsId || !isRedisConfigured()) return { available, connected: null, log: [] };
  const statsId = store.statsId;
  const view = exactOwnArray(await redisPipeline([
    ["GET", cfgKey(statsId)],
    ["GET", badKey(statsId)],
    ["LRANGE", logKey(statsId), 0, LOG_SIZE - 1],
  ]), 3);
  if (!view) throw new Error("The email platform view is unavailable");
  const [rawConfig, rawBad, rawLog] = view;
  if (rawConfig !== null && typeof rawConfig !== "string") throw new Error("The email platform configuration is unavailable");
  if (rawBad !== null && typeof rawBad !== "string") throw new Error("The email platform status is unavailable");
  const config = parseConfig(rawConfig);
  const log = exactOwnArray(rawLog);
  let parsedJobs: Job[] | null = null;
  if (log && log.every((id) => typeof id === "string" && JOB_ID.test(id))) {
    const ids = log as string[];
    const jobs = ids.length ? exactOwnArray(await redisPipeline(ids.map((id) => ["GET", jobKey(id)])), ids.length) : [];
    if (jobs) {
      const parsed: Job[] = [];
      let unread = false;
      for (const raw of jobs) {
        // Job records expire after seven days while their ids may remain in
        // the bounded log. A missing GET is therefore known absence, not a
        // broken batch; every present value must still be complete.
        if (raw === null) continue;
        const job = parseJob(raw);
        if (!job) {
          unread = true;
          break;
        }
        parsed.push(job);
      }
      if (!unread) parsedJobs = parsed;
    }
  }
  let problem: { message: string; at: number } | null = null;
  try {
    const value = typeof rawBad === "string" ? (JSON.parse(rawBad) as { message?: unknown; at?: unknown }) : null;
    if (value && typeof value.message === "string") problem = { message: value.message, at: Number(value.at) || 0 };
  } catch {
    problem = null;
  }
  // A key sealed under a server key that has changed is a problem to show now, not at the next sale.
  if (config && !problem) {
    const opened = openKey(statsId, config);
    if (!opened.ok) problem = { message: opened.message, at: 0 };
  }
  return {
    available,
    connected: connectedView(config, problem),
    log: parsedJobs?.map((job) => ({
        id: job.id,
        email: job.email,
        title: job.title,
        source: job.source,
        state: job.state,
        attempts: job.attempts,
        next: job.next,
        lastError: job.lastError,
        note: job.note,
        lastAt: job.lastAt,
        createdAt: job.createdAt,
      })) ?? null,
  };
}

/** A display reread must not reverse a completed action or suppress its
 * security notice. Use the configuration already saved by that action;
 * history and any status not confirmed by the action remain unknown. */
async function viewAfterWrite(
  store: Store,
  config: Config | null,
  problem: NonNullable<SyncView["connected"]>["problem"] = {
    message: "We could not read the connection status just now. Try again in a moment.", at: 0,
  },
): Promise<SyncView> {
  try {
    return await syncView(store);
  } catch {
    return { available: canSeal() && isRedisConfigured(), connected: connectedView(config, problem), log: null };
  }
}

export type ConnectResult = { ok: true; view: SyncView; targets: Target[] } | { ok: false; message: string };

function words(error: unknown, provider: EmailProvider): string {
  return error instanceof PlatformError ? error.message : `${PROVIDER_NAMES[provider]} could not be reached. Try again in a moment.`;
}

/**
 * Connects a platform with a key: checked with the platform first, then
 * sealed and kept. Replacing the key of the same platform keeps every
 * setting; another platform keeps who is sent and the tags, and asks for its
 * own audience again. Returns the audiences to pick from.
 */
export async function connect(store: Store, rawProvider: unknown, rawKey: unknown, now = Date.now()): Promise<ConnectResult> {
  if (!store.statsId) return { ok: false, message: "Open the studio once more and try again." };
  if (!isProvider(rawProvider)) return { ok: false, message: "Choose a platform." };
  const provider = rawProvider;
  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  const problem = keyProblem(provider, key);
  if (problem) return { ok: false, message: problem };
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return { ok: false, message: "The platform could not be contacted just now. Try again in a moment." };
  if (!canSeal()) return { ok: false, message: "Keys cannot be stored safely on this deployment, so nothing was saved." };
  let targets: Target[];
  try {
    await ping(provider, key);
    targets = await listTargets(provider, key);
  } catch (error) {
    return { ok: false, message: words(error, provider) };
  }
  const existing = await readConfig(store.statsId);
  const same = existing?.provider === provider;
  const kept = same ? targets.find((t) => t.id === existing?.target?.id) ?? null : null;
  const config: Config = {
    handle: store.handle,
    provider,
    key: seal(key, context(store.statsId, provider)),
    // A Mailchimp key ends in its data centre ("-us21"), which says nothing
    // about which key it is: the four shown are the last of the secret part.
    last4: (provider === "mailchimp" ? key.split("-")[0] : key).slice(-4),
    // The one there is, when there is only one to pick.
    target: kept ?? (targets.length === 1 ? targets[0] : null),
    free: existing?.free ?? true,
    buyers: existing?.buyers ?? "all",
    products: existing?.products ?? [],
    tags: existing?.tags ?? {},
    since: same && existing ? existing.since : now,
    connectedAt: now,
  };
  await redisPipeline([["DEL", tagsKey(store.statsId), badKey(store.statsId)]]);
  await writeConfig(store, config);
  return { ok: true, view: await viewAfterWrite(store, config, null), targets };
}

/** The audiences the saved key reaches, read again. */
export async function refreshTargets(store: Store): Promise<{ ok: true; targets: Target[] } | { ok: false; message: string }> {
  const config = store.statsId ? await readConfig(store.statsId) : null;
  if (!store.statsId || !config) return { ok: false, message: "Connect a platform first." };
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return { ok: false, message: "The platform could not be contacted just now. Try again in a moment." };
  const opened = openKey(store.statsId, config);
  if (!opened.ok) return { ok: false, message: opened.message };
  try {
    return { ok: true, targets: await listTargets(config.provider, opened.key) };
  } catch (error) {
    return { ok: false, message: words(error, config.provider) };
  }
}

export type Settings = { target: unknown; free: unknown; buyers: unknown; products: unknown; tags: unknown };

/**
 * Saves who is sent where. The audience is checked against the platform's own
 * list as it is now, so a name shown in the studio is always the one there.
 */
export async function saveSettings(store: Store, input: Settings): Promise<{ ok: true; view: SyncView } | { ok: false; message: string }> {
  const config = store.statsId ? await readConfig(store.statsId) : null;
  if (!store.statsId || !config) return { ok: false, message: "Connect a platform first." };
  const opened = openKey(store.statsId, config);
  if (!opened.ok) return { ok: false, message: opened.message };
  const wantedTarget = typeof input.target === "string" ? input.target : "";
  let target: Target | null = config.target;
  if (wantedTarget && wantedTarget !== config.target?.id) {
    if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return { ok: false, message: "The platform could not be contacted just now. Try again in a moment." };
    let targets: Target[];
    try {
      targets = await listTargets(config.provider, opened.key);
    } catch (error) {
      return { ok: false, message: words(error, config.provider) };
    }
    target = targets.find((t) => t.id === wantedTarget) ?? null;
    if (!target) return { ok: false, message: `That ${TARGET_WORDS[config.provider]} is not in your ${PROVIDER_NAMES[config.provider]} account anymore. Refresh the list.` };
  }
  if (!target) return { ok: false, message: `Choose the ${TARGET_WORDS[config.provider]} to add people to.` };
  const known = new Set(productIds(store));
  const buyers: Buyers = input.buyers === "none" || input.buyers === "some" ? input.buyers : "all";
  const products = Array.isArray(input.products) ? [...new Set(input.products.filter((id): id is string => typeof id === "string" && known.has(id)))] : [];
  if (buyers === "some" && !products.length) return { ok: false, message: "Choose at least one product, or send the buyers of every product." };
  const tags = Object.fromEntries(Object.entries(cleanTagMap(input.tags)).filter(([id]) => known.has(id)));
  const next: Config = {
    ...config,
    // A key still sealed under the key from before NIMBUS_DATA_KEY is sealed again under today's.
    key: opened.legacy ? seal(opened.key, context(store.statsId, config.provider)) : config.key,
    target,
    free: input.free === true,
    buyers,
    products: buyers === "some" ? products : [],
    tags,
  };
  await writeConfig(store, next);
  return { ok: true, view: await viewAfterWrite(store, next) };
}

/** Checks the saved key and the chosen audience with the platform, now. */
export async function testConnection(store: Store): Promise<{ ok: boolean; message: string; view: SyncView }> {
  const config = store.statsId ? await readConfig(store.statsId) : null;
  if (!store.statsId || !config) return { ok: false, message: "Connect a platform first.", view: await syncView(store) };
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return { ok: false, message: "The platform could not be contacted just now. Try again in a moment.", view: await syncView(store) };
  const name = PROVIDER_NAMES[config.provider];
  const opened = openKey(store.statsId, config);
  if (!opened.ok) return { ok: false, message: opened.message, view: await syncView(store) };
  try {
    await ping(config.provider, opened.key);
    const targets = await listTargets(config.provider, opened.key);
    if (!config.target) return { ok: true, message: `${name} accepted the key. Now choose the ${TARGET_WORDS[config.provider]} to add people to.`, view: await viewAfterWrite(store, config) };
    if (!targets.some((t) => t.id === config.target?.id)) {
      const message = `${name} accepted the key, but the ${TARGET_WORDS[config.provider]} “${config.target.name}” is not there anymore. Choose another.`;
      const problem = { message, at: Date.now() };
      await redisPipeline([["SET", badKey(store.statsId), JSON.stringify(problem), "EX", 30 * 86400]]);
      return { ok: false, message, view: await viewAfterWrite(store, config, problem) };
    }
    await redisPipeline([["DEL", badKey(store.statsId)]]);
    return { ok: true, message: `Connected: ${name} accepted the key and “${config.target.name}” is there.`, view: await viewAfterWrite(store, config, null) };
  } catch (error) {
    return { ok: false, message: words(error, config.provider), view: await viewAfterWrite(store, config) };
  }
}

/**
 * Forgets a deleted store's platform, its sealed key with it, without
 * touching the store record (which is already gone), and every job of the
 * store with it: those waiting in the queue are taken off it at once, and
 * the records of its jobs — which hold buyers' addresses — are deleted
 * rather than left to expire.
 */
export async function forgetStoreSync(statsId: string | null, apply: (commands: (string | number)[][]) => Promise<unknown> = redisPipeline): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  // Every reply read exactly (CX-123 rule 24): a log or a queue page in another shape is unknown, never "no job".
  // What was read is still deleted (the sealed key with the settings), the log is kept when it did not read, so
  // the next try finds its jobs, and the forgetting throws rather than being taken as finished (Claude 5 sweep A2).
  const read = repliesFor(await redisPipeline([["LRANGE", logKey(statsId), 0, -1], ["GET", FILL_DONE_KEY]]), 2);
  const logged = stringList(read?.[0]);
  let unread = !logged;
  // Until the indexes are filled, the shared queue is read for this store's jobs, as before them (#5135, DKvY 4534).
  const filled = read ? filledFrom(read[1]) : false;
  if (!read) unread = true;
  const ids = new Set((logged ?? []).filter((id) => JOB_ID.test(id)));
  // The store's waiting jobs are in its own queued index (#5125), never read from the queue every store shares; every
  // job of the store, logged or not, is taken off the queue by its own member.
  const { ids: waiting, whole } = await queuedIdsOf(statsId, filled);
  if (!whole) unread = true;
  for (const id of waiting) ids.add(id);
  const queued = [...ids].map((id) => `${statsId}|${id}`);
  // The records go before the queue lets go of them (Claude 4 on #2860), so a batch cut short never leaves one
  // holding an address off the queue; the log is deleted last. `apply` sends the deletes: the closing walk's makes
  // them only while it still holds the store's lock (lib/closed-store-data.ts, fencedBy).
  const commands: (string | number)[][] = [
    ...[...ids].map((id) => ["DEL", jobKey(id)]),
    ...(queued.length ? [["ZREM", QUEUE_KEY, ...queued]] : []),
    ["DEL", cfgKey(statsId), tagsKey(statsId), badKey(statsId), ...(logged ? [logKey(statsId)] : []), ...(whole ? [queuedKey(statsId)] : [])],
  ];
  const replies = await apply(commands);
  // A plain pipeline's replies are read exactly, one count per command, each within what it names (Claude 6's MEDIUM
  // on #4911). The closing walk's fenced apply answers no counts: it reads its own EVAL reply exactly and throws itself
  // on a lost lock or a reply in another shape.
  if (apply === redisPipeline && !countsFor(replies, commands)) throw new UnknownReplyError("the forgetting of a deleted store's email platform jobs");
  if (unread) throw new UnknownReplyError("a deleted store's email platform jobs");
}

/**
 * Whether a pipeline answered exactly one count for each command, and each count is one Redis can give: a DEL never
 * more than the keys it names, a ZREM never more than its members (Claude 6's MEDIUM on #4911); a count above them is
 * no proof the records holding addresses are gone. Any other command (RPUSH, the list's new length) only needs a count.
 */
function countsFor(replies: unknown, commands: readonly (readonly (string | number)[])[]): boolean {
  const exact = repliesFor(replies, commands.length);
  if (!exact) return false;
  return exact.every((reply, i) => {
    const count = countOf(reply);
    if (count === null) return false;
    const [name] = commands[i];
    if (name === "DEL") return count <= commands[i].length - 1;
    if (name === "ZREM") return count <= commands[i].length - 2;
    return true;
  });
}

/**
 * The store's jobs put on the queue, read from the store's own index (queuedKey), never from the queue every store
 * shares (#5125, email-sync row: a ZSCAN of the global queue cost one
 * store's copy as much as every store's waiting jobs). Read with SSCAN, which returns every member present for the
 * whole read, to the end: the erasures (forgetSyncPerson, forgetStoreSync) never stop at a fixed count, which would
 * leave a store with more jobs waiting never erased (Claude 1 coord, mail 7937; a copy reads in pages, syncJobsPage).
 * Their cost is the store's own waiting jobs, never the queue every store shares, as main read it. `whole` is false
 * when a reply does not read exactly: what was read is kept, never taken as all of them (CX-123 rule 24).
 */
async function queuedIdsOf(statsId: string, filled: boolean): Promise<{ ids: string[]; whole: boolean }> {
  const ids = new Set<string>();
  let cursor = "0";
  for (;;) {
    let page: { next: string; ids: string[] };
    try {
      page = await waitingPage(statsId, filled, cursor);
    } catch (error) {
      if (error instanceof UnknownReplyError) return { ids: [...ids], whole: false };
      throw error;
    }
    for (const id of page.ids) ids.add(id);
    cursor = page.next;
    if (cursor === "0") return { ids: [...ids], whole: true };
  }
}

/**
 * A store's jobs, for one person's erasure and copy, read exactly (CX-123
 * rules 24 and 30, as lib/erasure-index.ts forgetNoted): those in its log and
 * those waiting on the queue, which is where every job record still alive is
 * (dropOverflow, retire), however many newer jobs pushed it out of the
 * studio's LOG_SIZE (Codex Q on #2860). A log, a queue or a record in another
 * shape is UnknownReplyError, never "no job of theirs". A record that is gone
 * (it expired) is null: known absence.
 */
async function loggedJobs(statsId: string): Promise<{ id: string; job: Job | null }[]> {
  return (await loggedJobsWithLog(statsId)).jobs;
}

/** loggedJobs, with the whole log's length, which bounds each LREM count of an erasure. */
async function loggedJobsWithLog(statsId: string): Promise<{ jobs: { id: string; job: Job | null }[]; logLength: number }> {
  const read = repliesFor(await redisPipeline([["LRANGE", logKey(statsId), 0, -1], ["GET", FILL_DONE_KEY]]), 2);
  const ids = stringList(read?.[0]);
  if (!ids) throw new UnknownReplyError("a store's email platform job log");
  const { ids: queued, whole } = await queuedIdsOf(statsId, filledFrom(read![1]));
  if (!whole) throw new UnknownReplyError("a store's email platform jobs waiting on the queue");
  const logged = [...new Set([...ids, ...queued])];
  return { jobs: await readJobs(logged), logLength: ids.length };
}

/** The records of these jobs, read exactly: another shape throws; one that is gone (it expired) is null, known absence. */
async function readJobs(ids: readonly string[]): Promise<{ id: string; job: Job | null }[]> {
  if (!ids.length) return [];
  const raws = repliesFor(await redisPipeline(ids.map((id) => ["GET", jobKey(id)])), ids.length);
  if (!raws) throw new UnknownReplyError("a store's email platform jobs");
  return ids.map((id, i) => {
    const raw = raws[i];
    if (raw === null) return { id, job: null };
    let value: unknown = null;
    try {
      value = typeof raw === "string" ? JSON.parse(raw) : null;
    } catch {
      value = null;
    }
    if (!value || typeof value !== "object" || typeof (value as Partial<Job>).email !== "string") {
      throw new UnknownReplyError("a store's email platform job");
    }
    return { id, job: value as Job };
  });
}

/** Forgets the platform and its key. Anything still waiting to be sent fails at its next try. */
export async function disconnect(store: Store): Promise<SyncView> {
  if (store.statsId) await writeConfig(store, null);
  return viewAfterWrite(store, null, null);
}

/**
 * Deletes the jobs that sent one person to the creator's email platform, and
 * any still waiting for a try (lib/person-erasure.ts). What the platform
 * already took is in the creator's own account there, to be deleted there.
 */
export async function forgetSyncPerson(statsId: string | null, email: string): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const address = normaliseEmail(email);
  const { jobs, logLength } = await loggedJobsWithLog(statsId);
  const theirs = jobs.filter(({ job }) => job && normaliseEmail(job.email) === address).map(({ id }) => id);
  // A try of theirs in flight at the platform (#4266, review of #4392): its request may still carry the address, so
  // the part is not finished. Read after the jobs are deleted (below), so a try that had not marked itself yet finds
  // its job gone and never asks the platform.
  const fly = ["SCARD", flyKey(statsId, address)];
  if (!theirs.length) {
    const read = repliesFor(await redisPipeline([fly]), 1);
    const flying = read ? countOf(read[0]) : null;
    if (flying === null) throw new UnknownReplyError("an email platform try in flight, erasing a person");
    if (flying > 0) throw new UnknownReplyError("an email platform try still in flight, erasing a person");
    return 0;
  }
  // Each delete answers a count (CX-123 rule 24): DEL and ZREM at most the jobs named, LREM at most the log's length.
  // Another shape throws, so the erasure is said as not finished and a retry finds what is left.
  const commands: (string | number)[][] = [["DEL", ...theirs.map(jobKey)], ...theirs.map((id) => ["LREM", logKey(statsId), 0, id]), ["ZREM", QUEUE_KEY, ...theirs.map((id) => `${statsId}|${id}`)], ["SREM", queuedKey(statsId), ...theirs], fly];
  const all = repliesFor(await redisPipeline(commands), commands.length);
  const flying = all ? countOf(all[all.length - 1]) : null;
  if (flying === null) throw new UnknownReplyError("an email platform try in flight, erasing a person");
  if (flying > 0) throw new UnknownReplyError("an email platform try still in flight, erasing a person");
  const replies = all ? all.slice(0, -1) : null;
  const within = (reply: unknown, most: number) => {
    const n = countOf(reply);
    return n !== null && n <= most;
  };
  // The last two are the queue's ZREM and the store's queued index's SREM, each at most the jobs named.
  if (!replies || !within(replies[0], theirs.length) || !within(replies[replies.length - 2], theirs.length) || !within(replies[replies.length - 1], theirs.length) || !replies.slice(1, -2).every((reply) => within(reply, logLength))) {
    throw new UnknownReplyError("deleting a person's email-platform jobs");
  }
  return theirs.length;
}

/**
 * The record of sending a person to the store's connected email platform, for
 * the copy of their data (619 [SZ3], lib/person-copy.ts): what was sent,
 * when and what became of it. The same jobs the erasure deletes. Only reads.
 */
export async function syncJobsOf(statsId: string | null, email: string): Promise<JobView[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const address = normaliseEmail(email);
  // Read as the erasure reads them (rule 30): another shape throws, so the copy fails whole rather than miss a part.
  return viewsOf(await loggedJobs(statsId), address);
}

/** The jobs that are this address's, as the copy shows them. */
function viewsOf(jobs: readonly { job: Job | null }[], address: string): JobView[] {
  return jobs.flatMap(({ job }) => {
    if (!job || normaliseEmail(job.email) !== address) return [];
    const { id, email: sent, title, source, state, attempts, next, lastError, note, lastAt, createdAt } = job;
    return [{ id, email: sent, title, source, state, attempts, next, lastError, note, lastAt, createdAt }];
  });
}

/**
 * One page of syncJobsOf, for a copy in pages (lib/copy-pages.ts; #5125: a store may have more jobs waiting than one
 * request may read, so the copy never stops at a fixed count and never reads past its budget). It reads the store's
 * log first ("l"), then its queued index (queuedKey) with SSCAN from a cursor ("q:<cursor>"), leaving out the jobs
 * the log holds now, which the first page read. Each read takes its commands from `budget` before it is sent: the log
 * is one LRANGE and a GET a job, each index page one SSCAN and a GET a job. When the next read does not fit, the
 * page stops and gives where it goes on ("q:<cursor>:<last id read>" inside an index page, which may hold more
 * jobs than a budget: SSCAN's COUNT is only a hint); with no room even to begin it gives a resume and reads nothing. SSCAN returns every job present for the whole read, so
 * the pages together hold every job of theirs one whole read finds. Read exactly (CX-123 rule 24): another shape
 * throws, so the copy fails rather than miss a part.
 */
export async function syncJobsPage(statsId: string | null, email: string, budget: ReadBudget, resume?: string): Promise<{ jobs: JobView[]; resume?: string }> {
  if (!statsId || !isRedisConfigured()) return { jobs: [] };
  const address = normaliseEmail(email);
  const from = resume ?? "l";
  // "q" pages the store's own index, "g" the shared queue while the indexes are not filled yet (waitingPage).
  const scan = /^([qg]):(\d+)(?::(esj_[0-9a-f]{24}))?$/.exec(from);
  if (from !== "l" && !scan) throw new Error("an email platform copy page goes on from a position that is not its own");
  if (!budget.take(2)) return { jobs: [], resume: from };
  const read = repliesFor(await redisPipeline([["LRANGE", logKey(statsId), 0, -1], ["GET", FILL_DONE_KEY]]), 2);
  const logged = stringList(read?.[0]);
  if (!logged) throw new UnknownReplyError("a store's email platform job log");
  // Every id the log names, read as syncJobsOf reads the log (loggedJobsWithLog).
  const inLog = [...new Set(logged)];
  const jobs: JobView[] = [];
  // A page that began on the shared queue goes on there (exact either way); a new read uses the index once filled.
  const source = scan ? scan[1]! : filledFrom(read![1]) ? "q" : "g";
  let cursor = scan ? scan[2]! : "0";
  // Within one index page, the jobs already read: the page is read in id order, so a page cut short goes on after
  // the last id it read, and every job on that page for the whole read is read once.
  let after = scan?.[3] ?? "";
  if (!scan) {
    if (!budget.take(inLog.length)) return { jobs: [], resume: from };
    jobs.push(...viewsOf(await readJobs(inLog), address));
  }
  const inLogNow = new Set(inLog);
  for (;;) {
    const here = after ? `${source}:${cursor}:${after}` : `${source}:${cursor}`;
    if (!budget.take(1)) return { jobs, resume: here };
    const { next, ids: page } = await waitingPage(statsId, source === "q", cursor);
    const ids = [...new Set(page.filter((id) => !inLogNow.has(id) && id > after))].sort();
    // As many of the page's records as the budget still holds; the rest on the next page, after the last one read.
    const fit = Math.min(ids.length, budget.left);
    if (!budget.take(fit)) return { jobs, resume: here };
    jobs.push(...viewsOf(await readJobs(ids.slice(0, fit)), address));
    if (fit < ids.length) return { jobs, resume: fit ? `${source}:${cursor}:${ids[fit - 1]}` : here };
    cursor = next;
    after = "";
    if (cursor === "0") return { jobs };
  }
}
