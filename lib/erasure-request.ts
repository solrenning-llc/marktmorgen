/**
 * A person deleting themselves from a store, or from every store, without
 * asking anybody (added 17 October 2026). The page is /privacy/delete.
 *
 * They type their address, and the store's name when they came from one. If
 * that address is known there — on its list, as a buyer, or as having joined
 * it — a link is emailed to it; the page says the same whether or not it is,
 * so the form cannot be used to learn who buys from whom, and nothing is
 * sent to an address the stores do not know. The link works for an hour and
 * opens a page that says what will be deleted and what is kept; pressing
 * the button there deletes them (lib/person-erasure.ts), and each store's
 * owner is told it was done. Nobody is asked to approve it.
 *
 * Every store is the stores the address bought from or joined itself, as
 * lib/buyer-library.ts notes them: a store whose list an import alone put
 * them on is found when they ask from that store.
 *
 * Bounded like the library's link: a few asks an hour from one network
 * address and for one email address, one email per ask (taken from the
 * figure for such emails of the first of the stores with room, only up to the
 * share a visitor's typed address may take, as the sign-up box's are), and
 * each store's own erasure paid for from the budget for people's data rights,
 * never the store's studio figure (lib/person-erasure.ts, lib/rights-budget.ts):
 * when the month's has no room, it is scheduled and done by itself within the
 * month the law gives, and the page says by when. Asked from one store that has no room, the page
 * says from which day it can be asked again and gives the published privacy
 * contact. Asked for every store, the answer is "sent" whatever happened,
 * since anything else would depend on which stores know the address, and the
 * page that answer opens always gives the same contact.
 *
 *   nl:erase:link:<hash of a token>  { e: address, s: [store ids still to do] }, an hour
 */
import { after } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { withinLimit } from "@/lib/request-guard";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { type Store, storeForHandle, storeForId } from "@/lib/store";
import { leadsKey } from "@/lib/contacts";
import { storesKnownFor } from "@/lib/buyer-library";
import { erasePerson } from "@/lib/person-erasure";
import { allowanceWindow } from "@/lib/allowance-window";
import { allowancesUsedStrict } from "@/lib/store-allowance";
import { allowanceFor, askedCeiling } from "@/lib/store-allowance-rules";
import {
  ERASE_ASKS_PER_ADDRESS_HOUR,
  ERASE_ASKS_PER_IP_HOUR,
  ERASE_LINK_SECONDS,
  ERASE_TOKEN,
  MAX_ERASE_STORES,
} from "@/lib/erasure-rules";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:erase:link:${sha(`nimbus-erase-link:${token}`).slice(0, 40)}`;
const STORE_ID = /^[0-9a-f]{32}$/;
/** How long one press keeps deleting before it hands the rest to the next press. */
const PRESS_MS = 40_000;

type Grant = { e: string; s: string[] };

/** "full": asked from one store, it has no room in its share for a visitor's address (askedCeiling). Never asked for every store. */
export type EraseAsk = "sent" | "email" | "limited" | "error" | "full";

/** What an ask came to; `opens`, with "full": the start (00:00 UTC) of the first whole day the store's share is open again, in ms, when it is known. */
export type EraseAnswer = { status: EraseAsk; opens?: number };

type Room = { state: "room" } | { state: "full"; opens: number } | { state: "unknown" };

/**
 * Whether the store's access emails have room for one more to an address a
 * visitor typed (the share takeAllowance gives `asked`), read before the email
 * is taken so a link is sent from a store that can send it. "full" says from
 * which day its share is open again (0 when that is not known): the page shows
 * a day, not a time, so a window that ends during a day (23:30 UTC) counts
 * from the next one, never from a day it is still full on.
 */
async function askedRoom(store: Store, now = Date.now()): Promise<Room> {
  const row = (await allowancesUsedStrict(store, ["transactional"], now).catch(() => null))?.[0];
  if (!row) return { state: "unknown" };
  if (row.used + 1 <= askedCeiling(row.figure)) return { state: "room" };
  const window = allowanceWindow(store, now);
  const opens = window && askedCeiling(allowanceFor(store, "transactional", window.end / 1000)) > 0 ? nextWholeDay(window.end) : 0;
  return { state: "full", opens };
}

const DAY_MS = 86_400_000;
/** The moment itself when it is 00:00 UTC, otherwise 00:00 UTC of the day after. */
export const nextWholeDay = (ms: number) => Math.ceil(ms / DAY_MS) * DAY_MS;

const sooner = (a: number, b: number) => (a && b ? Math.min(a, b) : a || b);

/** Whether this store holds the address: on its list, or as a buyer or a joiner it noted. */
async function knows(store: Store, email: string, known: Set<string>): Promise<boolean> {
  if (store.sid && known.has(store.sid)) return true;
  if (!store.listId) return false;
  const [held] = await redisPipeline([["HEXISTS", leadsKey(store.listId), email]]);
  return Number(held) === 1;
}

/** The same, as the status alone. */
export async function requestErasureLink(input: { email: string; ip: string; origin: string; handle?: string }): Promise<EraseAsk> {
  return (await askErasureLink(input)).status;
}

/**
 * Emails a link that deletes this address from one store (by its address on
 * Marktmorgen) or from every store that knows it. "sent" whether or not any
 * does; nothing is sent when none does.
 *
 * Asked from one store, that store's room is read before whether it knows the
 * address, so a full store answers "full" (with the day it opens again) for
 * every address; the request already names the store.
 *
 * Asked for every store, the email is taken from the share of the first of the
 * stores that know the address with room for a visitor's address (askedRoom),
 * so one store whose share a stranger spent does not stop the link. The answer
 * is always "sent": "full" or "error" would only ever come to an address some
 * store knows, so after a stranger spent one store's share they would tell who
 * buys there (review C4-7). The page that answer opens always gives the
 * published privacy contact, for a link that does not arrive.
 */
export async function askErasureLink(input: { email: string; ip: string; origin: string; handle?: string }): Promise<EraseAnswer> {
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return { status: "email" };
  if (!isRedisConfigured() || !isSenderConfigured()) return { status: "error" };
  const email = normaliseEmail(raw);
  if (!(await withinLimit("erase-ip", input.ip, ERASE_ASKS_PER_IP_HOUR, 3_600))) return { status: "limited" };
  if (!(await withinLimit("erase-address", sha(email), ERASE_ASKS_PER_ADDRESS_HOUR, 3_600))) return { status: "limited" };
  if (input.handle) {
    const store = await storeForHandle(input.handle).catch(() => null);
    if (store?.sid) {
      // The store's room is read before anything about the address: "full" comes to every address alike.
      const room = await askedRoom(store);
      if (room.state === "full") return { status: "full", ...(room.opens ? { opens: room.opens } : {}) };
      // Whether the store knows the address, and the email, only after the answer (review of #2101, inbox
      // C4-15 (3)(a)): their time, and a send that fails or finds the room just taken, would only ever come to
      // an address the store knows. They go to the server's log; the page always gives the privacy contact.
      afterAnswer(async () => {
        const known = new Set(await storesKnownFor(email));
        if (!(await knows(store, email, known))) return;
        const answer = await emailLink([store], email, input.origin);
        if (answer.status !== "sent") console.warn(`a deletion link asked from one store was not emailed: ${answer.status} (store ${store.sid})`);
      });
    }
    return { status: "sent" };
  }
  // Every store: which stores know the address, and the email, only after the answer, for the same reason.
  afterAnswer(async () => {
    const stores: Store[] = [];
    for (const sid of (await storesKnownFor(email)).slice(0, MAX_ERASE_STORES)) {
      const store = await storeForId(sid).catch(() => null);
      if (store?.sid) stores.push(store);
    }
    if (!stores.length) return;
    const answer = await emailLink(stores, email, input.origin);
    if (answer.status !== "sent") console.warn(`a deletion link asked for every store was not emailed: ${answer.status} (stores ${stores.map((s) => s.sid).join(",")})`);
  });
  return { status: "sent" };
}

/**
 * Runs what depends on the address after the answer is sent (as lib/buyer-orders.ts does): inside the
 * route's time, or at once and unwaited when there is no request to wait for. What fails goes to the log.
 */
function afterAnswer(task: () => Promise<void>): void {
  const run = () =>
    task().catch((error: unknown) => {
      console.error("emailing a deletion link failed", error);
    });
  try {
    after(run);
  } catch {
    void run();
  }
}

/**
 * Emails the link from the first of these stores with room for a visitor's
 * address: "sent", "full" (none had room, with the soonest day one opens
 * again) or "error" (the sender failed).
 */
async function emailLink(stores: Store[], email: string, origin: string): Promise<EraseAnswer> {
  const token = randomBytes(32).toString("hex");
  const grant: Grant = { e: email, s: stores.map((s) => s.sid) };
  await redisPipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", ERASE_LINK_SECONDS]]);
  const names = stores.map((s) => s.name).slice(0, 10);
  const more = stores.length - names.length;
  const text = [
    stores.length === 1
      ? `Someone asked to delete everything ${stores[0].name} keeps about this address on Marktmorgen.`
      : `Someone asked to delete everything these stores on Marktmorgen keep about this address: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`,
    "",
    "To see what will be deleted and what has to be kept, and to delete it, open this link within an hour:",
    "",
    `${origin}/privacy/delete?token=${token}`,
    "",
    "Nothing is deleted until you press the button on that page. If you did not ask for this, ignore this email: nobody can delete your data without it.",
  ].join("\n");
  let full = false;
  let opens = 0;
  for (const sender of stores) {
    const room = await askedRoom(sender);
    if (room.state === "unknown") continue;
    if (room.state === "full") {
      full = true;
      opens = sooner(opens, room.opens);
      continue;
    }
    const sent = await sendEmail({
      // `asked` (MM-SA-05): the address was typed by a visitor, and a store knows every address on its
      // list, which a stranger can fill through the sign-up box, so these links take only the share of
      // the access emails such confirmations may (askedCeiling); the rest is kept for buyers' own links.
      meter: { by: "store", store: sender, kind: "transactional", asked: true },
      from: NIMBUS_FROM,
      to: email,
      subject: stores.length === 1 ? `Delete your data from ${stores[0].name}` : "Delete your data from stores on Marktmorgen",
      text,
    });
    if (sent) return { status: "sent" };
    // Its share was spent between the read and the send: the next store is asked. Any other
    // failure (the sender) is not passed on to another store's share, which it would only spend.
    const after = await askedRoom(sender);
    if (after.state !== "full") {
      full = false;
      break;
    }
    full = true;
    opens = sooner(opens, after.opens);
  }
  await redisPipeline([["DEL", linkKey(token)]]).catch(() => {});
  return full ? { status: "full", ...(opens ? { opens } : {}) } : { status: "error" };
}

/** The address a live link was sent to, and the stores it still deletes from; null when it has run out. */
export async function readErasureLink(token: string): Promise<{ email: string; stores: Store[] } | null> {
  if (!ERASE_TOKEN.test(token) || !isRedisConfigured()) return null;
  const reply = await redisPipeline([["GET", linkKey(token)]]);
  if (!exactGrantReply(reply, 1)) throw new Error("Your data could not be checked. Try again.");
  const [raw] = reply;
  if (raw === null) return null;
  const grant = parseGrant(raw);
  if (!grant) throw new Error("Your data could not be checked. Try again.");
  const stores = await Promise.all(grant.s.map(async (sid) => {
    const store = await storeForId(sid);
    // A missing store record cannot prove that no personal data remains.
    // Do not show only part of the scope the person is about to delete.
    if (!store) throw new Error("Your data could not be checked. Try again.");
    return store;
  }));
  return { email: grant.e, stores };
}

/** An absent response slot is not Redis's confirmed null for a missing key. */
function exactGrantReply(reply: unknown, length: number): reply is unknown[] {
  if (!Array.isArray(reply) || reply.length !== length) return false;
  for (let i = 0; i < length; i++) if (!Object.hasOwn(reply, i)) return false;
  return true;
}

function parseGrant(raw: unknown): Grant | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Grant>;
    if (typeof v.e !== "string" || !EMAIL_PATTERN.test(v.e) || !Array.isArray(v.s) || v.s.length === 0 || v.s.length > MAX_ERASE_STORES) return null;
    const ids = new Set<string>();
    for (const sid of v.s) {
      if (typeof sid !== "string" || !STORE_ID.test(sid) || ids.has(sid)) return null;
      ids.add(sid);
    }
    return { e: v.e, s: [...ids] };
  } catch {
    return null;
  }
}

export type EraseDone = {
  state: "done" | "more" | "gone";
  /** The stores they were deleted from by this press. */
  deleted: string[];
  /** The stores that could not finish now, kept on the link to press again. */
  later: string[];
  /**
   * How many stores' deletions are scheduled because the month's rights budget is used up (lib/person-erasure.ts,
   * "scheduled"): done by themselves, nothing to press again, by `by` (ms), the latest of their legal deadlines.
   * Absent when none were.
   */
  scheduled?: number;
  by?: number;
};

/**
 * Deletes the address from the link's stores, one after the other, until
 * they are done or PRESS_MS have gone; what is left stays on the link, so
 * pressing again finishes it. A store whose month's rights budget is used up
 * has it scheduled instead (`scheduled`, `by`), done by itself, and leaves the
 * link. Each store's owner is told, with the address, once it is done
 * (here, or by lib/rights-queue.ts), so they can delete it from their own
 * tools too (Stripe, an email platform).
 */
export async function confirmErasure(token: string, now = Date.now()): Promise<EraseDone> {
  if (!ERASE_TOKEN.test(token) || !isRedisConfigured()) return { state: "gone", deleted: [], later: [] };
  const key = linkKey(token);
  const reply = await redisPipeline([["GET", key], ["TTL", key]]);
  // Unknown scope stays pending without consuming or rewriting its grant.
  const pending: EraseDone = { state: "more", deleted: [], later: [] };
  if (!exactGrantReply(reply, 2)) return pending;
  const [raw, ttl] = reply;
  if (raw === null && ttl === -2) return { state: "gone", deleted: [], later: [] };
  const grant = parseGrant(raw);
  if (!grant || typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl <= 0) return pending;
  const deleted: string[] = [];
  const later: string[] = [];
  let scheduled = 0;
  let by = 0;
  for (const sid of grant.s) {
    if (Date.now() - now > PRESS_MS) {
      later.push(sid);
      continue;
    }
    const store = await storeForId(sid).catch(() => null);
    if (!store) {
      // Unknown is still to do: never discard the grant and claim completion
      // while this store's data could not even be reached.
      later.push(sid);
      continue;
    }
    const result = await erasePerson(store, grant.e, { kind: "person" }).catch(() => ({ ok: false as const, reason: "unavailable" as const }));
    if (!result.ok && result.reason === "scheduled") {
      scheduled += 1;
      by = Math.max(by, result.by);
      continue;
    }
    if (!result.ok) {
      later.push(sid);
      continue;
    }
    deleted.push(store.name);
    await tellOwner(store, grant.e).catch((error: unknown) => console.error("telling a store's owner about a deletion failed", error));
  }
  const waiting = scheduled ? { scheduled, by } : {};
  if (later.length) {
    await redisPipeline([["SET", key, JSON.stringify({ e: grant.e, s: later } satisfies Grant), "EX", Math.max(60, ttl)]]);
    return { state: "more", deleted, later, ...waiting };
  }
  await redisPipeline([["DEL", key]]);
  return { state: "done", deleted, later, ...waiting };
}

/** The owner's note for a deletion the person asked for, done later by the hourly job (lib/rights-queue.ts). */
export async function tellOwnerErased(store: Store, email: string): Promise<void> {
  await tellOwner(store, email);
}

/** The owner's note: done, not asked. One of the store's own emails (lib/store-allowance-rules.ts, "email"). */
async function tellOwner(store: Store, email: string): Promise<void> {
  await sendEmail({
    meter: { by: "store", store, kind: "email" },
    from: NIMBUS_FROM,
    to: store.email,
    subject: `A person deleted their data from ${store.name}`,
    text: [
      `${email} asked, through the link we emailed them, to be deleted from ${store.name}, and it is done.`,
      "",
      "Deleted: their place on your list, your fields, notes and deals about them, your team's tasks about them, their form answers, workflow history, course progress, community record, reviews, waitlist places and inbox conversations. Your store will not email them again; only they can change that, by joining your list again themselves.",
      "",
      "Not deleted yet: posts and comments they wrote in your community stay, shown without their name. Delete them from the community if they ask.",
      "",
      "Kept: their payments on your own Stripe account, which are your sales and tax records, and the order records a sale or a refund still needs. Each one is listed at marktmorgen.com/privacy#delete.",
      "",
      "If you also keep them anywhere else (a connected email platform, your own files), delete them there too.",
    ].join("\n"),
  });
}
