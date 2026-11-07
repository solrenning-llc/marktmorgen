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

/** Jobs a store's studio keeps. */
export const LOG_SIZE = 50;
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
export const QUEUE_KEY = "nl:esync:q";
const seenKey = (statsId: string, seed: string) =>
  `nl:esync:seen:${createHash("sha256").update(`${statsId}|${seed}`).digest("hex").slice(0, 40)}`;

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

async function readConfig(statsId: string): Promise<Config | null> {
  const [raw] = await redisPipeline([["GET", cfgKey(statsId)]]);
  return parseConfig(raw);
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
    ...(agreed ? [["ZADD", QUEUE_KEY, now, `${statsId}|${job.id}`]] : []),
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

/** One try of one job. Returns the job as it stands after it. */
async function attempt(job: Job, now: number, budget: number): Promise<Job> {
  const next: Job = { ...job, attempts: job.attempts + 1, lastAt: now };
  const config = await readConfig(job.statsId);
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
  }
}

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
  const done = await attempt(job, now, budget);
  const record: (string | number)[] = ["SET", jobKey(id), JSON.stringify(done), "EX", JOB_SECONDS];
  if (done.state === "retrying") await redisPipeline([record, ["ZADD", QUEUE_KEY, done.next, `${statsId}|${id}`]]);
  else await retire(statsId, id, now, [record]);
  return done;
}

/**
 * Every job record, which holds a buyer's address for a week, stays where a
 * person's copy and erasure find it (Codex Q on #2860): in the store's log, or
 * on the queue while it waits. The log keeps the studio's newest LOG_SIZE, so
 * a job pushed past them leaves it here, and its record goes with it unless it
 * is still waiting. The log is let go of first and the queue read after, so a
 * job finishing meanwhile is either still in the log when retire reads it or
 * already off the queue when this reads it. A place on the queue that does not
 * read, or a deletion that does not answer a count, puts the job back at the
 * end of the log, where it is still found and the next push reads it again.
 */
async function dropOverflow(statsId: string, ids: string[]): Promise<void> {
  const log = logKey(statsId);
  const replies = repliesFor(
    await redisPipeline(ids.flatMap((id) => [["LREM", log, 0, id], ["ZSCORE", QUEUE_KEY, `${statsId}|${id}`]])),
    ids.length * 2,
  );
  const gone: string[] = [];
  const back: string[] = [];
  ids.forEach((id, i) => {
    const score = replies ? replies[i * 2 + 1] : undefined;
    if (score === null) gone.push(id);
    else if (!((typeof score === "string" || typeof score === "number") && score !== "" && Number.isFinite(Number(score)))) back.push(id);
  });
  if (!gone.length && !back.length) return;
  const commands: (string | number)[][] = [...gone.map((id) => ["DEL", jobKey(id)]), ...(back.length ? [["RPUSH", log, ...back]] : [])];
  const answered = repliesFor(await redisPipeline(commands), commands.length);
  const kept = gone.filter((_, i) => countOf(answered?.[i]) === null);
  if (kept.length) await redisPipeline([["RPUSH", log, ...kept]]);
}

/**
 * Takes a job that is done off the queue, after the commands that write how it
 * went, and deletes its record when it is no longer in the store's log, so no
 * record holding an address is left where neither the log nor the queue finds
 * it (dropOverflow). A log or a deletion that does not read puts the job back
 * on the queue, to be retired again when its lease would have ended, and
 * throws (CX-123 rule 24).
 */
async function retire(statsId: string, id: string, now: number, first: (string | number)[][] = []): Promise<void> {
  const member = `${statsId}|${id}`;
  const commands = [...first, ["ZREM", QUEUE_KEY, member], ["LRANGE", logKey(statsId), 0, -1]];
  const logged = stringList(repliesFor(await redisPipeline(commands), commands.length)?.[commands.length - 1]);
  if (logged?.includes(id)) return;
  if (logged && countsFor(await redisPipeline([["DEL", jobKey(id)]]), 1)) return;
  await redisPipeline([["ZADD", QUEUE_KEY, now + LEASE_MS, member]]);
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
  log: JobView[];
};

export async function syncView(store: Store): Promise<SyncView> {
  const available = canSeal() && isRedisConfigured();
  if (!store.statsId || !isRedisConfigured()) return { available, connected: null, log: [] };
  const statsId = store.statsId;
  const [rawConfig, rawBad, rawLog] = await redisPipeline([
    ["GET", cfgKey(statsId)],
    ["GET", badKey(statsId)],
    ["LRANGE", logKey(statsId), 0, LOG_SIZE - 1],
  ]);
  const config = parseConfig(rawConfig);
  const ids = Array.isArray(rawLog) ? (rawLog as unknown[]).map(String).filter((id) => JOB_ID.test(id)) : [];
  const jobs = ids.length ? await redisPipeline(ids.map((id) => ["GET", jobKey(id)])) : [];
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
    connected: config
      ? {
          provider: config.provider,
          last4: config.last4,
          target: config.target,
          free: config.free,
          buyers: config.buyers,
          products: config.products,
          tags: config.tags,
          connectedAt: config.connectedAt,
          problem,
        }
      : null,
    log: jobs
      .map(parseJob)
      .filter((job): job is Job => job !== null)
      .map((job) => ({
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
      })),
  };
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
  return { ok: true, view: await syncView(store), targets };
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
  return { ok: true, view: await syncView(store) };
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
    if (!config.target) return { ok: true, message: `${name} accepted the key. Now choose the ${TARGET_WORDS[config.provider]} to add people to.`, view: await syncView(store) };
    if (!targets.some((t) => t.id === config.target?.id)) {
      const message = `${name} accepted the key, but the ${TARGET_WORDS[config.provider]} “${config.target.name}” is not there anymore. Choose another.`;
      await redisPipeline([["SET", badKey(store.statsId), JSON.stringify({ message, at: Date.now() }), "EX", 30 * 86400]]);
      return { ok: false, message, view: await syncView(store) };
    }
    await redisPipeline([["DEL", badKey(store.statsId)]]);
    return { ok: true, message: `Connected: ${name} accepted the key and “${config.target.name}” is there.`, view: await syncView(store) };
  } catch (error) {
    return { ok: false, message: words(error, config.provider), view: await syncView(store) };
  }
}

/**
 * Forgets a deleted store's platform, its sealed key with it, without
 * touching the store record (which is already gone), and every job of the
 * store with it: those waiting in the queue are taken off it at once, and
 * the records of its jobs — which hold buyers' addresses — are deleted
 * rather than left to expire.
 */
export async function forgetStoreSync(statsId: string | null): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  // Every reply read exactly (CX-123 rule 24): a log or a queue page in another shape is unknown, never "no job".
  // What was read is still deleted (the sealed key with the settings), the log is kept when it did not read, so
  // the next try finds its jobs, and the forgetting throws rather than being taken as finished (Claude 5 sweep A2).
  const logged = stringList(repliesFor(await redisPipeline([["LRANGE", logKey(statsId), 0, -1]]), 1)?.[0]);
  let unread = !logged;
  const ids = new Set((logged ?? []).filter((id) => JOB_ID.test(id)));
  const { members: queued, whole } = await queuedOf(statsId);
  if (!whole) unread = true;
  for (const member of queued) {
    const id = member.slice(statsId.length + 1);
    if (JOB_ID.test(id)) ids.add(id);
  }
  const commands: (string | number)[][] = [
    ...(queued.length ? [["ZREM", QUEUE_KEY, ...queued]] : []),
    ...[...ids].map((id) => ["DEL", jobKey(id)]),
    ["DEL", cfgKey(statsId), tagsKey(statsId), badKey(statsId), ...(logged ? [logKey(statsId)] : [])],
  ];
  if (!countsFor(await redisPipeline(commands), commands.length)) throw new UnknownReplyError("the forgetting of a deleted store's email platform jobs");
  if (unread) throw new UnknownReplyError("a deleted store's email platform jobs");
}

/** Whether a pipeline of deletions answered exactly one count for each command. */
function countsFor(replies: unknown, commands: number): boolean {
  const exact = repliesFor(replies, commands);
  return !!exact && exact.every((reply) => countOf(reply) !== null);
}

/**
 * The queue holds the jobs of every store waiting for a try, each as
 * "<statsId>|<job>"; this store's are found by that prefix, read with ZSCAN,
 * which returns every member present for the whole read (an offset page skips
 * one when a member before it leaves meanwhile). `whole` is false when a reply
 * does not read exactly or the read runs past its rounds: what was read is
 * kept, never taken as all of them (CX-123 rule 24).
 */
async function queuedOf(statsId: string): Promise<{ members: string[]; whole: boolean }> {
  const prefix = `${statsId}|`;
  const members = new Set<string>();
  let cursor = "0";
  for (let round = 0; round < 10_000; round += 1) {
    const reply = repliesFor(await redisPipeline([["ZSCAN", QUEUE_KEY, cursor, "COUNT", 500]]), 1)?.[0];
    const pair = Array.isArray(reply) && reply.length === 2 ? (reply as unknown[]) : null;
    const next = typeof pair?.[0] === "number" ? String(pair[0]) : pair?.[0];
    const flat = pair ? stringList(pair[1]) : null;
    if (typeof next !== "string" || !/^\d+$/.test(next) || !flat || flat.length % 2 !== 0) return { members: [...members], whole: false };
    for (let i = 0; i < flat.length; i += 2) if (flat[i].startsWith(prefix)) members.add(flat[i]);
    cursor = next;
    if (cursor === "0") return { members: [...members], whole: true };
  }
  return { members: [...members], whole: false };
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
  const ids = stringList(repliesFor(await redisPipeline([["LRANGE", logKey(statsId), 0, -1]]), 1)?.[0]);
  if (!ids) throw new UnknownReplyError("a store's email platform job log");
  const { members, whole } = await queuedOf(statsId);
  if (!whole) throw new UnknownReplyError("a store's email platform jobs waiting on the queue");
  const logged = [...new Set([...ids, ...members.map((member) => member.slice(statsId.length + 1))])];
  if (!logged.length) return [];
  const raws = repliesFor(await redisPipeline(logged.map((id) => ["GET", jobKey(id)])), logged.length);
  if (!raws) throw new UnknownReplyError("a store's email platform jobs");
  return logged.map((id, i) => {
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
  return syncView(store);
}

/**
 * Deletes the jobs that sent one person to the creator's email platform, and
 * any still waiting for a try (lib/person-erasure.ts). What the platform
 * already took is in the creator's own account there, to be deleted there.
 */
export async function forgetSyncPerson(statsId: string | null, email: string): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const address = normaliseEmail(email);
  const theirs = (await loggedJobs(statsId)).filter(({ job }) => job && normaliseEmail(job.email) === address).map(({ id }) => id);
  if (!theirs.length) return 0;
  const commands: (string | number)[][] = [["DEL", ...theirs.map(jobKey)], ...theirs.map((id) => ["LREM", logKey(statsId), 0, id]), ["ZREM", QUEUE_KEY, ...theirs.map((id) => `${statsId}|${id}`)]];
  if (!countsFor(await redisPipeline(commands), commands.length)) throw new UnknownReplyError("the deletion of a person's email platform jobs");
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
  return (await loggedJobs(statsId)).flatMap(({ job }) => {
    if (!job || normaliseEmail(job.email) !== address) return [];
    const { id, email: sent, title, source, state, attempts, next, lastError, note, lastAt, createdAt } = job;
    return [{ id, email: sent, title, source, state, attempts, next, lastError, note, lastAt, createdAt }];
  });
}
