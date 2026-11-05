/**
 * One buyer, on one page of the studio (added 11 October 2026): everything a
 * person has done with this store, so the creator can answer them, thank
 * them or offer them the next thing knowing who they are.
 *
 * DataFast's visitor journey, Kissmetrics' person reports, Baremetrics' and
 * ChartMogul's customer pages and PostHog's revenue on a person all start
 * from the same idea: a total is a crowd, and a sale is somebody. Those tools
 * keep a log of every visitor to build that page. We keep none (visits are
 * counted per day without a cookie, lib/stats.ts), and this page needs none:
 *
 *   - what they paid, when, for what, through which channel, and what was
 *     given back, is asked of the creator's own Stripe account each time
 *     the page opens — the record of who paid for what, as everywhere else
 *     (lib/buyer-orders.ts). Nothing about money is written down here;
 *   - whether they are on the list, and which sequences they were started
 *     on, is the store's own list (lib/contacts.ts, lib/flows.ts);
 *   - how far they are in each course they bought is the course's own record
 *     of its students (lib/learn.ts);
 *   - and what the creator's team wrote about them is the one thing kept
 *     here: short notes, under a key made from the address, never the
 *     address itself.
 *
 * So the page costs nothing on a store's visits: it is read when somebody on
 * the team opens it, and only then (tests/plan-margin.test.ts is untouched).
 *
 * Who sees it: whoever may read orders with the buyer's address
 * (lib/team-roles.ts, "orders"): the owner, an Admin and Support.
 *
 * The address never travels in a link. A sale in the studio opens its buyer
 * by the sale's own Stripe reference, and an address typed into the search is
 * swapped for a token that works for an hour, for the store it was typed on.
 *
 *   nl:person:<statsId>:who            set of the people with notes
 *   nl:person:<statsId>:n:<person>     hash: <id> → JSON { at, by, text }
 *   nl:person:find:<token>             JSON { s: store id, e: address }, an hour
 */
import { personKey } from "@/lib/person-key";
import { readPaid } from "@/lib/paypal-sales";
import { randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { onAccount } from "@/lib/stripe-account";
import { isSettled } from "@/lib/instant-pay";
import { saleChannel } from "@/lib/stats";
import { type Store, saleHandles } from "@/lib/store";
import { listingFinder } from "@/lib/catalog";
import { bumpsFromMeta, bundleFromMeta } from "@/lib/bundle-rules";
import { type Contact, leadsKey, parseContact } from "@/lib/contacts";
import { readFlows, flowsStartedFor } from "@/lib/flows";
import { doneLessons, studentDates } from "@/lib/learn";
import { importedFor } from "@/lib/imported-purchases";
import { isGroupJob } from "@/lib/group-buy";
import { callsFor, type BookedCall } from "@/lib/buyer-orders";

/** The most customers whose payments one page reads; more is said, not hidden. */
export const MAX_CUSTOMERS = 15;
/** The most courses one page shows progress for. */
export const MAX_COURSES = 20;
/** Notes about one person, and how long each may be. */
export const MAX_PERSON_NOTES = 30;
export const MAX_PERSON_NOTE = 500;
/** How long a search's token opens the page it found. */
export const FIND_SECONDS = 60 * 60;

export const FIND_TOKEN = /^[0-9a-f]{48}$/;
export const PERSON_KEY = /^[0-9a-f]{32}$/;
export const SALE_REFERENCE = /^(cs_(test|live)_[A-Za-z0-9]{10,200}|pi_[A-Za-z0-9]{10,200})$/;
const NOTE_ID = /^[0-9a-f]{8}$/;
const CUSTOMER = /^cus_[A-Za-z0-9]{6,64}$/;
/** Kept as long as a store keeps anything about its buyers' visits, from the last note. */
const NOTES_SECONDS = 3 * 365 * 86_400;

const findKey = (token: string) => `nl:person:find:${token}`;
const whoKey = (statsId: string) => `nl:person:${statsId}:who`;
const notesKey = (statsId: string, person: string) => `nl:person:${statsId}:n:${person}`;

/** The key one address is kept under for one store: never the address itself (lib/person-key.ts). */
export { personKey };

// ------------------------------------------------------------------ finding

/** An address as typed into the search, or "" when it is not one. */
export function readAddress(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  return value && value.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(value) ? normaliseEmail(value) : "";
}

/** Swaps an address typed into the search for a token that opens its page for an hour, on this store only. */
export async function findToken(store: Pick<Store, "sid">, email: string): Promise<string | null> {
  if (!isRedisConfigured() || !store.sid) return null;
  const token = randomBytes(24).toString("hex");
  await redisPipeline([["SET", findKey(token), JSON.stringify({ s: store.sid, e: normaliseEmail(email) }), "EX", FIND_SECONDS]]);
  return token;
}

/** The address a search's token stands for, when it was made on this store and has not run out. */
export async function addressForToken(store: Pick<Store, "sid">, token: string): Promise<string | null> {
  if (!FIND_TOKEN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", findKey(token)]]);
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as { s?: unknown; e?: unknown };
    return value.s === store.sid && typeof value.e === "string" && value.e ? value.e : null;
  } catch {
    return null;
  }
}

/**
 * The address that paid for one of this store's sales, by the sale's Stripe
 * reference: a checkout, or a one-click payment after one. Null when the sale
 * is not this store's, or has no address.
 */
export async function addressForSale(store: Store, reference: string): Promise<string | null> {
  if (!SALE_REFERENCE.test(reference) || !store.stripeAccountId) return null;
  const handles = saleHandles(store);
  const path = reference.startsWith("cs_") ? `/checkout/sessions/${encodeURIComponent(reference)}` : `/payment_intents/${encodeURIComponent(reference)}`;
  const read = await onAccount("GET", store.stripeAccountId, path);
  const meta = (read.metadata ?? {}) as Record<string, string>;
  if (!handles.has(meta.store ?? "")) return null;
  const details = read.customer_details as { email?: unknown } | null | undefined;
  const email = reference.startsWith("cs_") ? details?.email : read.receipt_email;
  return typeof email === "string" && email ? normaliseEmail(email) : null;
}

// ------------------------------------------------------------------ notes

export type PersonNote = { id: string; at: number; by: string; text: string };

/** A note's words as they are kept: trimmed, at most MAX_PERSON_NOTE characters, line breaks kept. */
export function personNoteText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_PERSON_NOTE);
}

function parsePersonNotes(raw: unknown): PersonNote[] {
  const flat = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
  const out: PersonNote[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const id = flat[i];
    if (!NOTE_ID.test(id)) continue;
    try {
      const value = JSON.parse(flat[i + 1]) as Record<string, unknown>;
      const text = personNoteText(value.text);
      if (!text) continue;
      out.push({ id, at: Number(value.at) || 0, by: typeof value.by === "string" ? value.by.slice(0, MAX_EMAIL_LENGTH) : "", text });
    } catch {}
  }
  return out.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

/** Where notes about people are counted in the store's data room (lib/store-data.ts). */
const NOTES_SLOT = "pn";
const noteBytes = (note: PersonNote) => dataBytes([note.id, JSON.stringify({ at: note.at, by: note.by, text: note.text })], 1);

export async function readPersonNotes(statsId: string | null, person: string): Promise<PersonNote[]> {
  if (!statsId || !PERSON_KEY.test(person) || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["HGETALL", notesKey(statsId, person)]]);
  return parsePersonNotes(raw);
}

/**
 * Adds a note about one person, written by `by` (the signed-in address).
 * Each note is a field of its own, so two people writing at once both keep
 * theirs. Over MAX_PERSON_NOTES, the oldest go. Null when the words are empty.
 */
export async function addPersonNote(statsId: string, person: string, by: string, textRaw: unknown, room: DataStore, now = Date.now()): Promise<PersonNote[] | null> {
  const text = personNoteText(textRaw);
  if (!text || !PERSON_KEY.test(person) || !isRedisConfigured()) return null;
  const id = randomBytes(4).toString("hex");
  const json = JSON.stringify({ at: Math.floor(now / 1000), by: normaliseEmail(by), text });
  // Its room in the store's data room first (DataRoomError when it does not fit), its person's place with it.
  await needData(room, [{ slot: NOTES_SLOT, bytes: dataBytes([id, json], 1) + dataBytes([person], 1) }]);
  await redisPipeline([
    ["HSET", notesKey(statsId, person), id, json],
    ["EXPIRE", notesKey(statsId, person), NOTES_SECONDS],
    ["SADD", whoKey(statsId), person],
    ["EXPIRE", whoKey(statsId), NOTES_SECONDS],
  ]);
  const notes = await readPersonNotes(statsId, person);
  if (notes.length > MAX_PERSON_NOTES) {
    const dropped = notes.slice(MAX_PERSON_NOTES);
    await redisPipeline([["HDEL", notesKey(statsId, person), ...dropped.map((n) => n.id)]]);
    await giveData(room, [{ slot: NOTES_SLOT, bytes: dropped.reduce((sum, n) => sum + noteBytes(n), 0) }]);
    return notes.slice(0, MAX_PERSON_NOTES);
  }
  return notes;
}

/**
 * A note a workflow run writes (lib/flows.ts), only while the run still holds its own take of its lease at its exact
 * score (KEYS[3], ARGV[4] the member, ARGV[5] the score), in the same step as the write: 3, and nothing written, when it
 * was taken out or taken over by a later run (Codex G2 on #2287, C3-141). KEYS: the notes, the people; ARGV: the
 * note's id, the note, how long they are kept. Modelled by lib/redis-memory.ts.
 */
export const ADD_RUN_NOTE = `-- marktmorgen:person-run-note:v1
if tonumber(redis.call("ZSCORE", KEYS[3], ARGV[4]) or "-1") ~= tonumber(ARGV[5]) then return 3 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
redis.call("EXPIRE", KEYS[1], ARGV[3])
redis.call("SADD", KEYS[2], ARGV[6])
redis.call("EXPIRE", KEYS[2], ARGV[3])
return 1`;
/** What ADD_RUN_NOTE runs inside, which Upstash bills one by one beside the EVAL. */
export const ADD_RUN_NOTE_CALLS = 5;

/**
 * A note written by a workflow run's step under its own take (`take`, lib/crm.ts RunTake): "written", "superseded"
 * (nothing written, its room given back) or null when it is not a note. Kept as addPersonNote keeps notes.
 */
export async function addRunNote(statsId: string, person: string, by: string, textRaw: unknown, room: DataStore, take: { key: string; member: string; score: number }, now = Date.now()): Promise<"written" | "superseded" | null> {
  const text = personNoteText(textRaw);
  if (!text || !PERSON_KEY.test(person) || !isRedisConfigured()) return null;
  const id = randomBytes(4).toString("hex");
  const json = JSON.stringify({ at: Math.floor(now / 1000), by: normaliseEmail(by), text });
  const bytes = dataBytes([id, json], 1) + dataBytes([person], 1);
  await needData(room, [{ slot: NOTES_SLOT, bytes }]);
  const reply: unknown = await redisPipeline([["EVAL", ADD_RUN_NOTE, 3, notesKey(statsId, person), whoKey(statsId), take.key, id, json, NOTES_SECONDS, take.member, String(take.score), person]]);
  const answer = Array.isArray(reply) && reply.length === 1 ? reply[0] : undefined;
  if (answer === 3) {
    await giveData(room, [{ slot: NOTES_SLOT, bytes }]).catch(() => {});
    return "superseded";
  }
  if (answer !== 1) throw new Error("the note could not be confirmed");
  // As addPersonNote: past MAX_PERSON_NOTES, the oldest go and give their room back.
  const notes = await readPersonNotes(statsId, person);
  if (notes.length > MAX_PERSON_NOTES) {
    const dropped = notes.slice(MAX_PERSON_NOTES);
    await redisPipeline([["HDEL", notesKey(statsId, person), ...dropped.map((n) => n.id)]]);
    await giveData(room, [{ slot: NOTES_SLOT, bytes: dropped.reduce((sum, n) => sum + noteBytes(n), 0) }]);
  }
  return "written";
}

/** Takes one note away, and gives back its room; the notes as they are after. */
export async function removePersonNote(statsId: string, person: string, id: unknown, room: DataStore): Promise<PersonNote[]> {
  if (typeof id === "string" && NOTE_ID.test(id) && PERSON_KEY.test(person) && isRedisConfigured()) {
    const gone = (await readPersonNotes(statsId, person)).find((n) => n.id === id);
    const [removed] = await redisPipeline([["HDEL", notesKey(statsId, person), id]]);
    if (gone && Number(removed) === 1) await giveData(room, [{ slot: NOTES_SLOT, bytes: noteBytes(gone) }]);
  }
  return readPersonNotes(statsId, person);
}

/** Every note about every person, for a store that is being deleted. */
export async function forgetPersonNotes(statsId: string | null): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  const [raw] = await redisPipeline([["SMEMBERS", whoKey(statsId)]]);
  const people = (Array.isArray(raw) ? (raw as unknown[]).map(String) : []).filter((p) => PERSON_KEY.test(p));
  for (let i = 0; i < people.length; i += 500) {
    await redisPipeline([["DEL", ...people.slice(i, i + 500).map((p) => notesKey(statsId, p))]]);
  }
  await redisPipeline([["DEL", whoKey(statsId)]]);
}

// ------------------------------------------------------------------ the page

/** One payment or purchase on the page, newest first. */
export type ProfileOrder = {
  /** The Stripe reference, or "" for one brought over with no payment here. */
  reference: string;
  /**
   * "sale" is a checkout; "added" was taken in one click after one;
   * "renewal" is a later payment of a membership or a payment plan;
   * "brought" was handed over without a payment here (an import, a gift,
   * a place bought by somebody else, or a sale paid with PayPal).
   */
  kind: "sale" | "added" | "renewal" | "brought";
  title: string;
  /** Seconds. */
  at: number;
  /** What was paid, in the smallest unit of `currency`; 0 when nothing was. */
  cents: number;
  currency: string;
  /** How much of it was given back. */
  refunded: number;
  /** The channel the sale is credited to; "" when none was named. Only on a "sale". */
  channel: string;
  /** Whether a channel was written on the sale at all: sales from before 11 October 2026 have none. */
  recorded: boolean;
  campaign: string;
  /** A word on what it was, beside the title. */
  note: "" | "gift" | "for others" | "call" | "tip" | "calls" | "pre-order" | "trial" | "plan" | "paypal" | "imported" | "given";
};

export type ProfileMembership = {
  title: string;
  status: "active" | "trialing" | "past_due" | "paused" | "canceling" | "ended";
  /** Seconds. */
  since: number;
  /** When it ended, or will end when it is set to; 0 when neither. */
  until: number;
  plan: boolean;
};

export type ProfileCourse = { title: string; done: number; lessons: number; since: number; lastSeen: number };

export type BuyerProfile = {
  email: string;
  /** The name Stripe or an import has for them; "" when none. */
  name: string;
  contact: Contact | null;
  orders: ProfileOrder[];
  /** What they paid in the store's currency, and what was given back of it. */
  paid: number;
  refunded: number;
  currency: string;
  /** Money in other currencies, each kept apart: currency → net. */
  otherCurrencies: Record<string, number>;
  purchases: number;
  renewals: number;
  /** Seconds; 0 when they bought nothing. */
  firstAt: number;
  lastAt: number;
  /**
   * Where they first found the store, and where their latest purchase came
   * from, read from the sales that recorded a channel; "" for direct.
   */
  firstChannel: string;
  lastChannel: string;
  /** Whether a channel was written on any of their sales (sales from before 11 October 2026 have none). */
  channelKnown: boolean;
  memberships: ProfileMembership[];
  courses: ProfileCourse[];
  calls: BookedCall[];
  /** The names of the sequences they were started on. */
  sequences: string[];
  person: string;
  notes: PersonNote[];
  /** Stripe held more of their payments than one reading takes. */
  partial: boolean;
  /** Stripe could not be read: the payments are not on the page. */
  stripeError: boolean;
};

type Row = Record<string, unknown>;

const rowsOf = (listed: { data?: unknown }): Row[] => (Array.isArray(listed.data) ? (listed.data as Row[]) : []);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === "string" ? value : "");
const currencyOf = (row: { currency?: unknown }) => (typeof row.currency === "string" && row.currency ? row.currency.toLowerCase() : "usd");
const idOf = (value: unknown) => (typeof value === "string" ? value : value && typeof value === "object" ? str((value as Row).id) : "");

type Charge = { id: string; cents: number; refunded: number; currency: string; at: number };

function chargeOf(raw: unknown): Charge | null {
  if (!raw || typeof raw !== "object") return null;
  const charge = raw as Row;
  if (charge.status !== "succeeded" && charge.paid !== true) return null;
  const id = str(charge.id);
  if (!id) return null;
  return { id, cents: num(charge.amount), refunded: Math.min(num(charge.amount_refunded), num(charge.amount)), currency: currencyOf(charge), at: num(charge.created) };
}

function membershipStatus(sub: Row): ProfileMembership["status"] {
  const status = str(sub.status);
  if (status === "trialing") return "trialing";
  if (status === "past_due" || status === "unpaid") return "past_due";
  if (sub.pause_collection && typeof sub.pause_collection === "object") return "paused";
  if (status === "active") return sub.cancel_at_period_end === true || num(sub.cancel_at) > 0 ? "canceling" : "active";
  return "ended";
}

/** The end of a subscription's current period, where either of Stripe's API versions keeps it. */
function periodEnd(sub: Row): number {
  const direct = num(sub.current_period_end);
  if (direct) return direct;
  const items = (sub.items as { data?: unknown } | undefined)?.data;
  return Array.isArray(items) && items[0] && typeof items[0] === "object" ? num((items[0] as Row).current_period_end) : 0;
}

/**
 * Everything one address has done with this store, for its page in the
 * studio. Stripe is read for the money; when it cannot be, the rest of the
 * page is still there and says so.
 */
export async function buyerProfile(store: Store, rawEmail: string): Promise<BuyerProfile> {
  const email = normaliseEmail(rawEmail);
  const person = store.statsId ? personKey(store.statsId, email) : "";
  const find = listingFinder(store);
  const handles = saleHandles(store);
  const account = store.stripeAccountId;

  const orders: ProfileOrder[] = [];
  const memberships: ProfileMembership[] = [];
  const productIds: string[] = [];
  const charges = new Map<string, Charge>();
  let partial = false;
  let stripeError = false;
  let name = "";

  type Bought = { at: number; source: string; first: string; recorded: boolean };
  const sales: Bought[] = [];

  if (account) {
    try {
      // The sessions this address paid in: Stripe keeps the address as it was typed.
      const sessions = new Map<string, Row>();
      for (const variant of [...new Set([rawEmail.trim(), email])].filter(Boolean)) {
        const query = new URLSearchParams({ "customer_details[email]": variant, status: "complete", limit: "100" });
        query.append("expand[]", "data.subscription");
        query.append("expand[]", "data.payment_intent.latest_charge");
        const listed = (await onAccount("GET", account, `/checkout/sessions?${query}`)) as { data?: unknown; has_more?: unknown };
        if (listed.has_more === true) partial = true;
        for (const session of rowsOf(listed)) {
          const id = str(session.id);
          const meta = (session.metadata ?? {}) as Record<string, string>;
          if (!id || sessions.has(id) || !handles.has(meta.store ?? "") || !isSettled(session)) continue;
          sessions.set(id, session);
        }
      }

      // Each checkout made its own customer, so a customer's later payments —
      // a one-click extra, a renewal — belong to the sale that made it.
      const byCustomer = new Map<string, Row>();
      for (const session of [...sessions.values()].sort((a, b) => num(a.created) - num(b.created))) {
        const meta = (session.metadata ?? {}) as Record<string, string>;
        const listing = await find(meta.product);
        const details = (session.customer_details ?? {}) as Row;
        if (!name && str(details.name)) name = str(details.name).slice(0, 100);
        const intent = session.payment_intent && typeof session.payment_intent === "object" ? (session.payment_intent as Row) : null;
        const charge = chargeOf(intent?.latest_charge);
        if (charge) charges.set(charge.id, charge);
        const channel = saleChannel(meta);
        const recorded = "channel" in meta || Boolean(meta.utm_source);
        const subscription = session.subscription && typeof session.subscription === "object" ? (session.subscription as Row) : null;
        const plan = meta.kind === "plan";
        const title = meta.title || listing?.title || "A product that is no longer listed";
        const note: ProfileOrder["note"] = meta.gift
          ? "gift"
          : meta.group
            ? "for others"
            : meta.kind === "call"
              ? "call"
              : meta.kind === "tip"
                ? "tip"
                : meta.kind === "package"
                  ? "calls"
                  : meta.preorder
                    ? "pre-order"
                    : Number(meta.trial_days) > 0
                      ? "trial"
                      : plan
                        ? "plan"
                        : "";
        orders.push({
          reference: str(session.id),
          kind: "sale",
          title,
          at: num(session.created),
          // A membership's or a plan's first payment is its first invoice,
          // read with the customer's payments below.
          cents: charge ? charge.cents : session.mode === "subscription" ? 0 : num(session.amount_total),
          currency: charge ? charge.currency : currencyOf(session),
          refunded: charge ? charge.refunded : 0,
          channel: channel.source,
          recorded,
          campaign: channel.campaign,
          note,
        });
        sales.push({ at: num(session.created), source: channel.source, first: channel.first, recorded });
        // A one-off sale whose payment Stripe did not hand over with it still
        // counts, at what the checkout took; its payment, if it is listed under
        // the customer below, takes its place, so it is never counted twice.
        if (!charge && session.mode !== "subscription" && num(session.amount_total) > 0) {
          charges.set(`session:${str(session.id)}`, { id: `session:${str(session.id)}`, cents: num(session.amount_total), refunded: 0, currency: currencyOf(session), at: num(session.created) });
        }
        if (meta.product) productIds.push(meta.product);
        productIds.push(...bundleFromMeta(meta, "bundle"), ...bumpsFromMeta(meta).map((b) => b.id));
        if (subscription) {
          const status = membershipStatus(subscription);
          memberships.push({
            title,
            status,
            since: num(subscription.start_date) || num(session.created),
            until: status === "ended" ? num(subscription.ended_at) || num(subscription.canceled_at) : status === "canceling" ? num(subscription.cancel_at) || periodEnd(subscription) : 0,
            plan,
          });
        }
        const customer = idOf(session.customer);
        if (CUSTOMER.test(customer) && !byCustomer.has(customer)) byCustomer.set(customer, session);
      }

      const customers = [...byCustomer.entries()];
      if (customers.length > MAX_CUSTOMERS) partial = true;
      const lists = await Promise.all(
        customers.slice(-MAX_CUSTOMERS).map(async ([customer]) => {
          const query = new URLSearchParams({ customer, limit: "100" });
          query.append("expand[]", "data.payment_intent");
          return (await onAccount("GET", account, `/charges?${query}`)) as { data?: unknown; has_more?: unknown };
        }),
      );
      customers.slice(-MAX_CUSTOMERS).forEach(([, session], i) => {
        const listed = lists[i];
        if (listed.has_more === true) partial = true;
        const sessionIntent = idOf(session.payment_intent);
        const meta = (session.metadata ?? {}) as Record<string, string>;
        const order = orders.find((o) => o.reference === str(session.id));
        for (const raw of rowsOf(listed)) {
          const charge = chargeOf(raw);
          if (!charge || charges.has(charge.id)) continue;
          const intent = raw.payment_intent && typeof raw.payment_intent === "object" ? (raw.payment_intent as Row) : null;
          const intentId = idOf(raw.payment_intent);
          const intentMeta = (intent?.metadata ?? {}) as Record<string, string>;
          if (intentId && intentId === sessionIntent) {
            charges.delete(`session:${str(session.id)}`);
            charges.set(charge.id, charge);
            if (order) {
              order.cents = charge.cents;
              order.currency = charge.currency;
              order.refunded = charge.refunded;
            }
            continue;
          }
          if (intentMeta.kind === "upsell") {
            if (!handles.has(intentMeta.store ?? "")) continue;
            charges.set(charge.id, charge);
            if (intentMeta.product) productIds.push(intentMeta.product, ...bundleFromMeta(intentMeta, "bundle"));
            orders.push({
              reference: intentId,
              kind: "added",
              title: intentMeta.title || "A product that is no longer listed",
              at: charge.at,
              cents: charge.cents,
              currency: charge.currency,
              refunded: charge.refunded,
              channel: "",
              recorded: false,
              campaign: "",
              note: "",
            });
            continue;
          }
          // Anything else on the customer of a membership or a payment plan is
          // one of its invoices. The first, paid within the hour of the
          // checkout, is the purchase itself; any later one is a renewal.
          if (session.mode !== "subscription" || !order) continue;
          charges.set(charge.id, charge);
          if (charge.at - order.at <= 3600 && order.cents === 0 && order.note !== "trial") {
            order.cents = charge.cents;
            order.currency = charge.currency;
            order.refunded = charge.refunded;
            continue;
          }
          orders.push({
            reference: str(raw.id),
            kind: "renewal",
            title: meta.title || order.title,
            at: charge.at,
            cents: charge.cents,
            currency: charge.currency,
            refunded: charge.refunded,
            channel: "",
            recorded: false,
            campaign: "",
            note: meta.kind === "plan" ? "plan" : "",
          });
        }
      });
    } catch (error) {
      console.error("reading a buyer's payments failed", error);
      stripeError = true;
    }
  }

  // Handed over without a payment here: brought from another platform, a
  // gift, a place someone bought for several, or a sale paid with PayPal.
  if (store.pastBuyers && store.statsId) {
    for (const given of await importedFor(store, email).catch(() => [])) {
      const listing = await find(given.productId);
      productIds.push(given.productId, ...(given.items ?? []));
      // A sale paid with PayPal is a sale (lib/paypal-sales.ts): its amount, its channel, counted in what they paid.
      const paypal = given.job.startsWith("paypal:") ? await readPaid(given.job.slice(7)).catch(() => null) : null;
      if (paypal && paypal.store === store.statsId) {
        const channel = saleChannel(paypal.meta ?? {});
        const recorded = Boolean(paypal.meta && "channel" in paypal.meta);
        orders.push({
          reference: "",
          kind: "sale",
          title: listing?.title ?? "A product that is no longer listed",
          at: paypal.at,
          cents: paypal.cents,
          currency: paypal.currency,
          refunded: 0,
          channel: channel.source,
          recorded,
          campaign: channel.campaign,
          note: "paypal",
        });
        sales.push({ at: paypal.at, source: channel.source, first: channel.first, recorded });
        charges.set(`paypal:${paypal.order}`, { id: `paypal:${paypal.order}`, cents: paypal.cents, refunded: 0, currency: paypal.currency, at: paypal.at });
        continue;
      }
      orders.push({
        reference: "",
        kind: "brought",
        title: listing?.title ?? "A product that is no longer listed",
        at: given.at,
        cents: 0,
        currency: store.currency,
        refunded: 0,
        channel: "",
        recorded: false,
        campaign: "",
        note: given.job.startsWith("paypal:") ? "paypal" : given.job.startsWith("gift:") ? "given" : isGroupJob(given.job) ? "for others" : "imported",
      });
    }
  }

  orders.sort((a, b) => b.at - a.at);

  // Money, each payment once, in the store's currency; any other kept apart.
  let paid = 0;
  let refunded = 0;
  const otherCurrencies: Record<string, number> = {};
  for (const charge of charges.values()) {
    if (charge.currency === store.currency) {
      paid += charge.cents;
      refunded += charge.refunded;
    } else {
      otherCurrencies[charge.currency] = (otherCurrencies[charge.currency] ?? 0) + charge.cents - charge.refunded;
    }
  }

  sales.sort((a, b) => a.at - b.at);
  const firstSale = sales[0];
  const lastSale = sales[sales.length - 1];
  const channelKnown = sales.some((s) => s.recorded);
  // Where they found the store is read from the sales that say: the earliest
  // and the latest of those, never a guess from a sale that says nothing.
  const firstRecorded = sales.find((s) => s.recorded);
  const lastRecorded = [...sales].reverse().find((s) => s.recorded);

  // The list, the sequences, the courses, the calls and the notes, side by side.
  const [contactRaw, flows, calls, notes] = await Promise.all([
    store.listId && isRedisConfigured() ? redisPipeline([["HGET", leadsKey(store.listId), email]]).then(([raw]) => raw) : Promise.resolve(null),
    store.listId ? readFlows(store.listId).catch(() => []) : Promise.resolve([]),
    callsFor(store, email).catch(() => [] as BookedCall[]),
    store.statsId ? readPersonNotes(store.statsId, person) : Promise.resolve([]),
  ]);
  const contact = parseContact(contactRaw);
  const started = new Set(await flowsStartedFor(flows, email).catch(() => [] as string[]));

  const courses: ProfileCourse[] = [];
  const seen = new Set<string>();
  for (const id of productIds) {
    if (seen.has(id) || courses.length >= MAX_COURSES) continue;
    seen.add(id);
    const listing = await find(id);
    if (!listing?.course) continue;
    const [done, dates] = await Promise.all([doneLessons(listing.course.id, email), studentDates(listing.course.id, email)]);
    courses.push({
      title: listing.title,
      done: Math.min(done.size, listing.course.lessons),
      lessons: listing.course.lessons,
      since: dates?.since ?? 0,
      lastSeen: dates?.lastSeen ?? 0,
    });
  }

  return {
    email,
    name: name || contact?.name || "",
    contact,
    orders,
    paid,
    refunded,
    currency: store.currency,
    otherCurrencies,
    purchases: orders.filter((o) => o.kind === "sale" || o.kind === "added").length,
    renewals: orders.filter((o) => o.kind === "renewal").length,
    firstAt: firstSale?.at ?? 0,
    lastAt: lastSale?.at ?? 0,
    firstChannel: firstRecorded ? firstRecorded.first || firstRecorded.source : "",
    lastChannel: lastRecorded?.source ?? "",
    channelKnown,
    memberships: memberships.sort((a, b) => b.since - a.since),
    courses,
    calls,
    sequences: flows.filter((f) => started.has(f.id)).map((f) => f.name),
    person,
    notes,
    partial,
    stripeError,
  };
}

/** Deletes the team's notes about one person (lib/person-erasure.ts). */
export async function forgetNotesPerson(statsId: string | null, person: string): Promise<number> {
  if (!statsId || !PERSON_KEY.test(person) || !isRedisConfigured()) return 0;
  const [gone] = await redisPipeline([["DEL", notesKey(statsId, person)], ["SREM", whoKey(statsId), person]]);
  return Number(gone) || 0;
}

/** Spends a search's token once the person it found is deleted (lib/person-erasure.ts). */
export async function forgetFindToken(token: string): Promise<void> {
  if (!FIND_TOKEN.test(token) || !isRedisConfigured()) return;
  await redisPipeline([["DEL", findKey(token)]]);
}
