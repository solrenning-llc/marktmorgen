/**
 * Webhooks: telling the creator's other tools what happened in their store.
 *
 * A creator adds up to MAX_ENDPOINTS https addresses — a Zapier "Catch Hook",
 * a Make or n8n webhook, their own server — and picks which events each one
 * hears. When one of those things happens, a JSON message is POSTed to it:
 *
 *   sale.completed       a paid checkout on the store (any product, calls and
 *                        memberships included), or a one-click extra after it
 *   membership.started   a membership bought (not a payment plan)
 *   membership.canceled  a membership set to end, or ended
 *   lead.captured        someone confirmed their address for a free product
 *                        (the link in the email was used)
 *   list.joined          someone confirmed their address to join the store's
 *                        list, from its sign-up box, one of its forms or the
 *                        checkout script on the creator's own site
 *   call.booked          a call or a seat in a session booked and paid
 *   call.moved           a buyer moved their booking
 *   refund.issued        a refund made on the creator's Stripe account
 *   membership.changed   a membership moved to another price or quantity on
 *                        the creator's Stripe account (630 [HN6](18))
 *   dispute.opened       a buyer disputed a payment the store's checkout made
 *                        (630 [HN6](18))
 *
 * The first four about money, and these last two, are read from the creator's own Stripe account,
 * which is the ledger, by the five-minute job (watchStripe): its events are
 * walked from where the last run stopped, so a refund made in the Stripe
 * dashboard is noticed on the next run, within about five minutes. A refund
 * or a dispute names only a payment: whose it is is read off the payment,
 * or, for a membership's or a payment plan's charge, off the invoice it paid
 * (paymentMeta), within a bounded number of calls per run. An event whose
 * store could not be told in a run (a call failed, or the run's calls ran
 * out) is not passed over: the anchor stays before it, and the next run reads
 * it again. The other three happen in our own code and are sent the moment
 * they happen.
 *
 * Every event has an id made from what it is about — the checkout, the
 * subscription, the refund — so however many times the same thing is noticed
 * (the thanks page and the job, a run that repeats), it is sent once. Every
 * message is signed: the header Marktmorgen-Signature is "t=<seconds>,v1=<hex>",
 * where the hex is HMAC-SHA256 of "<seconds>.<body>" under the endpoint's
 * secret, which is shown to the creator once, when the endpoint is added. A
 * receiver checks the signature and that the time is recent, and uses the
 * event id to ignore a repeat.
 *
 * A message is tried at once, and when the endpoint does not answer 2xx, again
 * after RETRY_MINUTES (5 minutes, 15, 1 hour, 3, 12, 24): seven tries over
 * about forty hours, then it is marked failed. Retries ride the five-minute
 * job, a bounded number per run. Since 18 October 2026 every try, the first,
 * each retry and each test, is one of the store's webhook deliveries for its
 * month (lib/store-allowance-rules.ts), taken before the endpoint is called:
 * once they are used, a delivery is not tried, and is marked failed with the
 * reason, which the studio's log shows. The last LOG_SIZE deliveries of a store are
 * kept for its studio, with what the endpoint answered; each is kept for a
 * week at most. Every request goes through lib/safe-fetch.ts, so an endpoint
 * on a private network is refused, and none follows a redirect.
 *
 *   nl:hooks:cfg:<statsId>      { handle, endpoints, since }
 *   nl:hooks:stores             the stores that have any endpoint
 *   nl:hooks:evt:<event>        an event already sent, for thirty days
 *   nl:hooks:d:<delivery>       one delivery and how it went, for a week
 *   nl:hooks:log:<statsId>      the store's last deliveries, newest first
 *   nl:hooks:q                  deliveries waiting for a try, by when
 *   nl:hooks:anchor:<statsId>   the last Stripe event read for this store
 *   nl:hooks:wait:<statsId>     the event its reading waits on, and for how many runs
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { after } from "next/server";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
// The repository's compare-and-set script (GET equals what was read, then SET), also modelled by lib/redis-memory.ts.
import { SAVE_CRM_PIPELINES as COMPARE_AND_SET } from "@/lib/crm";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { STRIPE_VERSION } from "@/lib/stripe-connect";
import { isSettled } from "@/lib/instant-pay";
import { SafeFetchError, checkUrl, problemWords, safeFetch } from "@/lib/safe-fetch";
import { type Store, storeForHandle, saleHandles } from "@/lib/store";
import { allowanceUsedWords, allowancesUsedStrict, takeAllowance } from "@/lib/store-allowance";
import { WEBHOOK_ADD_PAUSED_WORDS, WEBHOOK_PAUSED_COUNTED, WEBHOOK_PAUSED_NOT_SENT_WORDS, WEBHOOK_TEST_PAUSED_WORDS, integrationPauseWord } from "@/lib/integration-pause";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { readListing } from "@/lib/catalog";
import { keyStates } from "@/lib/api-keys";
import { SITE_URL } from "@/lib/site-url";
import { type BundleSlot, bumpsFromMeta, bundleFromMeta } from "@/lib/bundle-rules";
import { DELIVERY_MAX_BYTES, DELIVERY_UPDATE_ROOM_BYTES, DELIVERY_WRITE_MAX_BYTES, MAX_ENDPOINTS, MESSAGE_TEXT_MAX, shortAddress } from "@/lib/webhook-limits";

export const WEBHOOK_EVENTS = [
  "sale.completed",
  "membership.started",
  "membership.canceled",
  "lead.captured",
  "list.joined",
  "call.booked",
  "call.moved",
  "refund.issued",
  "sequence.step",
  "membership.changed",
  "dispute.opened",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Endpoints one store may have, and how an address is shown (lib/webhook-limits.ts, which the studio and the feature page read too). */
export { DELIVERY_MAX_BYTES, DELIVERY_UPDATE_ROOM_BYTES, DELIVERY_WRITE_MAX_BYTES, MAX_ENDPOINTS, MESSAGE_TEXT_MAX, shortAddress };
/** Deliveries a store's studio keeps. */
export const LOG_SIZE = 50;
/** Minutes to wait before each try after the first. */
export const RETRY_MINUTES = [5, 15, 60, 180, 720, 1440];
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
/** How long an endpoint has to answer one try. */
export const ATTEMPT_TIMEOUT_MS = 8_000;
/** The longest address accepted for an endpoint. */
export const MAX_ENDPOINT_URL = 1000;
/** Test messages one store may send in a minute. */
const TESTS_PER_MINUTE = 10;
/** Stripe events read per store per run, in pages of a hundred. */
const MAX_EVENT_PAGES = 3;
/** How far back a store's first run reads, in pages of a hundred events. */
const FIRST_RUN_PAGES = 10;
/** Deliveries retried in one run of the job, at most. */
const MAX_RETRIES_PER_RUN = 100;
/**
 * Visits of the five-minute job to one store that a Stripe event of it may
 * wait on a lookup that fails, before it is passed over with a loud log and
 * a line in the store's delivery log, so one event Stripe keeps refusing
 * never holds the store's later events past the thirty days Stripe keeps
 * them. It counts visits, not time: 288 is about a day only while every run
 * reaches the store before its deadline; with more stores than one run
 * reaches, it is longer.
 */
export const STRIPE_WAIT_RUNS = 288;
/**
 * The same bound in time, whichever comes first: an event waits at most two
 * days from the visit it first stopped, so a store visited seldom (many
 * stores, one run after another) gives up long before Stripe's thirty days
 * would drop the anchor and lose the event with no line.
 */
export const STRIPE_WAIT_MAX_SECONDS = 2 * 86400;
/**
 * Visits an event must have failed before the time bound applies, so an
 * event first stopped before a long pause (the plan's costs paused, the job
 * not visiting) still gets a few more tries once the store is visited again.
 */
export const STRIPE_WAIT_TIME_VISITS = 6;
/**
 * Visits an event waits on Stripe refusing the lookup itself (a 4xx other
 * than 429 or 409: a request Stripe will answer the same way every time):
 * a few, so one refund or dispute never holds the store's later events for
 * a day. A failure that passes (5xx, a timeout, 429) keeps the long wait.
 */
export const STRIPE_REFUSED_RUNS = 3;
/**
 * Passed-over Stripe events that leave their own lines in one store's
 * delivery log in a day (UTC); past them one summary line per endpoint says
 * how many more were skipped that day, so what these uncharged lines keep
 * stays small whatever Stripe does, and the creator still hears of each.
 */
export const GIVEN_UP_LINES_PER_DAY = 3;
const ANCHOR_SECONDS = 30 * 86400;

const EVENT_SECONDS = 30 * 86400;
const DELIVERY_SECONDS = 7 * 86400;

/** What the studio's log says of a message past the bound: written down, not sent. */
export const TOO_LARGE_WORDS = `Not sent: this message would take more than ${DELIVERY_WRITE_MAX_BYTES / 1024} KB to keep, the most a webhook message may take. Nothing was counted.`;
/**
 * Lines a store's log gets in a UTC day for messages not kept (too large, or
 * the month's deliveries used), each reason on its own: past them, one line
 * an endpoint for the day says how many more, rewritten with its count. So
 * what these lines keep stays small whatever a store sells.
 */
export const SKIPPED_LINES_PER_DAY = 3;

/**
 * An endpoint. `previous` is the secret it had before the creator replaced
 * it (378 [TB4]), kept only until `previousUntil` (milliseconds): until then
 * every message carries a signature under each, so a receiver still holding
 * the old secret keeps accepting while the creator moves it to the new one.
 */
type Endpoint = {
  id: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
  addedAt: string;
  previous?: string;
  previousUntil?: number;
  /**
   * The API key that added it (app/api/v1/hooks), by id; absent for one added
   * in the studio. Such an endpoint is sent something only while that key is
   * in use (owner C3-100): its key's state is read at every send, never a mark
   * of its own, so an endpoint written in the instant its key was paused or
   * revoked, or its maker left the team, is sent nothing either.
   */
  key?: string;
};

/** Why an endpoint added by an API key is sent nothing: its key is paused, or was revoked. */
export type EndpointHeld = "paused" | "revoked";

/**
 * The endpoints sent to now: one added in the studio always, one added by an API key while that key is in use
 * (lib/api-keys.ts keyStates). `keepUnread` (emitEvent): when the keys' states cannot all be read, each key is
 * read on its own, and an endpoint whose key alone cannot be read is kept, so its delivery is written and
 * queued; the try reads the key again before anything is sent (attempt, heldNow) and sends nothing until it
 * reads as in use. So one unreadable key holds back only its own endpoint, never the event for every endpoint
 * of the store, which callers that only log (PayPal, calls, free downloads) would lose (Claude 2 on #3096).
 */
async function liveEndpoints(store: Pick<Store, "sid">, endpoints: Endpoint[], keepUnread = false): Promise<Endpoint[]> {
  const keyed = endpoints.filter((e) => e.key);
  if (!keyed.length) return endpoints;
  const ids = keyed.map((e) => e.key as string);
  const { states, unread } = keepUnread
    ? await eachKeyState(store.sid ?? "", ids, (error) => error instanceof UnknownReplyError)
    : { states: await keyStates(store.sid ?? "", ids), unread: new Set<string>() };
  if (unread.size) console.error("WEBHOOK KEY STATE UNREAD: the endpoints of these API keys are queued and held until their state reads", store.sid, [...unread]);
  return endpoints.filter((e) => !e.key || states.get(e.key) === "live" || unread.has(e.key));
}

/**
 * The state of each of these keys, read all at once and, when that answer cannot be read, each key on its own: the
 * keys whose own state cannot be read come back in `unread`, never as in use, paused or revoked (rule 24), so one
 * unreadable key never stands for the others. `unreadable` says which errors make a key unread; any other is thrown.
 */
async function eachKeyState(sid: string, ids: string[], unreadable: (error: unknown) => boolean): Promise<{ states: Map<string, string>; unread: Set<string> }> {
  try {
    return { states: await keyStates(sid, ids), unread: new Set() };
  } catch (error) {
    if (!unreadable(error)) throw error;
  }
  const states = new Map<string, string>();
  const unread = new Set<string>();
  for (const id of new Set(ids)) {
    try {
      for (const [key, state] of await keyStates(sid, [id])) states.set(key, state);
    } catch (one) {
      if (!unreadable(one)) throw one;
      unread.add(id);
    }
  }
  return { states, unread };
}

/** Why one endpoint is sent nothing now, or null when it is sent to. */
async function heldNow(store: Pick<Store, "sid">, endpoint: Endpoint): Promise<EndpointHeld | null> {
  if (!endpoint.key) return null;
  const state = (await keyStates(store.sid ?? "", [endpoint.key])).get(endpoint.key);
  return state === "live" ? null : state === "paused" ? "paused" : "revoked";
}

const HELD_WORDS: Record<EndpointHeld, string> = {
  paused: "Not sent: the API key that added this endpoint is paused.",
  revoked: "Not sent: the API key that added this endpoint was revoked.",
};
/** A delivery whose API key's state could not be read: held, never sent on a guess (rule 24). */
const KEY_UNREAD_WORDS = {
  retrying: "Not sent yet: the state of the API key that added this endpoint could not be read. It will be tried again.",
  failed: "Not sent: the state of the API key that added this endpoint could not be read at any try. Once the key can be read again, you can send it again by hand.",
};
/** A delivery whose month's webhook count could not be made at its last try: the endpoint was never called (rule 30). */
const COUNT_UNREAD_FAILED_WORDS =
  "Not sent: this month's webhook deliveries could not be counted at any try, so the endpoint was not called. Once they can be counted again, you can send it again by hand.";
const KEY_ID_PATTERN = /^[0-9a-f]{12}$/;

/** How long the old secret still signs after it is replaced: one day, then it is gone. */
export const ROTATION_HOURS = 24;
type Config = { handle: string; endpoints: Endpoint[]; since: number };

export type Delivery = {
  id: string;
  statsId: string;
  endpoint: string;
  eventId: string;
  type: WebhookEvent | "test";
  body: string;
  attempts: number;
  state: "queued" | "delivered" | "retrying" | "failed";
  /** When the next try is due, in milliseconds; 0 once there is none. */
  next: number;
  /** What the endpoint last answered: its status, or 0 when it did not answer. */
  lastStatus: number;
  lastError: string;
  lastAt: number;
  createdAt: number;
  /** Set when it was not sent because the plan's costs were paused (232 [CA1] 4b4b2). */
  notSentPaused?: true;
  /** The failed delivery this one sends again, by the creator's hand (378 [TB4] unit 3). */
  resentFrom?: string;
  /** On a failed delivery: the last time it was sent again by hand, so it is sent again only while that one failed. */
  resentAs?: string;
  /**
   * Set on the line a Stripe event leaves in the log when it was passed over
   * after waiting STRIPE_WAIT_RUNS visits on a lookup that kept failing, and
   * on the line of a message larger than a delivery may be kept at
   * (DELIVERY_MAX_BYTES): no message is kept, so there is nothing to send
   * again (its body is empty).
   */
  givenUp?: true;
  /**
   * Whether one of the store's webhook deliveries for its month was, or may
   * have been, taken for this delivery at any try (a count whose reply was
   * unknown may have landed). Written as true or false by every try from the
   * marker on; read only by countedByMonth.
   */
  counted?: boolean;
};

/**
 * Whether the month counted this delivery at some try, so its message may be
 * kept past a month that is used (Claude 2 on #3096, comment 6713512225, LOW 1).
 * Read strictly (rule 24): true and false as written; with no marker (written
 * before it), the old reading, under which a try raised `attempts` only when
 * the month counted it; anything off-shape is read as counted, so a message is
 * never dropped on a guess. It only decides whether a message is kept: every
 * try and every resend still takes its own delivery, so nothing is charged twice.
 */
function countedByMonth(delivery: Pick<Delivery, "attempts" | "counted">): boolean {
  if (delivery.counted === true || delivery.counted === false) return delivery.counted;
  if (delivery.counted !== undefined) return true;
  return !(typeof delivery.attempts === "number" && delivery.attempts === 0);
}

const cfgKey = (statsId: string) => `nl:hooks:cfg:${statsId}`;
const STORES_KEY = "nl:hooks:stores";
const eventKey = (id: string) => `nl:hooks:evt:${id}`;
const deliveryKey = (id: string) => `nl:hooks:d:${id}`;
const logKey = (statsId: string) => `nl:hooks:log:${statsId}`;
export const QUEUE_KEY = "nl:hooks:q";
const anchorKey = (statsId: string) => `nl:hooks:anchor:${statsId}`;
/** The event a store's Stripe reading is waiting on, and for how many runs: "<evt>|<runs>". */
const waitKey = (statsId: string) => `nl:hooks:wait:${statsId}`;
/** The passed-over events said to one endpoint of a store on one UTC day, a sorted set by when each was first passed over; gone at the end of the next day. */
const givenUpDayKey = (statsId: string, day: number, endpoint: string) => `nl:hooks:wait:${statsId}:day:${day}:${endpoint}`;
/** The endpoints of a store told of passed-over events on one UTC day, at most MAX_ENDPOINTS, so removing and adding endpoints makes no more day sets. */
const givenUpEndpointsKey = (statsId: string, day: number) => `nl:hooks:wait:${statsId}:eps:${day}`;
/** How many passed-over events a store has placed in a UTC day: each one's own number, so no two share a place. */
const givenUpSeqKey = (statsId: string, day: number) => `nl:hooks:wait:${statsId}:seq:${day}`;
const testsKey = (statsId: string) => `nl:rl:hooks:test:${statsId}`;
const POSITION_KEY = "nl:hooks:pos";

const ENDPOINT_ID_PATTERN = /^we_[0-9a-f]{16}$/;
const DELIVERY_ID_PATTERN = /^dlv_[0-9a-f]{24}$/;

/**
 * A text as a message carries it: control characters (which JSON escapes in
 * six bytes, seven kept) turned into a space, cut at MESSAGE_TEXT_MAX, and a
 * lone half of a surrogate pair (escaped the same way) made U+FFFD. What is
 * left escapes in at most two bytes a unit, four kept (a quotation mark or
 * a backslash), which DELIVERY_MAX_BYTES is sized for.
 */
export function cleanText(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, MESSAGE_TEXT_MAX)
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/** Every text in a message's data cleaned (cleanText), keys too; numbers, booleans and nulls as they are. */
export function cleanData(value: unknown): unknown {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return value.map(cleanData);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [cleanText(k), cleanData(v)]));
  return value;
}

/** Whether a delivery written as `text` would pass what it may be kept at when written. */
const tooLargeToKeep = (text: string) => Buffer.byteLength(text) > DELIVERY_WRITE_MAX_BYTES;

function isEvent(value: unknown): value is WebhookEvent {
  return typeof value === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** An endpoint with its old secret dropped once its day is over, or when it was never well formed. */
function withoutStalePrevious(endpoint: Endpoint, now = Date.now()): Endpoint {
  const { previous, previousUntil, ...rest } = endpoint;
  if (typeof previous === "string" && previous && typeof previousUntil === "number" && Number.isFinite(previousUntil) && previousUntil > now) {
    return { ...rest, previous, previousUntil };
  }
  return rest;
}

function parseConfig(raw: unknown): Config | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Config>;
    const endpoints = Array.isArray(value.endpoints)
      ? value.endpoints
          .filter((e): e is Endpoint => Boolean(e) && typeof e.id === "string" && ENDPOINT_ID_PATTERN.test(e.id) && typeof e.url === "string" && typeof e.secret === "string")
          .map((e) => {
            const { key, ...rest } = e;
            return withoutStalePrevious({
              ...rest,
              events: Array.isArray(e.events) ? e.events.filter(isEvent) : [],
              ...(typeof key === "string" && KEY_ID_PATTERN.test(key) ? { key } : {}),
            });
          })
      : [];
    return {
      handle: typeof value.handle === "string" ? value.handle : "",
      endpoints: endpoints.slice(0, MAX_ENDPOINTS),
      since: typeof value.since === "number" ? value.since : 0,
    };
  } catch {
    return null;
  }
}

function parseDelivery(raw: unknown): Delivery | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Delivery;
    return typeof value.id === "string" && typeof value.body === "string" ? value : null;
  } catch {
    return null;
  }
}

async function readConfig(statsId: string): Promise<Config | null> {
  const [raw] = await redisPipeline([["GET", cfgKey(statsId)]]);
  return parseConfig(raw);
}

/** How many times a change is tried again from a fresh read when another one landed first. */
const CONFIG_WRITE_TRIES = 4;

/**
 * Changes a store's webhook settings over exactly what was read (378 [TB4]).
 * Every writer reads the whole settings and writes them back; before this, two
 * changes at once could undo each other in silence, and a replaced secret
 * could come back as the old one while the creator was holding the new. Now
 * the write lands only if the settings are still the text read
 * (COMPARE_AND_SET); otherwise the change is made again on a fresh read, a
 * few times, and then refused. `change` returns null to write nothing.
 */
async function changeConfig(statsId: string, change: (config: Config | null) => Config | null): Promise<{ before: Config | null; after: Config } | null> {
  for (let tries = 0; tries < CONFIG_WRITE_TRIES; tries += 1) {
    // Read exactly (CX-123 rule 24): only GET null is "no settings"; another shape is unknown and nothing is written.
    const read = repliesFor(await redisPipeline([["GET", cfgKey(statsId)]]), 1);
    if (!read || (read[0] !== null && typeof read[0] !== "string")) throw new UnknownReplyError("a store's webhook settings");
    const raw = read[0];
    const before = parseConfig(raw);
    const after = change(before);
    if (!after) return null;
    // Only 1 is saved and only [-1] / [-1, n] is "changed meanwhile, made again"; any other reply is unknown: it may
    // have landed, so the change is never made again over it, and it is never said saved (rules 24 and 30).
    if (compareAndSetReply(await redisPipeline([["EVAL", COMPARE_AND_SET, 1, cfgKey(statsId), raw ?? "", JSON.stringify(after)]]), "the webhook settings' save") === "saved") return { before, after };
  }
  throw new Error("The webhook settings kept changing while being saved.");
}

/**
 * The compare-and-set script's reply (SAVE_CRM_PIPELINES v2, modelled by lib/redis-memory.ts), read in its exact
 * shape: "saved" for 1, "changed" for [-1] (nothing there) or [-1, n] (the length there now, a whole number). Any
 * other reply, of the pipeline or of the script, is unknown and throws UnknownReplyError (CX-123 rule 24).
 */
function compareAndSetReply(replies: unknown, what: string): "saved" | "changed" {
  const reply = repliesFor(replies, 1);
  if (reply && reply[0] === 1) return "saved";
  // The script's own list, read as exactly one or two slots, as a pipeline's replies are (no Proxy, hole or getter).
  const changed = reply ? (repliesFor(reply[0], 1) ?? repliesFor(reply[0], 2)) : null;
  if (changed && changed[0] === -1 && (changed.length === 1 || countOf(changed[1]) !== null)) return "changed";
  throw new UnknownReplyError(what);
}

/** The source fields of a sale.completed message, read off the order's metadata; null where it carries none. */
export function sourceOf(meta: Record<string, string | undefined>): Record<string, string | null> {
  const field = (name: string) => (typeof meta[name] === "string" && meta[name] ? (meta[name] as string) : null);
  let site: string | null = null;
  const embed = field("embed_site");
  if (embed) {
    try {
      site = new URL(embed).origin;
    } catch {
      site = null;
    }
  }
  return {
    utm_source: field("utm_source"),
    utm_medium: field("utm_medium"),
    utm_campaign: field("utm_campaign"),
    utm_content: field("utm_content"),
    site,
  };
}

/** The id of an event, the same every time the same thing is noticed. */
export function eventIdFor(statsId: string, type: string, seed: string): string {
  return `evt_${createHash("sha256").update(`${statsId}|${type}|${seed}`).digest("hex").slice(0, 32)}`;
}

/** The signature header for one body at one moment. */
export function signature(secret: string, timestamp: number, body: string): string {
  const hex = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${hex}`;
}

/**
 * The header an endpoint's message carries: one v1 under its secret and,
 * while a replaced secret's day lasts, a second v1 under the old one, as
 * Stripe does during its own secret rolls. A receiver that accepts any v1 its
 * secret matches works with either, so nothing is refused mid-change, and a
 * retry still waiting when the secret is replaced goes out signed with both.
 */
export function signatureFor(endpoint: Pick<Endpoint, "secret" | "previous" | "previousUntil">, timestamp: number, body: string, now = Date.now()): string {
  const header = signature(endpoint.secret, timestamp, body);
  if (!endpoint.previous || typeof endpoint.previousUntil !== "number" || endpoint.previousUntil <= now) return header;
  const old = createHmac("sha256", endpoint.previous).update(`${timestamp}.${body}`).digest("hex");
  return `${header},v1=${old}`;
}

// ---- Sending ----------------------------------------------------------------

/** Test seams for the fetch; production passes nothing. */
export type SendHooks = { fetch?: Pick<Parameters<typeof safeFetch>[1], "resolve" | "agent"> };
let hooksForTests: SendHooks = {};
/** Lets a local check point deliveries at a stand-in. Never called by the app. */
export function setSendHooksForTests(hooks: SendHooks): void {
  hooksForTests = hooks;
}

/** One try of one delivery. Returns the delivery as it stands after it. */
/**
 * `store` is whose month the try is taken from, before the endpoint is
 * called; "taken" when the caller took it already (a test).
 */
async function attempt(delivery: Delivery, endpoint: Endpoint | undefined, store: Store | null | "taken", now = Date.now()): Promise<Delivery> {
  const next = { ...delivery, attempts: delivery.attempts + 1, lastAt: now };
  if (!endpoint) {
    return { ...next, state: "failed", next: 0, lastStatus: 0, lastError: "The endpoint was removed." };
  }
  if (!store) return { ...delivery, state: "failed", next: 0, lastAt: now, lastStatus: 0, lastError: "The store could not be found." };
  // Its API key paused or revoked (owner C3-100), read now: nothing is sent, and nothing is counted.
  // A test and a resend ("taken") were checked the same way before they took their delivery.
  let keyHeld: EndpointHeld | null = null;
  if (store !== "taken") {
    try {
      keyHeld = await heldNow(store, endpoint);
    } catch (error) {
      if (!(error instanceof UnknownReplyError)) throw error;
      // The key's state cannot be read (rule 24): never taken as "not held", so the endpoint is not called and
      // nothing of the month is taken, as nothing went out. The try is counted and the delivery waits on the
      // published schedule, so a key that stays unreadable costs at most MAX_ATTEMPTS reads and log lines, never
      // one at every lease for DELIVERY_SECONDS; after the last try it is failed with the reason, its message
      // kept, and can be sent again by hand once the key reads (Claude 2 on #3096, comment 6712352850).
      console.error("WEBHOOK KEY STATE UNREAD: the delivery is held, not sent", delivery.statsId, delivery.id, next.attempts);
      const retryIn = delivery.type === "test" ? undefined : RETRY_MINUTES[next.attempts - 1];
      // Nothing of the month taken at this try: the marker keeps what earlier tries said.
      const held = { ...next, counted: countedByMonth(delivery) };
      if (retryIn === undefined) return { ...held, state: "failed", next: 0, lastStatus: 0, lastError: KEY_UNREAD_WORDS.failed };
      return { ...held, state: "retrying", next: now + retryIn * 60_000, lastStatus: 0, lastError: KEY_UNREAD_WORDS.retrying };
    }
  }
  if (keyHeld) return { ...delivery, state: "failed", next: 0, lastAt: now, lastStatus: 0, lastError: HELD_WORDS[keyHeld] };
  // 232 [CA1] 4b4b2: while the plan's renewal is unpaid or its payment is
  // disputed, nothing is sent and the endpoint is not called. The delivery is
  // marked not sent at once, with the reason, and not tried again: a delivery
  // kept waiting would be looked at again and again at a cost no figure
  // carries. It still takes one of the month's webhook deliveries, so what is
  // refused stays inside what the month is priced for. Events after the
  // payment is recorded, or the dispute settled, are sent as usual.
  const paused = store === "taken" || delivery.type === "test" ? null : integrationPauseWord(store, now / 1000);
  // One of the store's webhook deliveries for its month, before the endpoint is called.
  const taken = store === "taken" ? ({ ok: true } as const) : await takeAllowance(store, "webhook", 1, now);
  // Whether the month has counted this delivery, after this try: written on every outcome from here on. A count
  // whose reply is unknown may have landed (lib/store-allowance.ts keeps such an increment), so it is marked as
  // counted: a message is never dropped on a guess (rule 24); keeping it costs only its storage for the week.
  const counted = { counted: taken.ok || taken.reason === "unknown" || countedByMonth(delivery) };
  // The month's deliveries used and none ever taken for this delivery: not sent, and its message is not kept past
  // it (a line, as emitEvent writes one), so a message is kept only by a delivery the month counted. One counted at
  // an earlier try keeps its message, and can be sent again by hand. Read off the marker, not off `attempts`, which
  // a held or an uncounted try raises without taking anything (Claude 2 on #3096, comment 6713512225, LOW 1).
  const unkept = !taken.ok && taken.reason === "used" && delivery.type !== "test" && !countedByMonth(delivery) ? { body: "", givenUp: true as const } : {};
  // Paused: never retried, whatever the count answered; a month already used is said too.
  if (paused) {
    const countedWords = taken.ok ? ` ${WEBHOOK_PAUSED_COUNTED}` : taken.reason === "unknown" ? "" : ` ${taken.message}`;
    return { ...delivery, ...counted, state: "failed", next: 0, lastAt: now, lastStatus: 0, lastError: `${WEBHOOK_PAUSED_NOT_SENT_WORDS[paused]}${countedWords}`, notSentPaused: true, ...unkept };
  }
  if (!taken.ok) {
    // A count that could not be made: the endpoint is not called, the try is counted and waits on the published
    // schedule like a network failure, and after the last try the delivery is failed with the reason, its message
    // kept for a resend by hand; never tried again every five minutes for the week a delivery is kept (Claude 2 on
    // #3096, comment 6713512225, LOW 4; rule 30). A month whose deliveries are used is not tried again.
    if (taken.reason === "unknown" && delivery.type !== "test") {
      const retryIn = RETRY_MINUTES[next.attempts - 1];
      if (retryIn === undefined) return { ...next, ...counted, state: "failed", next: 0, lastStatus: 0, lastError: COUNT_UNREAD_FAILED_WORDS };
      return { ...next, ...counted, state: "retrying", next: now + retryIn * 60_000, lastStatus: 0, lastError: taken.message };
    }
    return { ...delivery, ...counted, state: "failed", next: 0, lastAt: now, lastStatus: 0, lastError: `Not sent. ${taken.message}`, ...unkept };
  }
  const timestamp = Math.floor(now / 1000);
  let status = 0;
  let error = "";
  try {
    const answer = await safeFetch(endpoint.url, {
      method: "POST",
      body: delivery.body,
      maxBytes: 16_384,
      timeoutMs: ATTEMPT_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Marktmorgen-Webhooks/1.0 (+https://marktmorgen.com)",
        "Marktmorgen-Event-Id": delivery.eventId,
        "Marktmorgen-Event-Type": delivery.type,
        "Marktmorgen-Delivery-Id": delivery.id,
        "Marktmorgen-Timestamp": String(timestamp),
        "Marktmorgen-Signature": signatureFor(endpoint, timestamp, delivery.body, now),
      },
      ...(hooksForTests.fetch ?? {}),
    });
    status = answer.status;
    if (status < 200 || status >= 300) error = `Answered ${status}.`;
  } catch (caught) {
    error = caught instanceof SafeFetchError ? problemWords(caught) : "The endpoint could not be reached.";
  }
  if (!error) return { ...next, ...counted, state: "delivered", next: 0, lastStatus: status, lastError: "" };
  const retryIn = delivery.type === "test" ? undefined : RETRY_MINUTES[next.attempts - 1];
  if (retryIn === undefined) return { ...next, ...counted, state: "failed", next: 0, lastStatus: status, lastError: error };
  return { ...next, ...counted, state: "retrying", next: now + retryIn * 60_000, lastStatus: status, lastError: error };
}

/**
 * Tries a delivery that this caller has claimed (taken off the queue), and
 * writes down how it went, putting it back on the queue for its next try.
 */
async function runClaimed(statsId: string, id: string, now = Date.now()): Promise<Delivery | null> {
  const [raw] = await redisPipeline([["GET", deliveryKey(id)]]);
  const delivery = parseDelivery(raw);
  if (!delivery || delivery.state === "delivered" || delivery.state === "failed") {
    await redisPipeline([["ZREM", QUEUE_KEY, `${statsId}|${id}`]]);
    return delivery;
  }
  const config = await readConfig(delivery.statsId);
  const endpoint = config?.endpoints.find((e) => e.id === delivery.endpoint);
  // A store that cannot be read just now (a Redis call that failed or timed out) is unknown, never "not found"
  // (CX-123 rule 24): the read throws, the delivery stays on the queue under its lease and is tried again when the
  // lease ends. Only a store that reads as gone (null) fails the delivery.
  const store = endpoint && config?.handle ? await storeForHandle(config.handle) : null;
  const done = await attempt(delivery, endpoint, store && store.statsId === delivery.statsId ? store : null, now);
  const commands: (string | number)[][] = [["SET", deliveryKey(id), JSON.stringify(done), "EX", DELIVERY_SECONDS]];
  commands.push(
    done.state === "retrying" ? ["ZADD", QUEUE_KEY, done.next, `${statsId}|${id}`] : ["ZREM", QUEUE_KEY, `${statsId}|${id}`],
  );
  await redisPipeline(commands);
  return done;
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

/** Takes a delivery that is due, for the length of a lease. Only the caller that took it tries it. */
async function claim(statsId: string, id: string, now = Date.now()): Promise<boolean> {
  const reply = await redisPipeline([["EVAL", LEASE_SCRIPT, 1, QUEUE_KEY, `${statsId}|${id}`, now, now + LEASE_MS]]);
  if (!Array.isArray(reply) || reply.length !== 1 || (reply[0] !== 0 && reply[0] !== 1)) {
    throw new Error("The webhook delivery lease was not acknowledged");
  }
  return reply[0] === 1;
}

/** Runs now, after the answer is sent when there is a request to wait for. */
function soon(task: () => Promise<unknown>): Promise<void> {
  try {
    after(() => task().catch((error) => console.error("a webhook delivery failed", error)));
    return Promise.resolve();
  } catch {
    // Outside a request (a script, a check): simply now.
    return task().then(
      () => undefined,
      (error) => console.error("a webhook delivery failed", error),
    );
  }
}

/**
 * Records that something happened, once, and sends it to every endpoint that
 * listens for it. `seed` names what it is about (a checkout, a refund), which
 * is what makes the event id the same however often it is noticed.
 */
export async function emitEvent(store: Store, type: WebhookEvent, seed: string, data: Record<string, unknown>, now = Date.now()): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const statsId = store.statsId;
  const config = await readConfig(statsId);
  // An endpoint whose API key is paused or revoked hears nothing (owner C3-100), read as the key is now; one whose
  // key cannot be read is queued and held by its try until it reads (liveEndpoints keepUnread).
  const listening = await liveEndpoints(store, config?.endpoints.filter((e) => e.events.includes(type)) ?? [], true);
  if (!listening.length) return 0;
  const eventId = eventIdFor(statsId, type, seed);
  const [fresh] = await redisPipeline([["SET", eventKey(eventId), "1", "NX", "EX", EVENT_SECONDS]]);
  if (fresh === null) return 0;

  // Every text cleaned and bounded where the message is made (cleanText), so what a delivery keeps is bounded.
  const body = JSON.stringify(cleanData({
    id: eventId,
    type,
    created: Math.floor(now / 1000),
    store: { handle: store.handle, name: store.name, url: `${SITE_URL}/@${store.handle}` },
    data,
  }));
  // Each delivery's id is made from the event and the endpoint, so writing
  // them again (after a reply that was lost) finds the same ones: SET NX
  // keeps what is there, the queue keeps its place (ZADD NX; a delivery
  // already sent is taken off it by runClaimed), and the log gets only what
  // it does not hold. Deleting the event's mark after a failure can then
  // never send it twice.
  const deliveries: Delivery[] = listening.map((endpoint) => ({
    id: `dlv_${createHash("sha256").update(`${eventId}|${endpoint.id}`).digest("hex").slice(0, 24)}`,
    statsId,
    endpoint: endpoint.id,
    eventId,
    type,
    body,
    attempts: 0,
    state: "queued",
    // Due at once; if the try below never happens, the job finds it.
    next: now,
    lastStatus: 0,
    lastError: "",
    lastAt: 0,
    createdAt: now,
  }));
  const ids = deliveries.map((d) => d.id);
  const kept = deliveries.map((d) => JSON.stringify(d));
  // A message is kept only when it can be counted: when the month's webhook deliveries are used, nothing is kept
  // or sent, and each endpoint's line says so (a count that cannot be read lets the try decide, as before). And it
  // is bounded where it is made: a message that would be kept past DELIVERY_WRITE_MAX_BYTES is never kept or sent
  // either. Every endpoint is sent the same message, so one too large is too large for all. Neither takes a
  // delivery of the month, and the lines of each are bounded by the day (skippedLines).
  // While the plan's costs are paused the try says so first (attempt), and takes the month's delivery then.
  const month = integrationPauseWord(store, now / 1000) ? null : await allowancesUsedStrict(store, ["webhook"], now).catch(() => null);
  const used = month?.[0] !== undefined && month[0].used >= month[0].figure;
  const tooLarge = !used && kept.some(tooLargeToKeep);
  if (used || tooLarge) {
    if (tooLarge) console.error("WEBHOOK MESSAGE TOO LARGE: its lines say so, nothing is sent", statsId, type, eventId, Buffer.byteLength(body));
    try {
      await skippedLines(statsId, deliveries, used ? "used" : "large", used ? `Not sent. ${allowanceUsedWords(store, "webhook", now)}` : TOO_LARGE_WORDS, now);
    } catch (error) {
      // As below: without its lines written the event would leave no trace; the mark goes, so it is noticed again.
      await redisPipeline([["DEL", eventKey(eventId)]]).catch((lost) =>
        console.error("WEBHOOK EVENT LOST: its lines could not be written and its sent mark could not be taken back", statsId, type, eventId, lost));
      throw error;
    }
    return 0;
  }
  const writes = ids.map((id, at) => ["SET", deliveryKey(id), kept[at], "NX", "EX", DELIVERY_SECONDS]);
  try {
    const replies = await redisPipeline(writes);
    await redisPipeline(ids.map((id) => ["ZADD", QUEUE_KEY, "NX", now, `${statsId}|${id}`]));
    // Queued either way, so a line that did land is still tried (runClaimed takes one that is not there off the
    // queue); a write answered in another shape throws below, and the mark goes, so the event is written again.
    const written = linesWritten(replies, ids.length, true);
    await pushMissing(statsId, ids.filter((_, at) => !written[at]), ids.filter((_, at) => written[at]));
  } catch (error) {
    // The event is marked sent above; without its deliveries written it
    // would never be: the mark goes, so the next time it is noticed it is
    // written again, to the same deliveries.
    await redisPipeline([["DEL", eventKey(eventId)]]).catch((lost) =>
      console.error("WEBHOOK EVENT LOST: its deliveries could not be written and its sent mark could not be taken back", statsId, type, eventId, lost));
    throw error;
  }
  // Each delivery on its own: one whose first try throws stays on the queue for deliverDue (its lease, or its
  // place, brings it back), and the endpoints after it are still sent now (Claude 2 on #3096).
  await soon(async () => {
    for (const id of ids) {
      try {
        if (await claim(statsId, id)) await runClaimed(statsId, id);
      } catch (error) {
        console.error("a webhook delivery failed", statsId, id, error);
      }
    }
  });
  return ids.length;
}

/**
 * Tries every delivery that is due, for the five-minute job: at most
 * MAX_RETRIES_PER_RUN, ten at a time, and none started after the deadline.
 */
export async function deliverDue(deadline: number, now = Date.now()): Promise<{ tried: number; delivered: number }> {
  const counts = { tried: 0, delivered: 0 };
  if (!isRedisConfigured()) return counts;
  const reply = await redisPipeline([["ZRANGEBYSCORE", QUEUE_KEY, "-inf", now, "LIMIT", 0, MAX_RETRIES_PER_RUN]]);
  const due = Array.isArray(reply) && reply.length === 1 ? reply[0] : null;
  if (!Array.isArray(due) || due.length > MAX_RETRIES_PER_RUN || due.some(member => typeof member !== "string" || member.length === 0) || new Set(due).size !== due.length) {
    throw new Error("The webhook due queue is not a complete bounded observation");
  }
  const members = due as string[];
  for (let i = 0; i < members.length && Date.now() < deadline; i += 10) {
    await Promise.all(
      members.slice(i, i + 10).map(async (member) => {
        const [statsId, id] = member.split("|");
        if (!statsId || !DELIVERY_ID_PATTERN.test(id ?? "")) {
          await redisPipeline([["ZREM", QUEUE_KEY, member]]);
          return;
        }
        if (!(await claim(statsId, id, now))) return;
        counts.tried += 1;
        const done = await runClaimed(statsId, id).catch((error) => {
          console.error("a webhook retry failed", error);
          return null;
        });
        if (done?.state === "delivered") counts.delivered += 1;
      }),
    );
  }
  return counts;
}

// ---- The studio ---------------------------------------------------------------

/**
 * What the studio sees of an endpoint: never a secret, only until when the old one still signs. `keyState: "unknown"`:
 * an API key added it and that key's state could not be read just now, so it is shown as neither sent to nor held.
 */
export type EndpointView = { id: string; where: string; events: WebhookEvent[]; addedAt: string; oldSecretUntil?: string; held?: EndpointHeld; keyState?: "unknown" };
export type DeliveryView = Pick<Delivery, "id" | "eventId" | "type" | "state" | "attempts" | "next" | "lastStatus" | "lastError" | "lastAt" | "createdAt" | "notSentPaused" | "resentFrom" | "resentAs" | "givenUp"> & {
  endpoint: string;
};
export type WebhooksView = { endpoints: EndpointView[]; log: DeliveryView[] };

export async function webhooksView(store: Store): Promise<WebhooksView> {
  if (!store.statsId || !isRedisConfigured()) return { endpoints: [], log: [] };
  const [rawConfig, rawLog] = await redisPipeline([
    ["GET", cfgKey(store.statsId)],
    ["LRANGE", logKey(store.statsId), 0, LOG_SIZE - 1],
  ]);
  const config = parseConfig(rawConfig);
  const ids = Array.isArray(rawLog) ? (rawLog as unknown[]).map(String).filter((id) => DELIVERY_ID_PATTERN.test(id)) : [];
  const deliveries = ids.length ? await redisPipeline(ids.map((id) => ["GET", deliveryKey(id)])) : [];
  const names = new Map((config?.endpoints ?? []).map((e) => [e.id, shortAddress(e.url)]));
  const keyed = (config?.endpoints ?? []).filter((e) => e.key);
  // Each key on its own when they cannot all be read (LOW 3 of #3096, rule 24): an endpoint whose key's state, or the
  // team record, does not read is marked unknown on its own row, and the rest of the view, its failed deliveries and
  // their resend with it, is still shown. Whatever stopped the read, the state is unknown, never live or held.
  const { states, unread } = keyed.length
    ? await eachKeyState(store.sid ?? "", keyed.map((e) => e.key as string), () => true)
    : { states: new Map<string, string>(), unread: new Set<string>() };
  if (unread.size) console.error("WEBHOOK KEY STATE UNREAD: these endpoints are shown as state unknown", store.sid, [...unread]);
  const heldOf = (e: Endpoint): EndpointHeld | null =>
    !e.key || unread.has(e.key) ? null : states.get(e.key) === "live" ? null : states.get(e.key) === "paused" ? "paused" : "revoked";
  return {
    endpoints: (config?.endpoints ?? []).map((e) => ({
      id: e.id,
      where: shortAddress(e.url),
      events: e.events,
      addedAt: e.addedAt,
      ...(e.previous && e.previousUntil ? { oldSecretUntil: new Date(e.previousUntil).toISOString() } : {}),
      ...(heldOf(e) ? { held: heldOf(e) as EndpointHeld } : {}),
      ...(e.key && unread.has(e.key) ? { keyState: "unknown" as const } : {}),
    })),
    log: deliveries
      .map(parseDelivery)
      .filter((d): d is Delivery => d !== null)
      .map((d) => ({
        id: d.id,
        eventId: d.eventId,
        type: d.type,
        state: d.state,
        attempts: d.attempts,
        next: d.next,
        lastStatus: d.lastStatus,
        lastError: d.lastError,
        lastAt: d.lastAt,
        createdAt: d.createdAt,
        ...(d.notSentPaused === true ? { notSentPaused: true as const } : {}),
        ...(d.givenUp === true ? { givenUp: true as const } : {}),
        ...(typeof d.resentFrom === "string" && DELIVERY_ID_PATTERN.test(d.resentFrom) ? { resentFrom: d.resentFrom } : {}),
        ...(typeof d.resentAs === "string" && DELIVERY_ID_PATTERN.test(d.resentAs) ? { resentAs: d.resentAs } : {}),
        endpoint: names.get(d.endpoint) ?? "a removed endpoint",
      })),
  };
}

/** Most messages recentMessages gives back. */
export const RECENT_MESSAGES_MAX = 10;

/** How many messages a reading of the recent events gives back for the `limit` asked: one to RECENT_MESSAGES_MAX. */
export function recentLimit(limit: number): number {
  return Math.max(1, Math.min(RECENT_MESSAGES_MAX, Number.isFinite(limit) ? Math.floor(limit) : 3));
}

/**
 * The store's last LOG_SIZE deliveries and how many bytes each is kept at
 * (STRLEN), looked up before they are read by a reading that pays for what
 * it reads (lib/api-read.ts, recentEvents); `logBytes` is what the log
 * itself answered. Null when a size did not come back.
 */
export async function recentDeliverySizes(store: Store): Promise<{ ids: string[]; logBytes: number; sizes: number[] } | null> {
  if (!store.statsId || !isRedisConfigured()) return { ids: [], logBytes: 0, sizes: [] };
  const [rawLog] = await redisPipeline([["LRANGE", logKey(store.statsId), 0, LOG_SIZE - 1]]);
  // A log that is not a list of delivery ids is unknown, never an empty log (Codex G on #2192, C3-124): one item that
  // is not an id makes it so, and is never dropped in silence. Nothing is read or paid for, and the request answers as
  // unavailable.
  if (!Array.isArray(rawLog) || !(rawLog as unknown[]).every((id) => typeof id === "string" && DELIVERY_ID_PATTERN.test(id))) return null;
  const ids = rawLog as string[];
  const logBytes = ids.reduce((n, id) => n + Buffer.byteLength(id), 0);
  if (!ids.length) return { ids, logBytes, sizes: [] };
  // One size for every delivery, each a whole number of bytes: a partial or malformed answer would set aside less
  // than the deliveries then read, so it is unknown, before any delivery is read and before any unit is taken.
  const replies: unknown = await redisPipeline(ids.map((id) => ["STRLEN", deliveryKey(id)]));
  if (!Array.isArray(replies) || replies.length !== ids.length) return null;
  const sizes: number[] = [];
  for (const reply of replies as unknown[]) {
    const n = typeof reply === "number" ? reply : typeof reply === "string" && /^\d{1,15}$/.test(reply) ? Number(reply) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < 0) return null;
    sizes.push(n);
  }
  return { ids, logBytes, sizes };
}

/**
 * The most a delivery measured at `size` bytes can be when it is read a moment
 * later: what its tries may still write on it (DELIVERY_UPDATE_ROOM_BYTES), never
 * past DELIVERY_MAX_BYTES; nothing for one that was not there (Codex G2, #2192:
 * an ordinary try between the measuring and the reading grew it past what was
 * set aside).
 */
export function deliveryReadBound(size: number): number {
  return size > 0 ? Math.min(DELIVERY_MAX_BYTES, size + DELIVERY_UPDATE_ROOM_BYTES) : 0;
}

/** Inside READ_DELIVERIES, at the most, each delivery: its size, then the delivery (billed one by one beside the EVAL). */
export const READ_DELIVERIES_CALLS_EACH = 2;

/**
 * Reads the deliveries KEYS each only while it is no larger than its bound
 * (ARGV, in bytes): {1, values} with each value or nothing for one that is
 * gone; {0} as soon as one is larger, with nothing of it sent back. So what
 * a reading takes out of the database is never more than what it set aside.
 * Modelled by lib/redis-memory.ts.
 */
export const READ_DELIVERIES = `-- marktmorgen:webhook-deliveries-read:v1
local out = {}
for i = 1, #KEYS do
  local n = redis.call('STRLEN', KEYS[i])
  if n > tonumber(ARGV[i]) then return {0} end
  if n > 0 then out[i] = redis.call('GET', KEYS[i]) else out[i] = false end
end
return {1, out}`;

/** A reading of the deliveries whose answer did not come back whole, or one of which was larger than set aside. */
export class DeliveriesUnreadable extends Error {
  constructor() {
    super("the recent deliveries could not be read within what was set aside");
  }
}

/**
 * The messages of one event among the deliveries `ids` (the store's log, as
 * recentDeliverySizes read it), newest first, each once, at most `most`; and
 * the bytes the deliveries were read at, which a reading that pays for them
 * settles at. Each delivery is read only up to its bound (READ_DELIVERIES),
 * and the answer only as it is exactly: a value or nothing for each, never a
 * missing or extra one. Anything else, or a delivery larger than its bound,
 * is DeliveriesUnreadable, never an empty history (Codex G2, #2192).
 */
export async function recentMessagesOf(store: Store, type: WebhookEvent, ids: string[], bounds: readonly number[], most: number): Promise<{ messages: Record<string, unknown>[]; readBytes: number }> {
  if (!store.statsId || !ids.length || !isRedisConfigured()) return { messages: [], readBytes: 0 };
  if (bounds.length !== ids.length || bounds.some((b) => !Number.isSafeInteger(b) || b < 0)) throw new DeliveriesUnreadable();
  const reply: unknown = await redisPipeline([["EVAL", READ_DELIVERIES, ids.length, ...ids.map(deliveryKey), ...bounds.map(String)]]);
  const answer = Array.isArray(reply) && reply.length === 1 ? reply[0] : undefined;
  if (!Array.isArray(answer) || answer[0] !== 1 || answer.length !== 2 || !Array.isArray(answer[1])) throw new DeliveriesUnreadable();
  const raws = answer[1] as unknown[];
  // One value or nothing for each delivery, as long as its bound: a missing, extra or other answer is not a history.
  if (raws.length !== ids.length || raws.some((raw, i) => raw !== null && (typeof raw !== "string" || Buffer.byteLength(raw) > bounds[i]))) throw new DeliveriesUnreadable();
  const readBytes = raws.reduce((n: number, raw) => n + (typeof raw === "string" ? Buffer.byteLength(raw) : 0), 0);
  const seen = new Set<string>();
  const messages: Record<string, unknown>[] = [];
  for (const delivery of raws.map(parseDelivery)) {
    if (messages.length >= most) break;
    if (!delivery || delivery.type !== type || delivery.statsId !== store.statsId || seen.has(delivery.eventId)) continue;
    seen.add(delivery.eventId);
    try {
      messages.push(JSON.parse(delivery.body) as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return { messages, readBytes };
}

/**
 * The store's recent messages of one event, newest first, each once, as they
 * were sent: read from its last LOG_SIZE deliveries, each kept a week. What a
 * tool such as Zapier shows the creator as an example while they set a step
 * up, so it is only what already left the store; nothing new is read. The
 * API reads them paid for first (lib/api-read.ts, recentEvents).
 */
export async function recentMessages(store: Store, type: WebhookEvent, limit = 3): Promise<Record<string, unknown>[]> {
  if (!store.statsId || !isRedisConfigured()) return [];
  const [rawLog] = await redisPipeline([["LRANGE", logKey(store.statsId), 0, LOG_SIZE - 1]]);
  const ids = Array.isArray(rawLog) ? (rawLog as unknown[]).map(String).filter((id) => DELIVERY_ID_PATTERN.test(id)) : [];
  // Not paid for by the size: every delivery read whole, as before (a failed one kept before DELIVERY_MAX_BYTES may be larger).
  return (await recentMessagesOf(store, type, ids, ids.map(() => Number.MAX_SAFE_INTEGER), recentLimit(limit))).messages;
}

/** Whether a word is one of the events an endpoint can hear. */
export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return isEvent(value);
}

export type AddEndpointResult =
  | { ok: true; secret: string; view: WebhooksView }
  | { ok: false; reason: "full" | "invalid" | "events" | "duplicate" | "unavailable" | "paused"; message: string };

/**
 * Adds an endpoint. Its secret is made here and returned this once; the
 * studio never shows it again. The address is checked now (https, a public
 * host) and again at every send, since what a name points to can change.
 */
export async function addEndpoint(store: Store, rawUrl: string, events: unknown, now = Date.now(), byKey = ""): Promise<AddEndpointResult> {
  if (!store.statsId) return { ok: false, reason: "invalid", message: "Open the studio once more and try again." };
  // 232 [CA1] 4b4b2: a new endpoint is new delivery work; it waits while the plan's costs are paused.
  const paused = integrationPauseWord(store, now / 1000);
  if (paused) return { ok: false, reason: "paused", message: WEBHOOK_ADD_PAUSED_WORDS[paused] };
  const chosen = Array.isArray(events) ? [...new Set(events.filter(isEvent))] : [];
  if (!chosen.length) return { ok: false, reason: "events", message: "Choose at least one event to send." };
  if (rawUrl.trim().length > MAX_ENDPOINT_URL) return { ok: false, reason: "invalid", message: "That address is too long." };
  let url: string;
  try {
    const parsed = checkUrl(rawUrl);
    if (/^webcals?:/i.test(rawUrl.trim())) throw new SafeFetchError("scheme", "Only https:// addresses are accepted.");
    url = parsed.toString();
  } catch (error) {
    return { ok: false, reason: "invalid", message: problemWords(error) };
  }
  const config = (await readConfig(store.statsId)) ?? { handle: store.handle, endpoints: [], since: Math.floor(now / 1000) };
  if (config.endpoints.length >= MAX_ENDPOINTS) return { ok: false, reason: "full", message: `A store can have ${MAX_ENDPOINTS} endpoints. Remove one first.` };
  if (config.endpoints.some((e) => e.url === url)) return { ok: false, reason: "duplicate", message: "That endpoint is already added." };
  // Adding an endpoint creates new future delivery work. Removing an existing
  // endpoint remains on its retained cleanup path below.
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) {
    return { ok: false, reason: "unavailable", message: "The endpoint could not be added just now. Try again in a moment." };
  }
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const endpoint: Endpoint = {
    id: `we_${randomBytes(8).toString("hex")}`,
    url,
    secret,
    events: chosen,
    addedAt: new Date(now).toISOString(),
    // Which API key added it, so the endpoint pauses and stops with that key (owner C3-100).
    ...(KEY_ID_PATTERN.test(byKey) ? { key: byKey } : {}),
  };
  // The Stripe pass starts from now for a store's first endpoint: nothing
  // that happened before it was added is sent to it. Checked again on the
  // settings as they are when written, in case another change landed first.
  let refused: AddEndpointResult | null = null;
  const written = await changeConfig(store.statsId, (fresh) => {
    const current = fresh ?? { handle: store.handle, endpoints: [], since: Math.floor(now / 1000) };
    if (current.endpoints.length >= MAX_ENDPOINTS) refused = { ok: false, reason: "full", message: `A store can have ${MAX_ENDPOINTS} endpoints. Remove one first.` };
    else if (current.endpoints.some((e) => e.url === url)) refused = { ok: false, reason: "duplicate", message: "That endpoint is already added." };
    if (refused) return null;
    return { handle: store.handle, endpoints: [...current.endpoints, endpoint], since: current.endpoints.length ? current.since : Math.floor(now / 1000) };
  });
  if (!written) return refused ?? { ok: false, reason: "unavailable", message: "The endpoint could not be added just now. Try again in a moment." };
  await redisPipeline([
    ["SADD", STORES_KEY, store.statsId],
    ...(written.before?.endpoints.length ? [] : [["DEL", anchorKey(store.statsId)], ["DEL", waitKey(store.statsId)]]),
  ]);
  return { ok: true, secret, view: await webhooksView(store) };
}

/** Changes which events an endpoint hears. */
export async function setEndpointEvents(store: Store, id: string, events: unknown): Promise<WebhooksView | "events" | "missing" | "unavailable"> {
  if (!store.statsId) return "missing";
  const chosen = Array.isArray(events) ? [...new Set(events.filter(isEvent))] : [];
  if (!chosen.length) return "events";
  const config = await readConfig(store.statsId);
  const endpoint = config?.endpoints.find((e) => e.id === id);
  if (!config || !endpoint) return "missing";
  // A subset removes future work; adding a new event creates a new obligation.
  // Keep retained event removal available without a fresh admission.
  if (chosen.some(event => !endpoint.events.includes(event)) && store.period?.funded === true && !(await reservePaidResourceWindow(store))) return "unavailable";
  const written = await changeConfig(store.statsId, (fresh) =>
    fresh && fresh.endpoints.some((e) => e.id === id) ? { ...fresh, handle: store.handle, endpoints: fresh.endpoints.map((e) => (e.id === id ? { ...e, events: chosen } : e)) } : null,
  );
  if (!written) return "missing";
  return webhooksView(store);
}

export type RotateSecretResult = { ok: true; secret: string; oldSecretUntil: string; view: WebhooksView } | { ok: false; reason: "missing" };

/**
 * Replaces an endpoint's signing secret (378 [TB4]). The new one is made here
 * and returned this once, like the first; the one it replaces keeps signing
 * beside it for ROTATION_HOURS, so the creator has a day to paste the new one
 * into the receiver, and then is dropped. Replacing it again within that day
 * keeps only the newest two: the oldest stops at once. No delivery is sent or
 * counted, and no new work is made, so it never waits on a plan's allowance.
 */
export async function rotateSecret(store: Store, id: string, now = Date.now()): Promise<RotateSecretResult> {
  if (!store.statsId) return { ok: false, reason: "missing" };
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const previousUntil = now + ROTATION_HOURS * 3_600_000;
  // Over the settings as they are when written, so the secret replaced is the one in force then.
  const written = await changeConfig(store.statsId, (fresh) => {
    const endpoint = fresh?.endpoints.find((e) => e.id === id);
    if (!fresh || !endpoint) return null;
    return { ...fresh, handle: store.handle, endpoints: fresh.endpoints.map((e) => (e.id === id ? { ...e, secret, previous: endpoint.secret, previousUntil } : withoutStalePrevious(e, now))) };
  });
  if (!written) return { ok: false, reason: "missing" };
  return { ok: true, secret, oldSecretUntil: new Date(previousUntil).toISOString(), view: await webhooksView(store) };
}

/** The endpoints the given API keys added, as the review before the team's two-step switch counts them. */
export async function endpointsOfKeys(store: Store, keyIds: string[]): Promise<{ id: string; key: string; where: string }[]> {
  if (!store.statsId || !keyIds.length || !isRedisConfigured()) return [];
  const config = await readConfig(store.statsId);
  return (config?.endpoints ?? []).filter((e) => e.key && keyIds.includes(e.key)).map((e) => ({ id: e.id, key: e.key as string, where: shortAddress(e.url) }));
}

/** Removes an endpoint. Anything still waiting to be sent to it is dropped at its next try. */
export async function removeEndpoint(store: Store, id: string): Promise<WebhooksView> {
  if (!store.statsId) return { endpoints: [], log: [] };
  const written = await changeConfig(store.statsId, (fresh) =>
    fresh && fresh.endpoints.some((e) => e.id === id) ? { ...fresh, handle: store.handle, endpoints: fresh.endpoints.filter((e) => e.id !== id) } : null,
  );
  if (written && !written.after.endpoints.length) await redisPipeline([["SREM", STORES_KEY, store.statsId]]);
  // Its sets of passed-over events, today's and yesterday's (none older is kept).
  if (written) {
    const today = Math.floor(Date.now() / 86_400_000);
    // The removal worked; sets that could not be deleted now expire by themselves within two days.
    await redisPipeline([["DEL", givenUpDayKey(store.statsId, today, id)], ["DEL", givenUpDayKey(store.statsId, today - 1, id)]])
      .catch((error) => console.error("deleting a removed endpoint's sets of passed-over events failed; they expire by themselves", store.handle, id, error));
  }
  return webhooksView(store);
}

export type ResendResult =
  | { ok: true; delivery: Delivery; view: WebhooksView }
  | { ok: false; reason: "missing" | "not_failed" | "not_heard" | "resent" | "limited" | "unavailable" }
  | { ok: false; reason: "used" | "paused" | "too_large"; message: string };

/**
 * Sends a failed delivery again, once, now, because the creator asked from
 * the log (378 [TB4] unit 3). Only a delivery that failed for good, of this
 * store, to an endpoint it still has: a delivered one is never sent twice by
 * hand. The message is the same message, with the same event id, so a
 * receiver that already took it drops the repeat; it is signed afresh, with
 * the endpoint's secrets as they are now. It is a new line in the log that
 * names the one it sends again, tried once and not put back on the schedule.
 * Like a test it is one of the store's webhook deliveries for its month,
 * taken before the endpoint is called, and it shares the tests' limit a
 * minute, so a press held down cannot hammer anybody.
 */
export async function resendDelivery(store: Store, deliveryId: string, now = Date.now()): Promise<ResendResult> {
  if (!store.statsId || !DELIVERY_ID_PATTERN.test(deliveryId)) return { ok: false, reason: "missing" };
  const statsId = store.statsId;
  // Paused like a test while the plan's costs are paused, whoever calls this.
  const paused = integrationPauseWord(store, now / 1000);
  if (paused) return { ok: false, reason: "paused", message: WEBHOOK_TEST_PAUSED_WORDS[paused] };
  // Read exactly (CX-123 rule 24), before anything is marked: the delivery is text or GET null, its time left a whole
  // number (PTTL -2 gone, -1 none); any other shape could not be read, and nothing is marked, taken or sent.
  const read = repliesFor(await redisPipeline([["GET", deliveryKey(deliveryId)], ["PTTL", deliveryKey(deliveryId)]]), 2);
  if (!read || (read[0] !== null && typeof read[0] !== "string") || typeof read[1] !== "number" || !Number.isSafeInteger(read[1])) return { ok: false, reason: "unavailable" };
  const [raw, ttl] = read as [string | null, number];
  const before = parseDelivery(raw);
  // A line left by a Stripe event that was passed over carries no message to send.
  if (typeof raw !== "string" || !before || before.statsId !== statsId || before.type === "test" || before.givenUp) return { ok: false, reason: "missing" };
  if (before.state !== "failed") return { ok: false, reason: "not_failed" };
  // A copy sent by hand is never sent again itself: the original is, so one event has one line of resends.
  if (before.resentFrom) return { ok: false, reason: "resent" };
  // Sent again once: while the last resend is delivered or still being tried, not again.
  if (before.resentAs) {
    // Only GET null is a last resend that is gone; one in another shape, or text that is not a delivery, is unknown
    // and never taken as gone, so it is not sent again on it (CX-123 rule 24).
    const lastRead = repliesFor(await redisPipeline([["GET", deliveryKey(before.resentAs)]]), 1);
    if (!lastRead || (lastRead[0] !== null && typeof lastRead[0] !== "string")) return { ok: false, reason: "unavailable" };
    const last = lastRead[0] === null ? null : parseDelivery(lastRead[0]);
    if (lastRead[0] !== null && !last) return { ok: false, reason: "unavailable" };
    if (last && last.state !== "failed") return { ok: false, reason: "resent" };
  }
  // A message kept before the bound, larger than it, is not kept again by hand.
  if (tooLargeToKeep(JSON.stringify({ ...before, attempts: 0, state: "queued", next: 0, lastStatus: 0, lastError: "", lastAt: 0, resentFrom: before.id, resentAs: undefined }))) {
    return { ok: false, reason: "too_large", message: TOO_LARGE_WORDS };
  }
  const config = await readConfig(statsId);
  const endpoint = config?.endpoints.find((e) => e.id === before.endpoint);
  if (!endpoint) return { ok: false, reason: "missing" };
  // An endpoint that no longer hears this kind of event is not sent it, by hand either.
  if (!(endpoint.events as string[]).includes(before.type)) return { ok: false, reason: "not_heard" };
  // Its API key paused or revoked (owner C3-100): refused before anything is marked, counted or taken.
  const keyHeld = await heldNow(store, endpoint);
  if (keyHeld) return { ok: false, reason: "paused", message: HELD_WORDS[keyHeld] };
  const againId = `dlv_${randomBytes(12).toString("hex")}`;
  // Two presses at once: only the one that marks the original first goes on (COMPARE_AND_SET over the text read).
  // A press refused below (the minute's limit, the month's deliveries) leaves a mark naming nothing, which allows the next.
  // The mark read exactly (rules 24 and 30): [-1] / [-1, n] is another press first ("resent"); any other reply is
  // unknown, never marked: nothing is taken or sent, and it could not be sent just now. A mark that did land names a
  // resend that was never written, which reads as gone and allows the next press.
  let marked: "saved" | "changed";
  try {
    marked = compareAndSetReply(await redisPipeline([["EVAL", COMPARE_AND_SET, 1, deliveryKey(deliveryId), raw, JSON.stringify({ ...before, resentAs: againId })]]), "a webhook resend's mark");
  } catch (error) {
    if (!(error instanceof UnknownReplyError)) throw error;
    return { ok: false, reason: "unavailable" };
  }
  if (marked !== "saved") return { ok: false, reason: "resent" };
  // The write cleared the original's expiry; it keeps the time it had left, never more.
  await redisPipeline([["PEXPIRE", deliveryKey(deliveryId), ttl > 0 ? ttl : DELIVERY_SECONDS * 1000]]);
  const tests = repliesFor(await redisPipeline([
    ["SET", testsKey(statsId), "0", "EX", 60, "NX"],
    ["INCR", testsKey(statsId)],
  ]), 2);
  // A count in any other shape is unknown (CX-123 rule 24): the endpoint is not called on it.
  const count = countOf(tests?.[1]);
  if (count === null || count > TESTS_PER_MINUTE) return { ok: false, reason: "limited" };
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return { ok: false, reason: "unavailable" };
  const taken = await takeAllowance(store, "webhook", 1, now);
  if (!taken.ok) return { ok: false, reason: "used", message: taken.message };
  const again: Delivery = {
    id: againId,
    statsId,
    endpoint: endpoint.id,
    eventId: before.eventId,
    type: before.type,
    body: before.body,
    attempts: 0,
    state: "queued",
    next: 0,
    lastStatus: 0,
    lastError: "",
    lastAt: 0,
    createdAt: now,
    resentFrom: before.id,
  };
  const tried = await attempt(again, endpoint, "taken", now);
  // Tried once, by hand: a failure is shown, never put back on the schedule.
  const done: Delivery = tried.state === "retrying" ? { ...tried, state: "failed", next: 0 } : tried;
  await redisPipeline([
    ["SET", deliveryKey(done.id), JSON.stringify(done), "EX", DELIVERY_SECONDS],
    ["LPUSH", logKey(statsId), done.id],
    ["LTRIM", logKey(statsId), 0, LOG_SIZE - 1],
  ]);
  return { ok: true, delivery: done, view: await webhooksView(store) };
}

/**
 * Sends one test message to one endpoint, now, and says how it went. Tried
 * once, never retried, and listed with the rest.
 */
export async function sendTest(store: Store, id: string, now = Date.now()): Promise<{ ok: true; delivery: Delivery; view: WebhooksView } | { ok: false; reason: "missing" | "limited" | "unavailable" } | { ok: false; reason: "used" | "held"; message: string }> {
  if (!store.statsId) return { ok: false, reason: "missing" };
  const statsId = store.statsId;
  const config = await readConfig(statsId);
  const endpoint = config?.endpoints.find((e) => e.id === id);
  if (!endpoint) return { ok: false, reason: "missing" };
  // Its API key paused or revoked (owner C3-100): refused before anything is counted or taken.
  const keyHeld = await heldNow(store, endpoint);
  if (keyHeld) return { ok: false, reason: "held", message: HELD_WORDS[keyHeld] };
  const tests = repliesFor(await redisPipeline([
    ["SET", testsKey(statsId), "0", "EX", 60, "NX"],
    ["INCR", testsKey(statsId)],
  ]), 2);
  // A count in any other shape is unknown (CX-123 rule 24): the endpoint is not called on it.
  const count = countOf(tests?.[1]);
  if (count === null || count > TESTS_PER_MINUTE) return { ok: false, reason: "limited" };
  // This is new, manually requested work, not an already queued delivery.
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return { ok: false, reason: "unavailable" };
  // A test is one of the store's webhook deliveries too: refused, it is not made at all.
  const taken = await takeAllowance(store, "webhook", 1, now);
  if (!taken.ok) return { ok: false, reason: "used", message: taken.message };
  const eventId = eventIdFor(statsId, "test", randomBytes(8).toString("hex"));
  const body = JSON.stringify({
    id: eventId,
    type: "test",
    created: Math.floor(now / 1000),
    store: { handle: store.handle, name: store.name, url: `${SITE_URL}/@${store.handle}` },
    data: { message: "A test from your Marktmorgen studio. Nothing happened in your store." },
  });
  const delivery: Delivery = {
    id: `dlv_${randomBytes(12).toString("hex")}`,
    statsId,
    endpoint: endpoint.id,
    eventId,
    type: "test",
    body,
    attempts: 0,
    state: "queued",
    next: 0,
    lastStatus: 0,
    lastError: "",
    lastAt: 0,
    createdAt: now,
  };
  const done = await attempt(delivery, endpoint, "taken", now);
  await redisPipeline([
    ["SET", deliveryKey(done.id), JSON.stringify(done), "EX", DELIVERY_SECONDS],
    ["LPUSH", logKey(statsId), done.id],
    ["LTRIM", logKey(statsId), 0, LOG_SIZE - 1],
  ]);
  return { ok: true, delivery: done, view: await webhooksView(store) };
}

// ---- Reading Stripe for what happened there ---------------------------------

type StripeEvent = { id?: unknown; type?: unknown; created?: unknown; data?: { object?: Record<string, unknown>; previous_attributes?: Record<string, unknown> } };

const STRIPE_TYPES = [
  "checkout.session.completed",
  "payment_intent.succeeded",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "charge.dispute.created",
];

/** Our events read from the creator's Stripe account, so a store listening for any of them has its account watched. */
const FROM_STRIPE: readonly WebhookEvent[] = ["sale.completed", "membership.started", "membership.canceled", "refund.issued", "membership.changed", "dispute.opened"];

/** Which of the Stripe-read events an endpoint of this store listens for. */
function wantsStripe(config: Pick<Config, "endpoints">): boolean {
  return config.endpoints.some((e) => e.events.some((t) => FROM_STRIPE.includes(t)));
}

const iso = (seconds: unknown) => (typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000).toISOString() : null);
const str = (value: unknown) => (typeof value === "string" && value ? value : null);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Calls to the creator's Stripe account one store's run of the five-minute
 * job may make to tell whose a refunded charge is and to read a canceled
 * member's address (`left`), and, a budget of their own, whose a disputed
 * payment is (`disputes`). Every call counts, so a membership's charge, three
 * calls, uses three: the job asks no more of Stripe per run than before.
 */
export const STRIPE_LOOKUPS_PER_STORE = 10;
export const DISPUTE_LOOKUPS_PER_STORE = 10;
type Budget = "left" | "disputes";
/** The run's lookups left, and the Stripe event whose payment was last confirmed as the store's (for its line, if it is passed over). */
type Lookups = { left: number; disputes: number; confirmed?: string };

/**
 * The lookups below are read in one pinned API version (STRIPE_VERSION of
 * lib/stripe-connect.ts), whatever the creator's account defaults to: in it
 * a payment names no invoice (Stripe moved that to the invoice payments in
 * 2025) and an invoice keeps its subscription's metadata under
 * `parent.subscription_details`.
 */

/** The metadata of the subscription an invoice is for, where either of Stripe's API versions keeps it (as lib/stats.ts reads it). */
function invoiceMeta(invoice: Record<string, unknown>): Record<string, string> {
  const parent = invoice.parent as { subscription_details?: { metadata?: unknown } | null } | null | undefined;
  const newer = parent?.subscription_details?.metadata;
  const older = (invoice.subscription_details as { metadata?: unknown } | null | undefined)?.metadata;
  const meta = (newer && typeof newer === "object" ? newer : older && typeof older === "object" ? older : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(meta).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

class OutOfLookups extends Error {}
/** An answer from Stripe in a shape this file does not know: asking again gets the same. */
class StripeShapeError extends Error {}

/**
 * Why an event could not be done with in this visit: "spent", the visit's
 * lookups ran out (not a failure, never a reason to give up); "refused",
 * Stripe will answer the same way again (STRIPE_REFUSED_RUNS); "passing",
 * a failure of Stripe's that may clear, an error status or no answer
 * (STRIPE_WAIT_RUNS, STRIPE_WAIT_MAX_SECONDS); "ours", our own code failed
 * (a setting missing, an answer in a shape it did not expect, the store),
 * waited on as long as a passing failure and said as ours.
 */
type Waits = "spent" | "refused" | "passing" | "ours";
/** True once an event is done with, or why it waits. */
type Outcome = true | Waits;

/** How a failed Stripe call waits. */
function waitsOn(error: unknown): Waits {
  if (error instanceof StripeError) return error.status >= 400 && error.status < 500 && error.status !== 429 && error.status !== 409 ? "refused" : "passing";
  // No answer: the network failed or the call ran out of time (lib/fetch-timeout.ts gives up with this TypeError);
  // or an answer that is not JSON at all (an error page in front of Stripe), which onAccount cannot read.
  if (error instanceof TypeError && error.message === "fetch failed") return "passing";
  if (error instanceof SyntaxError) return "passing";
  return "ours";
}

/** Said once a run's budget is spent: the event waits for the next run, never silently. */
function saySpent(store: Store, budget: Budget): void {
  console.error(budget === "disputes"
    ? "a store had more disputes in one run than are read; the rest wait for the next run"
    : "a store had more refunds and cancellations to look up in one run than are read; the rest wait for the next run", store.handle);
}

/** Stripe's answer that the object asked for does not exist: asking again would not change it. */
const isMissing = (error: unknown) => error instanceof StripeError && error.code === "resource_missing";

/**
 * The metadata that tells whose a payment is: the payment's own, which a
 * one-off checkout writes (payment_intent_data); or, when it carries no
 * store, its subscription's, which a membership's or a payment plan's
 * checkout writes only there (subscription_data, lib/store-checkout.ts), read
 * off the invoice the payment paid. At most three calls, each taken from
 * the run's `budget`. {} when Stripe says there is no such payment or
 * invoice (resource_missing: nothing to send); otherwise why it could not be
 * told now (Waits): the budget is used up, or a call failed in any other
 * way. The caller then leaves the event for the next run.
 */
async function paymentMeta(store: Store, intent: string, lookups: Lookups, budget: Budget): Promise<Record<string, string> | Waits> {
  const account = store.stripeAccountId;
  if (!account) return {};
  const get = async (path: string) => {
    if (lookups[budget] <= 0) throw new OutOfLookups();
    lookups[budget] -= 1;
    return onAccount("GET", account, path, undefined, STRIPE_VERSION);
  };
  try {
    const payment = await get(`/payment_intents/${encodeURIComponent(intent)}`);
    const own = Object.fromEntries(Object.entries((payment.metadata ?? {}) as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    if (own.store) return own;
    const listed = await get(`/invoice_payments?${new URLSearchParams({ "payment[type]": "payment_intent", "payment[payment_intent]": intent, limit: "1" })}`);
    if (!Array.isArray(listed.data)) throw new StripeShapeError("Stripe invoice payments are not a list");
    const invoice = str((listed.data as Record<string, unknown>[])[0]?.invoice);
    // No invoice paid by it: a payment no subscription made, so its own metadata is all there is.
    if (!invoice || !/^in_[A-Za-z0-9]+$/.test(invoice)) return own;
    return invoiceMeta(await get(`/invoices/${encodeURIComponent(invoice)}`));
  } catch (error) {
    if (error instanceof OutOfLookups) {
      saySpent(store, budget);
      return "spent";
    }
    // Stripe has no such payment or invoice: asking again would not change it.
    if (isMissing(error)) {
      console.error("a payment Stripe does not know could not be told whose it is; nothing is sent for it", store.handle, intent);
      return {};
    }
    // Anything else (a refusal, a limit, a timeout, an answer in a shape not
    // known, our own setting) is tried again next run, a bounded number of visits (waitsOn).
    const waits = waitsOn(error);
    console.error(waits === "ours" ? "OUR CODE FAILED telling whose a payment is (not a Stripe error); it is read again next run" : "telling whose a payment is failed at Stripe; it is read again next run", store.handle, intent, error);
    return waits;
  }
}

/**
 * Turns one Stripe event of this store into ours, if it is one we send.
 * True once the event is done with (sent, or not one of ours); otherwise
 * why it waits (Waits) when what it needs could not be read in this run (a
 * lookup that failed, or the run's lookups used up): the caller then stops
 * before it and keeps the anchor there, so the next run reads it again
 * instead of losing it.
 * `heard` is every event the store's endpoints listen for: nothing is asked
 * of Stripe, and nothing waits, for an event no endpoint would be sent.
 */
async function fromStripe(store: Store, event: StripeEvent, lookups: Lookups, heard: ReadonlySet<WebhookEvent>): Promise<Outcome> {
  const object = event.data?.object ?? {};
  const previous = event.data?.previous_attributes ?? {};
  const handles = saleHandles(store);
  let meta = (object.metadata ?? {}) as Record<string, string>;
  // The order's own title (meta.title) stands in only for its own product when its listing is gone, never for a
  // product in a bundle or checked at checkout, which it does not name.
  const product = async (id: string | undefined) => {
    const found = id ? await readListing(store, id) : null;
    return { id: id ?? null, title: found?.title ?? (id === meta.product ? meta.title : null) ?? null };
  };
  const created = typeof event.created === "number" ? event.created * 1000 : Date.now();

  if (event.type === "checkout.session.completed") {
    if (!handles.has(meta.store ?? "") || !isSettled(object)) return true;
    const session = str(object.id);
    if (!session) return true;
    const details = (object.customer_details ?? {}) as { email?: unknown; name?: unknown };
    const buyer = { email: str(details.email) ?? str(object.customer_email), name: str(details.name) };
    const membership = object.mode === "subscription" && meta.kind !== "plan";
    const kind = meta.kind === "call" ? "call" : meta.kind === "plan" ? "payment_plan" : membership ? "membership" : "one_time";
    const totals = (object.total_details ?? {}) as { amount_discount?: unknown };
    // A bundle names every product it handed over, from the list on the order.
    const inside = async (slot: BundleSlot) => {
      const ids = bundleFromMeta(meta, slot);
      return ids.length ? Promise.all(ids.map((id) => product(id))) : null;
    };
    await emitEvent(store, "sale.completed", session, {
      checkout_session: session,
      kind,
      product: await product(meta.product),
      option: meta.option ?? null,
      bundle_items: await inside("bundle"),
      // Every product ticked at checkout, in the order of its boxes; the first
      // also under its old name, which integrations built before there could
      // be several still read.
      ...(await (async () => {
        const ticked = await Promise.all(bumpsFromMeta(meta).map(async ({ key, id }) => ({ ...(await product(id)), bundle_items: await inside(`${key}_bundle`) })));
        return { order_bump: ticked[0] ?? null, order_bumps: ticked };
      })()),
      amount_cents: num(object.amount_total),
      discount_cents: num(totals.amount_discount),
      currency: str(object.currency) ?? "usd",
      buyer,
      paid_at: iso(event.created),
      // Where the sale came from, as the checkout wrote it on the order: the
      // utm tags of the page the button was on, and the creator's own site it
      // was bought on through the checkout script (lib/embed-sites.ts).
      source: sourceOf(meta),
    }, created);
    if (membership) {
      await emitEvent(store, "membership.started", str(object.subscription) ?? session, {
        subscription: str(object.subscription),
        checkout_session: session,
        product: await product(meta.product),
        amount_cents: num(object.amount_total),
        currency: str(object.currency) ?? "usd",
        trial_days: Number(meta.trial_days) || 0,
        payments: Number(meta.ends_after) || null,
        buyer,
      }, created);
    }
    return true;
  }

  if (event.type === "payment_intent.succeeded") {
    if (meta.kind !== "upsell" || !handles.has(meta.store ?? "")) return true;
    const intent = str(object.id);
    if (!intent) return true;
    await emitEvent(store, "sale.completed", intent, {
      payment_intent: intent,
      kind: "upsell",
      product: await product(meta.product),
      bundle_items: bundleFromMeta(meta, "bundle").length ? await Promise.all(bundleFromMeta(meta, "bundle").map((id) => product(id))) : null,
      after_checkout: meta.parent ?? null,
      // Which offer of the funnel was taken: its id and its place (1 to 5).
      // An offer charged before this was recorded carries its id only when
      // it was not the first, and the first is always number 1.
      funnel_step: {
        id: meta.step_id || meta.step || null,
        number: Number(meta.step_number) || (meta.step ? null : 1),
      },
      amount_cents: num(object.amount),
      discount_cents: 0,
      currency: str(object.currency) ?? "usd",
      buyer: { email: str(object.receipt_email), name: null },
      paid_at: iso(event.created),
    }, created);
    return true;
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    if (!handles.has(meta.store ?? "") || meta.kind === "plan") return true;
    const id = str(object.id);
    if (!id) return true;
    const ended = event.type === "customer.subscription.deleted";
    // The change and the cancellation it is, by one rule (subscriptionEmits),
    // which a passed-over event's line reads too.
    const says = subscriptionEmits(event);
    if (says.changed) {
      const { from, to } = says.changed;
      await emitEvent(store, "membership.changed", says.changed.seed, {
        subscription: id,
        product: await product(meta.product),
        option: meta.option ?? null,
        from,
        to,
        changed_at: iso(event.created),
      }, created);
    }
    if (!says.cancel) return true;
    const item = ((object.items as { data?: { current_period_end?: unknown }[] } | undefined)?.data ?? [])[0];
    const endsAt = num(object.cancel_at) || num(object.current_period_end) || num(item?.current_period_end);
    const details = (object.cancellation_details ?? {}) as { reason?: unknown };
    let email: string | null = null;
    const customer = str(object.customer);
    // No endpoint hears cancellations: nothing to look up, nothing to wait on.
    if (!heard.has("membership.canceled")) return true;
    // The member's address, from the run's lookups: with none left, or a
    // call that failed, the cancellation waits for the next run rather than
    // going out without it (a membership.changed of the same update, already
    // sent, is not sent twice). A customer Stripe no longer has has none.
    if (customer && store.stripeAccountId) {
      if (lookups.left <= 0) {
        saySpent(store, "left");
        return "spent";
      }
      lookups.left -= 1;
      try {
        email = str((await onAccount("GET", store.stripeAccountId, `/customers/${encodeURIComponent(customer)}`)).email);
      } catch (error) {
        if (!isMissing(error)) {
          const waits = waitsOn(error);
          console.error(waits === "ours" ? "OUR CODE FAILED reading a canceled member's address (not a Stripe error); it is read again next run" : "reading a canceled member's address failed at Stripe; it is read again next run", store.handle, error);
          return waits;
        }
        email = null;
      }
    }
    await emitEvent(store, "membership.canceled", says.cancel, {
      subscription: id,
      product: await product(meta.product),
      status: ended ? "ended" : "ending",
      ends_at: ended ? iso(object.ended_at) ?? iso(event.created) : iso(endsAt),
      reason: ended && meta.ends_after ? "completed" : str(details.reason) ?? "cancellation_requested",
      buyer: { email, customer },
    }, created);
    return true;
  }

  if (event.type === "charge.refunded") {
    const charge = str(object.id);
    if (!charge) return true;
    const intent = str(object.payment_intent);
    // A charge made by a checkout carries the store in its own metadata; one
    // that does not is asked about through its payment and, for a
    // membership's or a payment plan's charge, the invoice it paid
    // (paymentMeta), from the run's bounded lookups. One that cannot be told
    // in this run waits for the next.
    if (!heard.has("refund.issued")) return true;
    if (!meta.store && intent) {
      const found = await paymentMeta(store, intent, lookups, "left");
      if (typeof found === "string") return found;
      meta = found;
    }
    if (!handles.has(meta.store ?? "")) return true;
    lookups.confirmed = str(event.id) ?? undefined;
    const total = num(object.amount_refunded);
    const before = num(previous.amount_refunded);
    const billing = (object.billing_details ?? {}) as { email?: unknown; name?: unknown };
    await emitEvent(store, "refund.issued", `${charge}|${total}`, {
      charge,
      payment_intent: intent,
      product: await product(meta.product),
      amount_refunded_cents: Math.max(0, total - before),
      total_refunded_cents: total,
      amount_cents: num(object.amount),
      fully_refunded: object.refunded === true,
      currency: str(object.currency) ?? "usd",
      buyer: { email: str(billing.email) ?? str(object.receipt_email), name: str(billing.name) },
      refunded_at: iso(event.created),
    }, created);
    return true;
  }

  if (event.type === "charge.dispute.created") {
    const dispute = str(object.id);
    if (!dispute) return true;
    const intent = str(object.payment_intent);
    // A dispute carries no store of its own: it is asked about through its
    // payment and, for a membership's or a payment plan's charge, the
    // invoice it paid (paymentMeta), from a budget of its own, so refunds in
    // the same run never leave a dispute unread. One past that budget, or
    // whose lookup failed, is said in the log and waits for the next run.
    if (!intent || !store.stripeAccountId || !heard.has("dispute.opened")) return true;
    const found = await paymentMeta(store, intent, lookups, "disputes");
    if (typeof found === "string") return found;
    meta = found;
    if (!handles.has(meta.store ?? "")) return true;
    lookups.confirmed = str(event.id) ?? undefined;
    const evidence = (object.evidence_details ?? {}) as { due_by?: unknown };
    await emitEvent(store, "dispute.opened", dispute, {
      dispute,
      charge: str(object.charge),
      payment_intent: intent,
      product: await product(meta.product),
      option: meta.option ?? null,
      amount_cents: num(object.amount),
      currency: str(object.currency) ?? "usd",
      reason: str(object.reason),
      status: str(object.status),
      evidence_due_by: iso(evidence.due_by),
      opened_at: iso(event.created),
    }, created);
  }
  return true;
}

/**
 * What one subscription event says, by the rules fromStripe sends by: the
 * change of price or quantity it is (the seed of its membership.changed),
 * if any, and whether it is a cancellation (with its membership.canceled seed).
 */
function subscriptionEmits(event: StripeEvent): { changed: { seed: string; from: NonNullable<ReturnType<typeof planOf>>; to: NonNullable<ReturnType<typeof planOf>> } | null; cancel: string | null } {
  const object = event.data?.object ?? {};
  const previous = event.data?.previous_attributes ?? {};
  const meta = (object.metadata ?? {}) as Record<string, string>;
  const id = str(object.id) ?? "";
  const ended = event.type === "customer.subscription.deleted";
  let changed = null;
  // A move to another price or quantity (an upgrade, a downgrade, another
  // interval) is its own event, said once per change; the same update may
  // also set an end, which is a cancellation too.
  if (!ended && "items" in previous) {
    const from = planOf(previous.items);
    const to = planOf(object.items);
    if (from && to && (from.price !== to.price || from.quantity !== to.quantity)) changed = { seed: `${id}|${num(event.created)}|${to.price}|${to.quantity}`, from, to };
  }
  let cancels = ended;
  if (!ended) {
    // Only the change that sets an end. A membership with a set number of
    // payments is given its end when it is bought; that is not a cancellation.
    const ending = object.cancel_at_period_end === true || num(object.cancel_at) > 0;
    const wasEnding = previous.cancel_at_period_end === true || num(previous.cancel_at) > 0;
    const set = "cancel_at_period_end" in previous || "cancel_at" in previous;
    cancels = ending && !wasEnding && set && !meta.ends_after;
  }
  return { changed, cancel: cancels ? `${id}|${num(object.canceled_at) || num(object.cancel_at) || num(event.created)}` : null };
}

/** A subscription's first item as a membership's plan: its price, amount, interval and quantity; null when it has none. */
function planOf(items: unknown): { price: string | null; amount_cents: number; interval: string | null; interval_count: number; quantity: number } | null {
  const first = ((items as { data?: unknown } | null | undefined)?.data as Record<string, unknown>[] | undefined)?.[0];
  const price = (first?.price ?? null) as { id?: unknown; unit_amount?: unknown; recurring?: { interval?: unknown; interval_count?: unknown } | null } | null;
  if (!first || !price) return null;
  return {
    price: str(price.id),
    amount_cents: num(price.unit_amount),
    interval: str(price.recurring?.interval),
    interval_count: num(price.recurring?.interval_count) || 1,
    quantity: num(first.quantity) || 1,
  };
}

/** A partial or malformed observation must not advance past unseen events. */
function stripeEventPage(value: unknown): StripeEvent[] {
  const invalid = () => new Error("Stripe events are not a complete bounded page");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.data) || page.data.length > 100 || typeof page.has_more !== "boolean" ||
      (page.has_more && !page.data.length)) throw invalid();
  const ids = new Set<string>();
  for (const row of page.data) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        typeof row.id !== "string" || !/^evt_[A-Za-z0-9]+$/.test(row.id) || ids.has(row.id)) throw invalid();
    ids.add(row.id);
  }
  return page.data as StripeEvent[];
}

/**
 * What a Stripe event that can wait would have been sent as: each event of
 * ours it makes (`parts`, with the seed of its id, by fromStripe's own
 * rules), the Stripe object it is about, in the creator's words, and whether
 * it is known to be the store's: one that names the store in its own
 * metadata is, and so is a refund or a dispute whose payment this visit
 * confirmed (`confirmed`); otherwise a refund or a dispute waits only because
 * whose its payment is could not be told, so it may be a charge made on the
 * same Stripe account outside Marktmorgen.
 */
function waitedAs(event: StripeEvent, handles: Set<string>, confirmed: boolean): { parts: { type: WebhookEvent; seed: string }[]; about: string; known: boolean } {
  const object = event.data?.object ?? {};
  const meta = (object.metadata ?? {}) as Record<string, unknown>;
  const id = str(object.id) ?? "";
  const shown = id || "an unknown id";
  const known = confirmed || handles.has(str(meta.store) ?? "");
  if (event.type === "checkout.session.completed") {
    const membership = object.mode === "subscription" && meta.kind !== "plan";
    return { parts: [{ type: "sale.completed", seed: id }, ...(membership ? [{ type: "membership.started" as const, seed: str(object.subscription) ?? id }] : [])], about: `checkout ${shown}`, known };
  }
  if (event.type === "payment_intent.succeeded") return { parts: [{ type: "sale.completed", seed: id }], about: `payment ${shown}`, known };
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const says = subscriptionEmits(event);
    return {
      parts: [...(says.changed ? [{ type: "membership.changed" as const, seed: says.changed.seed }] : []), ...(says.cancel ? [{ type: "membership.canceled" as const, seed: says.cancel }] : [])],
      about: `subscription ${shown}`,
      known,
    };
  }
  if (event.type === "charge.refunded") return { parts: [{ type: "refund.issued", seed: `${id}|${num(object.amount_refunded)}` }], about: `the refund of charge ${shown}`, known };
  if (event.type === "charge.dispute.created") return { parts: [{ type: "dispute.opened", seed: id }], about: `dispute ${shown}`, known: confirmed };
  return { parts: [], about: `Stripe event ${str(event.id) ?? shown}`, known: false };
}

/** The mark that a Stripe event was passed over and its lines written (eventKey), so it is never held or written again. */
const givenUpMark = (statsId: string, stripeEvent: string) => eventKey(eventIdFor(statsId, "stripe.given_up", stripeEvent));

/** The count of a store's messages not kept for one reason on one UTC day (skippedLines), under the family of the store's waits. */
const skippedDayKey = (statsId: string, reason: "large" | "used", day: number) => `nl:hooks:wait:${statsId}:skip:${reason}:${day}`;

/**
 * The lines a message that is not kept leaves in the store's log, one an
 * endpoint (`deliveries`, as they would have been): the first
 * SKIPPED_LINES_PER_DAY messages of a UTC day for a reason get their own,
 * with the reason's words; every later one that day is counted in one line
 * an endpoint, rewritten with its count. `words` are the reason's, as the
 * try would say them. No message is behind any of them,
 * so none can be sent again, and none takes a delivery of the month.
 */
async function skippedLines(statsId: string, deliveries: Delivery[], reason: "large" | "used", words: string, now: number): Promise<void> {
  const day = Math.floor(now / 86_400_000);
  const key = skippedDayKey(statsId, reason, day);
  // INCR's whole number from 1 up, one reply for each command (CX-123 rule 24); text or true was read as a number.
  // Thrown, emitEvent takes the event's mark back, so it is noticed again.
  const n = countOf(repliesFor(await redisPipeline([["INCR", key], ["EXPIREAT", key, (day + 2) * 86400]]), 2)?.[0]);
  if (n === null || n < 1) throw new Error("the day's messages not kept could not be counted");
  if (n <= SKIPPED_LINES_PER_DAY) {
    const lines = deliveries.map((d) => noticeLine(d.id, statsId, d.endpoint, d.eventId, d.type as WebhookEvent, words, now));
    const written = linesWritten(await redisPipeline(lines.map((line) => ["SET", deliveryKey(line.id), JSON.stringify(line), "NX", "EX", DELIVERY_SECONDS])), lines.length, true);
    await pushMissing(statsId, lines.filter((_, at) => !written[at]).map((line) => line.id), lines.filter((_, at) => written[at]).map((line) => line.id));
    return;
  }
  const more = n - SKIPPED_LINES_PER_DAY;
  const date = new Date(day * 86_400_000).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const why = reason === "large" ? "were too large to send" : "were not sent because your store's webhook deliveries for this month are used";
  const lines = deliveries.map((d) => ({
    ...noticeLine(
      `dlv_${createHash("sha256").update(`${statsId}|${day}|${d.endpoint}|skipped-${reason}`).digest("hex").slice(0, 24)}`,
      statsId, d.endpoint, eventIdFor(statsId, `skipped.${reason}`, `${day}|${d.endpoint}`), d.type as WebhookEvent,
      `${more} more ${more === 1 ? "message" : "messages"} on ${date} ${why}. Nothing was counted for ${more === 1 ? "it" : "them"}.`, now,
    ),
  }));
  linesWritten(await redisPipeline(lines.map((line) => ["SET", deliveryKey(line.id), JSON.stringify(line), "EX", DELIVERY_SECONDS])), lines.length, false);
  await pushMissing(statsId, lines.map((line) => line.id));
}

/** A line of the delivery log no message is behind: the studio shows it "Not sent", with `words`. */
function noticeLine(id: string, statsId: string, endpoint: string, eventId: string, type: WebhookEvent, words: string, now: number): Delivery {
  return { id, statsId, endpoint, eventId, type, body: "", attempts: 0, state: "failed", next: 0, lastStatus: 0, lastError: words, lastAt: now, createdAt: now, givenUp: true };
}

/**
 * The replies to `count` delivery lines written, read exactly (CX-123 rule 24): SET answers "OK" when it wrote and,
 * with NX only, null when the line was already there. Any other reply, or not one for each line, is unknown and
 * throws: a line is never counted as stored on it, so what wrote it lets its mark go (or never sets it) and it is
 * written again when it comes back. True for each line written now.
 */
function linesWritten(replies: unknown, count: number, nx: boolean): boolean[] {
  const read = repliesFor(replies, count);
  if (!read || read.some((reply) => reply !== "OK" && !(nx && reply === null))) throw new UnknownReplyError("a webhook delivery line's write");
  return read.map((reply) => reply === "OK");
}

/** GET's replies, each text or null (CX-123 rule 24), one for each of `count` keys; any other shape throws. */
function textsOrNull(replies: unknown, count: number, what: string): (string | null)[] {
  const read = repliesFor(replies, count);
  if (!read || read.some((reply) => reply !== null && typeof reply !== "string")) throw new UnknownReplyError(what);
  return read as (string | null)[];
}

/** Puts in the store's log those of `ids` it does not hold yet (one a visit that died left out, or one trimmed since). */
async function pushMissing(statsId: string, ids: string[], known: string[] = []): Promise<void> {
  let push = known;
  if (ids.length) {
    // A list of text, exactly (CX-123 rule 24): a log in another shape is unknown, never empty, so no line goes in twice.
    const logged = stringList(repliesFor(await redisPipeline([["LRANGE", logKey(statsId), 0, LOG_SIZE - 1]]), 1)?.[0]);
    if (!logged) throw new UnknownReplyError("a store's webhook delivery log");
    const inLog = new Set(logged);
    push = [...known, ...ids.filter((id) => !inLog.has(id))];
  }
  if (push.length) await redisPipeline([...push.map((id) => ["LPUSH", logKey(statsId), id]), ["LTRIM", logKey(statsId), 0, LOG_SIZE - 1]]);
}

/**
 * The line a passed-over Stripe event leaves in the store's delivery log,
 * which the studio shows ("Not sent", with the reason), for each endpoint
 * that hears something it would have been sent and was not (an event of
 * ours it makes that was already sent, as a sale before its membership's
 * start, is not said "Not sent"; an endpoint that got everything gets no
 * line), so the creator can look it up in Stripe. `cause` says whose the
 * failure was: Stripe's (it kept refusing or failing to answer) or ours.
 *
 * It takes none of the store's webhook deliveries: no message is made and
 * no endpoint is called, and a count that could be lost or refused would
 * either charge the creator again or hold the store's later events.
 *
 * The first GIVEN_UP_LINES_PER_DAY events of a UTC day for an endpoint get
 * their own line there; every later one that day is counted in one summary
 * line of that endpoint, rewritten with its count. Which is which is the
 * event's place in the endpoint's sorted set of the day (ZADD NX: a repeat
 * keeps its first place), so a visit that dies half way, or a store read
 * again, never counts an event twice. The place is the order the events
 * were passed over in: the time to the millisecond, times a thousand, and
 * the store's own number for the day after it (givenUpSeqKey). Every event
 * of one visit shares that visit's time, and on the time alone two events
 * would tie and be put in order by their ids, so a later one could take an
 * earlier one's own line.
 *
 * Written once, and never lost: each line's id is made from the event and
 * the endpoint (the summary's from the day and the endpoint), so a repeat
 * finds it (SET NX) and puts it in the log only when it is not there yet;
 * the event's mark (givenUpMark) is set after every line is written, and a
 * visit that finds it writes nothing (and watchStore passes the event over
 * when it reads it again).
 */
async function markGivenUp(store: Store, statsId: string, config: Config, event: StripeEvent, visits: number, cause: "stripe" | "ours", confirmed: boolean, now: number): Promise<void> {
  const stripeEvent = str(event.id) ?? "";
  const mark = givenUpMark(statsId, stripeEvent);
  const as = waitedAs(event, saleHandles(store), confirmed);
  // Each mark text or null (CX-123 rule 24): one in another shape is unknown and throws before anything is written
  // or marked, never "already told" nor "already sent"; the visit fails and the next one gives the event up again.
  const [marked, ...sent] = textsOrNull(await redisPipeline([["GET", mark], ...as.parts.map((part) => ["GET", eventKey(eventIdFor(statsId, part.type, part.seed))])]), 1 + as.parts.length, "a passed-over Stripe event's marks");
  if (marked !== null) return;
  const unsent = as.parts.filter((_, at) => sent[at] === null);
  const hearing = config.endpoints.flatMap((endpoint) => {
    const part = unsent.find((p) => endpoint.events.includes(p.type));
    return part ? [{ endpoint, type: part.type }] : [];
  });
  const day = Math.floor(now / 86_400_000);
  const eventId = eventIdFor(statsId, "stripe.given_up", stripeEvent);
  // At most MAX_ENDPOINTS endpoints a store a day are told; one past them (a
  // store removing and adding endpoints) is said in the server's log only.
  const endpointsKey = givenUpEndpointsKey(statsId, day);
  const joined = hearing.length ? repliesFor(await redisPipeline([
    ...hearing.flatMap(({ endpoint }) => [["SADD", endpointsKey, endpoint.id], ["SCARD", endpointsKey]]),
    ["EXPIREAT", endpointsKey, (day + 2) * 86400],
  ]), hearing.length * 2 + 1) : [];
  // SADD's 0 or 1 and SCARD's count, each in its exact shape (CX-123 rule 24). An unknown one throws before
  // anything is written or marked, as when the numbering below cannot be read: the visit fails and the next
  // one gives the event up again. Read as "not added" or as a small count, it would tell an endpoint past the
  // day's MAX_ENDPOINTS; read as "over", it would leave the creator untold for good.
  const counts: { added: number; card: number }[] = [];
  for (let n = 0; n < hearing.length; n += 1) {
    const added = countOf(joined?.[n * 2]);
    const card = countOf(joined?.[n * 2 + 1]);
    if (added === null || added > 1 || card === null) throw new UnknownReplyError("the endpoints told of a passed-over Stripe event");
    counts.push({ added, card });
  }
  const over = hearing.filter((_, n) => counts[n].added === 1 && counts[n].card > MAX_ENDPOINTS);
  if (over.length) {
    await redisPipeline(over.map(({ endpoint }) => ["SREM", endpointsKey, endpoint.id]));
    console.error("more endpoints of a store were to be told of passed-over Stripe events today than it can have; said here only", statsId, stripeEvent, over.map(({ endpoint }) => endpoint.id));
  }
  const listening = hearing.filter((at) => !over.includes(at));
  // Its own number for the day, so no two events share a place (a repeat's ZADD NX keeps its first one).
  // INCR's whole number from 1 up, one reply for each command (CX-123 rule 24); text or true was read as a number.
  const seq = listening.length ? countOf(repliesFor(await redisPipeline([["INCR", givenUpSeqKey(statsId, day)], ["EXPIREAT", givenUpSeqKey(statsId, day), (day + 2) * 86400]]), 2)?.[0]) : 0;
  if (seq === null || (listening.length && seq < 1)) throw new Error("the day's passed-over events could not be numbered");
  const order = now * 1000 + (seq % 1000);
  const placed = listening.length ? await redisPipeline(listening.flatMap(({ endpoint }) => {
    const key = givenUpDayKey(statsId, day, endpoint.id);
    // Gone at the end of the next UTC day: two days' sets an endpoint at most.
    return [["ZADD", key, "NX", order, eventId], ["ZCARD", key], ["ZREVRANK", key, eventId], ["EXPIREAT", key, (day + 2) * 86400]];
  })) : [];
  const own: typeof listening = [];
  const summed: { endpoint: Endpoint; type: WebhookEvent; more: number }[] = [];
  // One reply for each command, and the count and the rank each a whole number (CX-123 rule 24): a rank of null or
  // text was read as 0, the last place, and could give an event a line of its own past the day's lines.
  if (listening.length && !repliesFor(placed, listening.length * 4)) throw new Error("the day's passed-over events could not be counted");
  listening.forEach((at, n) => {
    const card = countOf(placed[n * 4 + 1]);
    const rank = countOf(placed[n * 4 + 2]);
    if (card === null || rank === null || card - 1 - rank < 0) throw new Error("the day's passed-over events could not be counted");
    const place = card - 1 - rank;
    if (place < GIVEN_UP_LINES_PER_DAY) own.push(at);
    else summed.push({ ...at, more: card - GIVEN_UP_LINES_PER_DAY });
  });

  if (own.length) {
    const start = cause === "ours" ? `We could not process this Stripe event about ${as.about}` : `Stripe kept refusing or failing to answer about ${as.about}`;
    const words = `${start}, so it was skipped after ${visits} tries.${as.known ? "" : " It may not be from this store."} Look it up in your Stripe dashboard.`;
    const lines = own.map(({ endpoint, type }) => noticeLine(
      `dlv_${createHash("sha256").update(`${eventId}|${endpoint.id}`).digest("hex").slice(0, 24)}`,
      statsId, endpoint.id, eventId, type, words, now,
    ));
    // A write answered in another shape throws before the event is marked (linesWritten), so a later visit writes it.
    const written = linesWritten(await redisPipeline(lines.map((line) => ["SET", deliveryKey(line.id), JSON.stringify(line), "NX", "EX", DELIVERY_SECONDS])), lines.length, true);
    // A new line goes in the log; one already there from a visit that died, only when that visit died before putting it there.
    await pushMissing(statsId, lines.filter((_, at) => !written[at]).map((line) => line.id), lines.filter((_, at) => written[at]).map((line) => line.id));
  }

  if (summed.length) {
    const date = new Date(day * 86_400_000).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    const ids = summed.map(({ endpoint }) => `dlv_${createHash("sha256").update(`${statsId}|${day}|${endpoint.id}|given-up-day`).digest("hex").slice(0, 24)}`);
    // The line keeps when it was first written and what it was first said as; only its count and its time move.
    // Each read text or null (CX-123 rule 24); another shape throws, never read as no line yet.
    const before = textsOrNull(await redisPipeline(ids.map((id) => ["GET", deliveryKey(id)])), ids.length, "a passed-over day's summary line").map(parseDelivery);
    const lines = summed.map(({ endpoint, type, more }, at) => {
      const words = `${more} more Stripe ${more === 1 ? "event" : "events"} could not be processed on ${date}. Look ${more === 1 ? "it" : "them"} up in your Stripe dashboard.`;
      const kept = before[at];
      return { ...noticeLine(ids[at], statsId, endpoint.id, eventIdFor(statsId, "stripe.given_up_day", `${day}|${endpoint.id}`), kept?.type && kept.type !== "test" ? kept.type : type, words, now), createdAt: kept?.createdAt ?? now };
    });
    linesWritten(await redisPipeline(lines.map((line) => ["SET", deliveryKey(line.id), JSON.stringify(line), "EX", DELIVERY_SECONDS])), lines.length, false);
    await pushMissing(statsId, ids);
  }
  await redisPipeline([["SET", mark, "1", "EX", EVENT_SECONDS]]);
}

/** One store: its Stripe events since the last one read, oldest first. */
async function watchStore(store: Store, statsId: string, config: Config, now = Date.now()): Promise<number> {
  const account = store.stripeAccountId as string;
  const types = STRIPE_TYPES.map((t, i) => `types[${i}]=${encodeURIComponent(t)}`).join("&");
  // Each text or null (CX-123 rule 24): another shape is unknown and throws, so the store is not read this run and
  // neither its anchor nor its wait moves (never read as no anchor, which reads it again from far back).
  const [anchorRaw, waitRaw] = textsOrNull(await redisPipeline([["GET", anchorKey(statsId)], ["GET", waitKey(statsId)]]), 2, "a store's Stripe anchor and wait");
  const anchor = typeof anchorRaw === "string" && /^evt_[A-Za-z0-9]+$/.test(anchorRaw) ? anchorRaw : "";
  const nowSeconds = Math.floor(now / 1000);
  // "<evt>|<visits>|<since>": the event waited on, the visits it failed and
  // when it first stopped (a record written before the time was kept counts from now).
  const waitMatch = typeof waitRaw === "string" ? /^(evt_[A-Za-z0-9]+)\|(\d{1,6})(?:\|(\d{1,12}))?$/.exec(waitRaw) : null;
  const waiting = waitMatch ? { event: waitMatch[1], runs: Number(waitMatch[2]), since: Number(waitMatch[3] ?? nowSeconds) } : null;
  const lookups: Lookups = { left: STRIPE_LOOKUPS_PER_STORE, disputes: DISPUTE_LOOKUPS_PER_STORE };
  // What the endpoints sent to now hear: one whose API key is paused or revoked hears nothing (owner C3-100).
  const heard: ReadonlySet<WebhookEvent> = new Set((await liveEndpoints(store, config.endpoints)).flatMap((e) => e.events));
  let handled = 0;
  // The newest event done with: the anchor is moved only up to it, never
  // past an event that waits (fromStripe), so a lookup that failed or ran
  // out is read again next run and nothing is lost.
  let last = "";
  // The event this run stopped at, if any, with what its wait record becomes.
  let stuck: { event: string; runs: number; since: number } | null = null;
  const send = async (rows: StripeEvent[], reread = false): Promise<boolean> => {
    // A store read again from far back (its first run, or an anchor Stripe
    // lost): events already passed over are passed over again at once, not
    // held again; one pipeline a page, and only then.
    // Each mark text or null (CX-123 rule 24): one in another shape is unknown and throws before anything is sent,
    // never taken as passed over, so the anchor does not move past the event.
    const marks = reread ? textsOrNull(await redisPipeline(rows.map((row) => ["GET", givenUpMark(statsId, str(row.id) ?? "")])), rows.length, "the marks of passed-over Stripe events") : [];
    const passed = new Set(rows.filter((_, at) => reread && marks[at] !== null).map((row) => str(row.id) ?? ""));
    // Stripe lists newest first; they are sent in the order they happened.
    for (const event of [...rows].reverse()) {
      const id = str(event.id) ?? "";
      if (passed.has(id)) {
        last = id || last;
        continue;
      }
      let outcome: Outcome;
      lookups.confirmed = undefined;
      try {
        outcome = await fromStripe(store, event, lookups, heard);
      } catch (error) {
        // A failure of our own handling of the event (the store, a listing
        // read, a shape the code did not expect), not of a Stripe lookup:
        // said apart in the log, and counted like a failure that may clear,
        // so it too ends in a give-up instead of holding the store forever.
        console.error("OUR CODE FAILED on a Stripe event (not a Stripe error); it is read again next run", store.handle, id, event.type, error);
        outcome = "ours";
      }
      // Whose the failure was, by this visit's: the one the line says.
      const cause: "stripe" | "ours" = outcome === "ours" ? "ours" : "stripe";
      if (outcome === true) {
        handled += 1;
        last = id || last;
        continue;
      }
      const same = waiting?.event === id;
      const since = same ? waiting.since : nowSeconds;
      // The visit's lookups ran out: not a failure, nothing counted.
      const runs = (same ? waiting.runs : 0) + (outcome === "spent" ? 0 : 1);
      const over = outcome !== "spent" && (runs >= STRIPE_WAIT_RUNS ||
        (runs >= STRIPE_WAIT_TIME_VISITS && nowSeconds - since >= STRIPE_WAIT_MAX_SECONDS) ||
        (outcome === "refused" && runs >= STRIPE_REFUSED_RUNS));
      if (!over) {
        stuck = { event: id, runs, since };
        return false;
      }
      // Passed over, not handled: not counted among the events read, and
      // said where the creator sees it as well as in the server's log. The
      // endpoints as they are now, so one added during this visit is told too.
      console.error(`WEBHOOK EVENT GIVEN UP: a Stripe event waited ${runs} visits since ${new Date(since * 1000).toISOString()} (${cause === "ours" ? "our code failed" : `a Stripe lookup kept failing, ${outcome}`}); it is passed over and not sent`, store.handle, id, event.type);
      const fresh = (await readConfig(statsId)) ?? config;
      await markGivenUp(store, statsId, { ...fresh, endpoints: await liveEndpoints(store, fresh.endpoints) }, event, runs, cause, lookups.confirmed === id, now);
      last = id || last;
    }
    return true;
  };
  // What the run leaves for the next: a waiting event's count of runs, and
  // the anchor kept as long as Stripe keeps events while it does not move
  // (a moved one was just set with that expiry); a wait that is over is let go.
  const settle = async () => {
    if (stuck) {
      await redisPipeline([
        ["SET", waitKey(statsId), `${stuck.event}|${stuck.runs}|${stuck.since}`, "EX", ANCHOR_SECONDS],
        ...(anchor && !last ? [["EXPIRE", anchorKey(statsId), ANCHOR_SECONDS]] : []),
      ]);
    } else if (waiting) {
      await redisPipeline([["DEL", waitKey(statsId)]]);
    }
  };

  if (!anchor) {
    // The first run, or an anchor Stripe no longer has: collect bounded pages
    // going back in time, then send them oldest first. History beyond the
    // first-run page cap still needs a separate durable continuation.
    const pages: StripeEvent[][] = [];
    let older = "";
    for (let page = 0; page < FIRST_RUN_PAGES; page += 1) {
      const list = await onAccount(
        "GET",
        account,
        `/events?limit=100&${types}&created[gte]=${Math.max(config.since - 60, 0)}${older ? `&starting_after=${encodeURIComponent(older)}` : ""}`,
      );
      const rows = stripeEventPage(list);
      if (!rows.length) break;
      pages.push(rows);
      const last = str(rows[rows.length - 1].id);
      if (list.has_more !== true || !last) break;
      older = last;
      if (page === FIRST_RUN_PAGES - 1) console.error("a store has more Stripe events than one first run reads; the oldest are left", store.handle);
    }
    if (!pages.length) return 0;
    for (const rows of [...pages].reverse()) if (!(await send(rows, true))) break;
    if (last) await redisPipeline([["SET", anchorKey(statsId), last, "EX", ANCHOR_SECONDS]]);
    await settle();
    return handled;
  }

  let after = anchor;
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    // The hundred events just after the anchor.
    let list: Record<string, unknown>;
    try {
      list = await onAccount("GET", account, `/events?limit=100&${types}&ending_before=${encodeURIComponent(after)}`);
    } catch (error) {
      // Stripe keeps events for thirty days: an anchor it no longer knows is
      // let go of, and the store is read again from as far back as Stripe
      // goes (what was sent already is not sent twice, lib/webhooks.ts
      // emitEvent). Any other failure leaves the anchor for the next run.
      if (error instanceof StripeError && (error.status === 400 || error.status === 404)) {
        await redisPipeline([["DEL", anchorKey(statsId)]]);
        const since = Math.max(config.since, Math.floor(Date.now() / 1000) - 29 * 86400);
        return handled + (await watchStore(store, statsId, { ...config, since }, now));
      }
      throw error;
    }
    const rows = stripeEventPage(list);
    if (!rows.length) break;
    const whole = await send(rows);
    if (last && last !== after) {
      after = last;
      await redisPipeline([["SET", anchorKey(statsId), after, "EX", ANCHOR_SECONDS]]);
    }
    if (!whole || list.has_more !== true) break;
  }
  await settle();
  return handled;
}

/**
 * The five-minute job's pass over Stripe for every store with an endpoint
 * that wants what Stripe knows, until the deadline, carrying on next run
 * from the store after the last one it reached.
 */
export async function watchStripe(deadline: number, now = Date.now()): Promise<{ stores: number; events: number }> {
  const counts = { stores: 0, events: 0 };
  if (!isRedisConfigured()) return counts;
  // The stores a list of text and the place text or null (CX-123 rule 24): another shape is unknown and throws before
  // any store is read, so the place does not move (never read as no stores, or as starting over).
  const read = repliesFor(await redisPipeline([["SMEMBERS", STORES_KEY], ["GET", POSITION_KEY]]), 2);
  const members = stringList(read?.[0]);
  const saved = read?.[1];
  if (!members || (saved !== null && typeof saved !== "string")) throw new UnknownReplyError("the stores the Stripe watch reads, or its place");
  const ids = members.sort();
  if (!ids.length) return counts;
  const start = Math.max(0, ids.findIndex((id) => id > (typeof saved === "string" ? saved : "")));
  for (let n = 0; n < ids.length && Date.now() < deadline; n += 1) {
    const statsId = ids[(start + n) % ids.length];
    await redisPipeline([["SET", POSITION_KEY, statsId]]);
    const config = await readConfig(statsId);
    if (!config || !config.endpoints.length) {
      await redisPipeline([["SREM", STORES_KEY, statsId]]);
      continue;
    }
    if (!wantsStripe(config)) continue;
    const store = await storeForHandle(config.handle).catch(() => null);
    if (!store || store.statsId !== statsId || !store.stripeAccountId) continue;
    // Only the endpoints sent to now (owner C3-100): one whose API key is paused or revoked asks for no Stripe reading.
    if (!wantsStripe({ endpoints: await liveEndpoints(store, config.endpoints) })) continue;
    // 232 [CA1] 4b4b2: while the plan's costs are paused, the store's Stripe
    // events are not read and its anchor stays where it is, so nothing is
    // asked of Stripe; once paid, the next run reads from the anchor and
    // sends what happened meanwhile, as far back as Stripe keeps events
    // (thirty days). A first run with no anchor reads the bounded first pages.
    if (integrationPauseWord(store)) {
      // Keep the anchor, and the event a reading waits on, as long as Stripe
      // keeps events (thirty days from now); EXPIRE does nothing to a key
      // that is not there.
      await redisPipeline([["EXPIRE", anchorKey(statsId), 30 * 86400], ["EXPIRE", waitKey(statsId), 30 * 86400]]);
      continue;
    }
    counts.stores += 1;
    try {
      counts.events += await watchStore(store, statsId, config, now);
    } catch (error) {
      console.error("reading a store's Stripe events failed", store.handle, error);
    }
  }
  return counts;
}

/**
 * Forgets everything a deleted store kept here (added 17 October 2026): its
 * endpoints with their addresses and signing secrets, its place in the
 * five-minute job, its Stripe anchor and its delivery log with the bodies
 * of what was sent. Deliveries still waiting are dropped from the queue, so
 * nothing more is sent anywhere on its behalf. Safe to call twice.
 */
export async function forgetStoreWebhooks(statsId: string | null): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  const today = Math.floor(Date.now() / 86_400_000);
  const replies = repliesFor(
    await redisPipeline([
      ["LRANGE", logKey(statsId), 0, -1],
      ["GET", cfgKey(statsId)],
      ...[0, 1, 2].map((back) => ["SMEMBERS", givenUpEndpointsKey(statsId, today - back)]),
    ]),
    5,
  );
  // The log is the only way to the delivery bodies, which hold what was sent about people (audit SG2,
  // finding 19): a reply not in its exact shape deletes nothing, keeps the log and fails.
  const log = stringList(replies?.[0]);
  const rawConfig = replies?.[1];
  const rawTold = (replies ?? []).slice(2).map(stringList);
  if (!replies || !log || (rawConfig !== null && typeof rawConfig !== "string") || rawTold.some((members) => members === null)) {
    throw new UnknownReplyError("a deleted store's webhooks");
  }
  const ids = log.filter((id) => DELIVERY_ID_PATTERN.test(id));
  // The endpoints told on those days, removed since or not.
  const told = new Set([...(parseConfig(rawConfig)?.endpoints ?? []).map((e) => e.id), ...rawTold.flatMap((members) => members ?? [])]);
  await redisPipeline([
    ["DEL", cfgKey(statsId)],
    ["SREM", STORES_KEY, statsId],
    ["DEL", anchorKey(statsId)],
    ["DEL", waitKey(statsId)],
    // Each endpoint's sets of passed-over events, today's and the two days before (an endpoint removed since: gone within two days by itself).
    ...[...told].flatMap((endpoint) => [0, 1, 2].map((back) => ["DEL", givenUpDayKey(statsId, today - back, endpoint)])),
    ...[0, 1, 2].map((back) => ["DEL", givenUpEndpointsKey(statsId, today - back)]),
    ["DEL", logKey(statsId)],
    ...ids.flatMap((id) => [
      ["DEL", deliveryKey(id)],
      ["ZREM", QUEUE_KEY, `${statsId}|${id}`],
    ]),
  ]);
}

/** Keeps the handle the job looks a store up by current, from the studio. */
export async function keepHandle(store: Store): Promise<void> {
  if (!store.statsId || !isRedisConfigured()) return;
  // A handle kept in step is housekeeping: a write that keeps meeting other changes is left for the next one.
  await changeConfig(store.statsId, (fresh) => (fresh && fresh.handle !== store.handle ? { ...fresh, handle: store.handle } : null)).catch((error) => console.error("keeping the webhook handle failed", error));
}
