/**
 * Who may come into a store's community, asked again on every request.
 *
 * The creator chooses which of their products open it. Buying any one of
 * them is the ticket, read from the creator's own Stripe account — the
 * record of who paid for what — and never from anything a visitor says:
 *
 *   - a one-off product, a call or a course: a settled payment that was not
 *     refunded in full (a payment plan counts from its first payment, as it
 *     does for a course);
 *   - a membership: only while its subscription is live — active, in its
 *     trial, or with a payment being retried. A membership that is cancelled
 *     or stops being paid closes the door on the next check;
 *   - something free, when the creator includes it: the address confirmed it
 *     reads its own inbox by using the link we emailed (lib/free.ts), and the
 *     creator's list says so;
 *   - a purchase the creator brought over from another platform
 *     (lib/imported-purchases.ts) of a product that opens the community, or
 *     of a bundle that held one. Only the store's owner and Admins can bring
 *     buyers over, a membership never can be, and the creator's "remove"
 *     closes the door on one of them as on anybody.
 *
 * A product added in the box at checkout, or in one click after it, counts
 * the same as one bought on its own.
 *
 * Nobody makes an account. A member is somebody whose address is proved the
 * way a course student's is (lib/learn.ts): a link emailed to the address,
 * after which the browser holds the store's pass for 90 days, or a Marktmorgen
 * sign-in with that address. A pass made in the browser that paid for one
 * course opens that course only, and is not enough here: the community is
 * where a member is seen by others, so the address has to be shown to be
 * theirs, not only to have been typed at a checkout.
 *
 * Stripe's answer is kept for five minutes when it lets somebody in and for
 * one minute when it does not, so a page does not wait on Stripe every time
 * and somebody who just bought is not kept out for long. A membership that
 * lapses therefore loses the door within five minutes; the creator taking a
 * member out (lib/community.ts, `removed`) is read on every request and is
 * immediate.
 *
 * The community's own doors (the gate, its spaces, its events, the lessons a
 * search finds) are all answered from one reading of what the person holds
 * (holdingsOf), kept per community, person and settings' version: a page of
 * twenty events or lessons asks Stripe once, not twenty times (the
 * pre-review of 9 November 2026, P1).
 *
 *   nl:cm:<id>:h:<address key>    what the address holds, read whole (or not known for good, a minute), with the settings' version and the products asked
 *   nl:cm:<id>:ok:<address key>   Stripe's latest answer, with the settings' version
 *   nl:cm:link:<hash>             an emailed link: who, which store (1 hour)
 *   nl:cm:link:<hash>:opens       how often it was used (at most 10)
 *   nl:rl:cm:ip:<hash>, nl:rl:cm:addr:<hash>   how often a link was asked for
 */
import { spaceGate } from "@/lib/community-gate";
import { currentMeta } from "@/lib/tier-rules";
import { saleHandles } from "@/lib/store";
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { communityWords } from "@/lib/buyer-words/community";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { orderWrite } from "@/lib/order-data";
import { type DataStore, DataRoomError } from "@/lib/store-data";
import { StripeBodyTooLarge, StripeError, onAccount } from "@/lib/stripe-account";
import { STRIPE_TIMEOUT_MS } from "@/lib/fetch-timeout";
// The one Stripe version these lists are read at, so their shape is the one checked here (Revisor 1 on #2464).
import { STRIPE_VERSION } from "@/lib/stripe-connect";
import { readStripePage } from "@/lib/stripe-list";
import {
  REFUND_CHECK_WAITS,
  TICKET_CUSTOMERS,
  TICKET_CUSTOMERS_SIDE_BY_SIDE,
  TICKET_PAYMENT_PAGES,
  TICKET_PAYMENT_PAGE_BYTES,
  TICKET_PAYMENT_PAGE_ROWS,
  TICKET_REFUND_CHECKS,
  TICKET_REFUND_READ_BYTES,
  TICKET_SESSION_PAGES,
  TICKET_SESSION_PAGE_BYTES,
  TICKET_SESSION_PAGE_ROWS,
} from "@/lib/community-read-rules";
import { isSettled } from "@/lib/instant-pay";
import { isLiveSub } from "@/lib/membership-access";
import { RefundReadCapped, type RefundReadLimits, keptUnlessLost, purchaseRefunded, refundReader, refundedInFull } from "@/lib/refunds";
import { leadsKey, parseContact } from "@/lib/contacts";
import { type Learner, TOKEN_PATTERN, emailKey, learnerFrom, storeKey } from "@/lib/learn";
import type { Listing, Store } from "@/lib/store";
import { KIND, itemFor, readListings } from "@/lib/catalog";
import { deliveredIds } from "@/lib/bundle-rules";
import { importedFor } from "@/lib/imported-purchases";
import {
  CREATOR,
  type CommunityConfig,
  type Member,
  type Space,
  memberKey,
  readConfig,
  readMember,
  touchMember,
} from "@/lib/community";
import { send as sendMessage } from "@/lib/community-dm";

const OPEN_SECONDS = 5 * 60;
const SHUT_SECONDS = 60;
export const LINK_SECONDS = 60 * 60;
const MAX_LINK_OPENS = 10;
const IP_LIMIT = 10;
const ADDRESS_LIMIT = 5;
const RATE_WINDOW_SECONDS = 60 * 60;
const CUSTOMER_PATTERN = /^cus_[A-Za-z0-9]{6,64}$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const okKey = (id: string, email: string) => `nl:cm:${id}:ok:${emailKey(email)}`;
const linkKey = (token: string) => `nl:cm:link:${sha(`nimbus-community:${token}`).slice(0, 40)}`;
const opensKey = (token: string) => `${linkKey(token)}:opens`;

/** The products of this store that the settings let in, as they are now. */
export async function accessProducts(store: Store, config: CommunityConfig): Promise<Listing[]> {
  return readListings(store, config.access);
}

type Row = Record<string, unknown>;

/** A list from Stripe that is not one, or that has more than was read: whether the address holds anything is not known. */
export class UnreadPurchasesError extends Error {
  /**
   * True when asking again gives the same answer: Stripe has more than the pages read of this address's
   * checkouts or payments (TICKET_SESSION_PAGES, TICKET_PAYMENT_PAGES), more customers for it than are asked
   * (TICKET_CUSTOMERS), or more purchases to ask a refund of than are asked (TICKET_REFUND_CHECKS). A reply that
   * is not a list at all may be a passing fault, and is not.
   */
  readonly lasting: boolean;
  constructor(what: string, lasting = false) {
    super(`the purchases could not be read in full: ${what}`);
    this.name = "UnreadPurchasesError";
    this.lasting = lasting;
  }
}

/**
 * Whether a strict door's "could not be asked" (holdsTicket, holdsAnyOf with `strict`) will be the same however
 * often it is asked again, so a send waiting on it would wait for good (review of #3140, M2): an address whose
 * purchases are more than is read (UnreadPurchasesError `lasting`), or a request Stripe refuses as such (400, 403
 * or 404, or `account_invalid`: the store's Stripe account disconnected, or no longer reachable by us). Anything
 * else (a timeout, a 429 or 5xx, Redis) may pass, and the caller tries again, a bounded number of times.
 */
export function askingAgainWontTell(error: unknown): boolean {
  if (error instanceof UnreadPurchasesError) return error.lasting;
  if (error instanceof StripeError) return error.code === "account_invalid" || error.status === 400 || error.status === 403 || error.status === 404;
  return false;
}

/** Whether every list read for one answer was read to its end, every row readable (lib/stripe-list.ts). */
type Reading = { whole: boolean };

/**
 * The rows of one Stripe list, page after page from `starting_after`, each page read in its exact shape
 * (lib/stripe-list.ts, readStripePage; CX-123 rule 24): a page in another shape throws, so it is never read as
 * "bought nothing". At most `pages` pages; a row that does not read, more pages than that, or a last row with no
 * id to go on from leaves the reading not whole, so a "no" read from it is not said (Codex G on #2464).
 */
async function* pagesOf(
  account: string,
  path: string,
  query: URLSearchParams,
  legible: (row: Row) => boolean,
  pages: number,
  reading: Reading,
  /** The most bytes one page is read to: a heavier page is not known, and asking again tells no more. */
  maxBytes: number,
): AsyncGenerator<Row[]> {
  let after = "";
  for (let page = 0; page < pages; page += 1) {
    if (after) query.set("starting_after", after);
    const answer = await onAccount("GET", account, `${path}?${query}`, undefined, STRIPE_VERSION, undefined, STRIPE_TIMEOUT_MS, maxBytes).catch((error: unknown) => {
      if (error instanceof StripeBodyTooLarge) throw new UnreadPurchasesError("a page heavier than is read", true);
      throw error;
    });
    const read = readStripePage(answer, legible);
    if (read.unreadable > 0) reading.whole = false;
    yield read.rows;
    if (!read.hasMore) return;
    if (!read.lastId) break;
    after = read.lastId;
  }
  reading.whole = false;
}

const isRecord = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const SESSION_STATES = new Set(["open", "complete", "expired"]);
const SESSION_PAYMENTS = new Set(["paid", "unpaid", "no_payment_required"]);
const INTENT_STATES = new Set(["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled", "succeeded"]);
/** A field Stripe always fills, read only when it is one of Stripe's own values: absent is not known (Codex G on #2464). */
const oneOf = (value: unknown, known: Set<string>) => typeof value === "string" && known.has(value);
const hasId = (row: Row) => typeof row.id === "string" && row.id.length > 0;
const hasMeta = (row: Row) => row.metadata === undefined || row.metadata === null || isRecord(row.metadata);
/** A Checkout Session as Stripe lists it: an id, and its state and payment state among Stripe's own. */
const isSessionRow = (row: Row) => hasId(row) && hasMeta(row) && oneOf(row.status, SESSION_STATES) && oneOf(row.payment_status, SESSION_PAYMENTS);
/** A PaymentIntent as Stripe lists it: an id and a state among Stripe's own. */
const isIntentRow = (row: Row) => hasId(row) && hasMeta(row) && oneOf(row.status, INTENT_STATES);

/** The rule every door uses for a refund (lib/refunds.ts). */
const refunded = refundedInFull;

/**
 * What one refund question asked here may read, enforced by lib/refunds.ts (refundReader): the calls and bytes it is
 * priced at (tests/plan-cost-registry.ts, ACCESS_CHECK_READ). Past them it throws RefundReadCapped, read here as an
 * answer not known for good, never as "kept" (Claude 2's review of #3395: a payment plan's question read about 22).
 */
const REFUND_READ: RefundReadLimits = { calls: REFUND_CHECK_WAITS, maxBytes: TICKET_REFUND_READ_BYTES };

/** A refund question asked inside REFUND_READ: given back, kept, or "capped" when it would read past it. */
async function withinRefundRead(ask: () => Promise<boolean>): Promise<boolean | "capped"> {
  try {
    return await ask();
  } catch (error) {
    if (error instanceof RefundReadCapped) return "capped";
    throw error;
  }
}

/**
 * Whether this address paid for one of `ids` on the creator's Stripe account
 * and still holds it: not refunded, and for a membership, still running.
 */
export async function paidForAny(store: Store, email: string, ids: Set<string>): Promise<boolean> {
  const read = await paidHoldings(store, email, ids, true);
  if (read.held.size > 0) return true;
  // Nothing found, but not everything was read: unknown, never "holds none of them". A door that does not need to
  // know (not strict) lets nobody in on it and keeps no answer; a strict door says it could not be asked.
  if (!read.whole) throw new UnreadPurchasesError("more than is read", true);
  return false;
}

/**
 * Which of `ids` this address paid for on the creator's Stripe account and still holds, and whether the purchases
 * were read whole: one not held is "no" only when they were. `any`: stop at the first one held (a door that needs one).
 * Throws when Stripe could not be asked.
 */
async function paidHoldings(store: Store, email: string, ids: ReadonlySet<string>, any: boolean): Promise<{ held: Set<string>; whole: boolean }> {
  const held = new Set<string>();
  const account = store.stripeAccountId;
  if (!account || ids.size === 0) return { held, whole: true };
  const enough = () => (any ? held.size > 0 : held.size >= ids.size);
  const handles = saleHandles(store);
  const customers = new Set<string>();
  // Whether every list read here was read to its end: a "no" is only a "no" when it was.
  const reading: Reading = { whole: true };
  // A refund or a lost dispute is asked of Stripe for at most TICKET_REFUND_CHECKS purchases (the reads stay
  // bounded); one more that would need asking leaves the answer unread, never "no".
  let refundChecks = 0;
  const mayAsk = (asks: boolean) => {
    if (!asks) return true;
    if (refundChecks >= TICKET_REFUND_CHECKS) return false;
    refundChecks += 1;
    return true;
  };
  // Stripe keeps the address as it was typed at checkout.
  const variants = [...new Set([email.trim(), normaliseEmail(email)])];
  for (const variant of variants) {
    const query = new URLSearchParams({ "customer_details[email]": variant, status: "complete", limit: String(TICKET_SESSION_PAGE_ROWS) });
    query.append("expand[]", "data.subscription");
    query.append("expand[]", "data.subscription.latest_invoice");
    query.append("expand[]", "data.payment_intent.latest_charge");
    for await (const rows of pagesOf(account, "/checkout/sessions", query, isSessionRow, TICKET_SESSION_PAGES, reading, TICKET_SESSION_PAGE_BYTES)) {
      for (const session of rows) {
        // A membership switched to another tier hands over what it is on now (lib/tier-rules.ts).
        const meta = currentMeta((session.metadata ?? {}) as Record<string, string>, session);
        if (!handles.has(meta.store ?? "")) continue;
        if (!isSettled(session)) continue;
        // Only a checkout that carried the offers after paying can have a one-click addition on its customer
        // (lib/upsell.ts takes no offer without `upsell_key`, and charges the checkout's own customer). Added before the
        // checkout's own refund is read: an addition is its own payment, kept when the checkout is refunded, and read
        // on its own below (Claude 2's review of #3395: it read as "not held").
        if (carriedOffers(session) && typeof session.customer === "string" && CUSTOMER_PATTERN.test(session.customer)) customers.add(session.customer);
        if (refunded(session.payment_intent)) continue;
        // A product in a bundle opens the door as if bought on its own; one already found held is not asked again.
        const bought = deliveredIds(meta).filter((id) => ids.has(id) && !held.has(id));
        if (!bought.length) continue;
        // A payment plan's first payment is read only for a purchase that would open the door.
        if (!mayAsk((session.mode === "subscription" && meta.kind === "plan") || disputed(session.payment_intent))) {
          reading.whole = false;
          continue;
        }
        const gone = await withinRefundRead(() => purchaseRefunded(account, session, REFUND_READ));
        // Past what the question may read, whether it was given back is not known: never held, never "no".
        if (gone === "capped") {
          reading.whole = false;
          continue;
        }
        if (gone) continue;
        // A membership opens the door while it is being paid for; a payment
        // plan is a one-off paid in parts, and counts like one.
        if (session.mode === "subscription" && meta.kind !== "plan") {
          const sub = session.subscription as { status?: unknown } | null;
          // The same rule as every other door a membership opens (lib/membership-access.ts).
          if (!sub || typeof sub !== "object" || !isLiveSub(sub)) continue;
        }
        for (const id of bought) held.add(id);
        if (enough()) return { held, whole: true };
      }
    }
  }
  // What was added in one click after paying is its own payment.
  // At most TICKET_CUSTOMERS customers are asked, TICKET_CUSTOMERS_SIDE_BY_SIDE at a time (the reads stay bounded);
  // more than that leaves the answer unread, not "no".
  if (customers.size > TICKET_CUSTOMERS) reading.whole = false;
  const asked = [...customers].slice(0, TICKET_CUSTOMERS);
  const payments: Row[] = [];
  for (let from = 0; from < asked.length; from += TICKET_CUSTOMERS_SIDE_BY_SIDE) {
    const group = await Promise.all(
      asked.slice(from, from + TICKET_CUSTOMERS_SIDE_BY_SIDE).map(async (customer) => {
        const query = new URLSearchParams({ customer, limit: String(TICKET_PAYMENT_PAGE_ROWS) });
        query.append("expand[]", "data.latest_charge");
        const rows: Row[] = [];
        for await (const page of pagesOf(account, "/payment_intents", query, isIntentRow, TICKET_PAYMENT_PAGES, reading, TICKET_PAYMENT_PAGE_BYTES)) rows.push(...page);
        return rows;
      }),
    );
    payments.push(...group.flat());
  }
  for (const intent of payments) {
    const meta = (intent.metadata ?? {}) as Record<string, string>;
    if (meta.kind !== "upsell" || !handles.has(meta.store ?? "")) continue;
    if (intent.status !== "succeeded" || refunded(intent)) continue;
    const bought = deliveredIds(meta).filter((id) => ids.has(id) && !held.has(id));
    if (!bought.length) continue;
    // Lost to a dispute is given back too (lib/refunds.ts); asked only of a
    // charge Stripe marks disputed, and a failed read keeps it, as a refund read does.
    if (!mayAsk(disputed(intent))) {
      reading.whole = false;
      continue;
    }
    const lost = await withinRefundRead(() => keptUnlessLost(account, intent, refundReader(account, REFUND_READ)));
    if (lost === "capped") {
      reading.whole = false;
      continue;
    }
    if (lost) continue;
    for (const id of bought) held.add(id);
    if (enough()) return { held, whole: true };
  }
  return { held, whole: reading.whole };
}

/** Whether a checkout carried the offers after paying (lib/store-checkout.ts, lib/cart-checkout.ts: metadata `upsell_key`). */
function carriedOffers(session: Row): boolean {
  const meta = session.metadata;
  return isRecord(meta) && typeof meta.upsell_key === "string" && meta.upsell_key.length > 0;
}

/** Whether a payment's charge, as Stripe expanded it, is marked disputed: only then is a lost dispute asked about (lib/refunds.ts disputeLost). */
function disputed(payment: unknown): boolean {
  // The same charge lib/refunds.ts reads (chargeOf): a Charge itself, or a payment's latest charge as expanded.
  const charge = !isRecord(payment) ? null : payment.object === "charge" ? payment : isRecord(payment.latest_charge) ? payment.latest_charge : null;
  return Boolean(charge && charge.disputed === true);
}

/** Which of these free things a confirmed address on the creator's list got. */
async function gotFree(store: Store, email: string, ids: ReadonlySet<string>): Promise<string[]> {
  if (!store.listId || ids.size === 0) return [];
  const [raw] = await redisPipeline([["HGET", leadsKey(store.listId), normaliseEmail(email)]]);
  const contact = parseContact(raw);
  return contact ? contact.ids.filter((id) => ids.has(id)) : [];
}

/** Which of these products the creator brought this address over holding, alone or in a bundle. */
async function broughtOver(store: Store, email: string, ids: ReadonlySet<string>): Promise<string[]> {
  if (!store.pastBuyers || ids.size === 0) return [];
  const given = await importedFor(store, email);
  return given.flatMap((p) => [p.productId, ...(p.items ?? [])]).filter((id) => ids.has(id));
}

/**
 * Whether this address holds a ticket in, by the settings as they are now.
 * Stripe is asked at most once every five minutes per address (once a minute
 * while the answer is no); a change to the settings asks again at once.
 */
export async function holdsTicket(store: Store, config: CommunityConfig, email: string, options: { strict?: boolean } = {}): Promise<boolean> {
  const id = store.community?.id;
  if (!id) return false;
  // `strict`, for deciding who an email goes to (lib/community-mail.ts, lib/community-event-mail.ts): an answer that
  // could not be had throws instead of being a no, so nobody is left out of a batch counted as sent (rules 24 and 30).
  if (!isRedisConfigured()) {
    if (options.strict) throw new Error("the database is not set up");
    return false;
  }
  return ticketFor(store, config.access, email, okKey(id, email), config.v, options.strict === true);
}

/**
 * The same question for a narrower door: whether this address holds one of
 * `ids` — a live event open only to the buyers of some of the community's
 * products (lib/community-events.ts). Its answer is kept under `cacheKey`
 * with `version`, apart from the community's own, for the same five minutes
 * (one while it is no), so a membership that lapses loses the event with the
 * community.
 */
export async function holdsAnyOf(store: Store, ids: string[], email: string, cacheKey: string, version: string, options: { strict?: boolean } = {}): Promise<boolean> {
  if (!store.community?.id) return false;
  // `strict` as holdsTicket's: an answer that could not be had throws, never a no.
  if (!isRedisConfigured()) {
    if (options.strict) throw new Error("the database is not set up");
    return false;
  }
  return ticketFor(store, ids, email, cacheKey, version, options.strict === true);
}

/**
 * The same question for any product, without a community: whether this
 * address holds one of `ids` now — paid and not refunded, a membership still
 * running, given for free, brought over or given as a gift. For a private
 * podcast's feed (lib/podcast-access.ts). Cached like the community's answer.
 */
export async function holdsProducts(store: Store, ids: string[], email: string, cacheKey: string, version: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  return ticketFor(store, ids, email, cacheKey, version);
}

/**
 * The same question, for a door that takes something away when the answer
 * is no (lib/discord-access.ts): Stripe that cannot be asked is not a no.
 * Throws instead, so nothing is taken from anybody on a failed request.
 */
export async function holdsProductsOrThrow(store: Store, ids: string[], email: string, cacheKey: string, version: string): Promise<boolean> {
  if (!isRedisConfigured()) throw new Error("the database is not set up");
  return ticketFor(store, ids, email, cacheKey, version, true);
}

/** Whether an address holds a ticket: yes, no, or not known just now (Stripe could not be read whole). */
export type Ticket = boolean | "unknown";

/**
 * What one address holds among some products, as read once (holdingsOf): the ones it holds, and whether the rest
 * are known not to be held.
 */
export type Holdings = {
  /** The products among those asked that the address holds now. */
  held: ReadonlySet<string>;
  /** Whether every product asked was read to an answer; when false, one not in `held` is not known. */
  whole: boolean;
  /**
   * When not whole: whether asking again would tell no more (askingAgainWontTell): more purchases than are read, a
   * page heavier than is read, or a request Stripe refuses as such. A door then says to write to the creator,
   * never "try again in a minute".
   */
  lasting: boolean;
  /**
   * When `lasting`, why: "volume", the purchases are more, or heavier, than one reading takes in (the address may hold
   * a ticket past them, so "Send me the link" still sends it); "refused", the store's Stripe account refuses the read
   * (account_invalid, 400, 403, 404: nothing about this address is known, so no link is made for it).
   */
  why?: LastingWhy;
  /** What went wrong, when not whole: what a strict door throws. */
  unread?: unknown;
};

/** Why a reading will stay not known however often it is asked (Holdings `why`). */
export type LastingWhy = "volume" | "refused";

/** The answer for a door kept for `ids`: yes when one is held; no only when the reading was whole. */
export function heldAnswer(holdings: Holdings, ids: readonly string[]): Ticket {
  if (ids.some((id) => holdings.held.has(id))) return true;
  return holdings.whole ? false : "unknown";
}

/**
 * Whether a "not known" answered from this reading will be the same however often it is asked (Holdings `lasting`):
 * every door that says it then says to write to the creator, never to reload or try again in a minute (the
 * pre-review of 9 November 2026, round 2).
 */
export function unknownForGood(holdings: Holdings | null | undefined): boolean {
  return Boolean(holdings && !holdings.whole && holdings.lasting);
}

/** A reading that failed on `error`: not known, for good when asking again will not tell, with why (Holdings `why`). */
function notRead(error: unknown): Holdings {
  const lasting = askingAgainWontTell(error);
  if (!lasting) return { held: new Set(), whole: false, lasting, unread: error };
  return { held: new Set(), whole: false, lasting, why: error instanceof UnreadPurchasesError ? "volume" : "refused", unread: error };
}

/**
 * Which of `ids` this address holds now — paid and not refunded, a membership still running, given for free or
 * brought over — read whole, or as far as it could be. Never throws: what could not be read is in `unread`.
 * `any`: stop at the first one held (a door that needs one of them).
 */
async function readHoldings(store: Store, email: string, ids: readonly string[], any: boolean): Promise<Holdings> {
  // Which products let in, and whether each is free, is in the store record.
  const products = ids.flatMap((pid) => {
    const item = itemFor(store, pid);
    return item ? [{ id: item.id, free: (item.kind & KIND.free) !== 0 }] : [];
  });
  const held = new Set<string>();
  if (products.length === 0) return { held, whole: true, lasting: false };
  const enough = () => any && held.size > 0;
  try {
    // Stripe last: the other two are one read each.
    for (const id of await gotFree(store, email, new Set(products.filter((p) => p.free).map((p) => p.id)))) held.add(id);
    const brought = enough() ? [] : (await broughtOver(store, email, new Set(products.map((p) => p.id))));
    for (const id of brought) held.add(id);
    const left = new Set(products.filter((p) => !p.free && !held.has(p.id)).map((p) => p.id));
    if (!enough() && left.size > 0) {
      const paid = await paidHoldings(store, email, left, any);
      for (const id of paid.held) held.add(id);
      if (!paid.whole) {
        const unread = new UnreadPurchasesError("more than is read", true);
        return { held, whole: false, lasting: true, why: "volume", unread };
      }
    }
    return { held, whole: true, lasting: false };
  } catch (error) {
    // What was found before the failure still stands; the rest is not known.
    return { ...notRead(error), held };
  }
}

const holdingsKey = (id: string, email: string) => `nl:cm:${id}:h:${emailKey(email)}`;

/**
 * A reading kept for this version that asked every one of `asked`, or null. One kept `lasting` is a reading that was
 * not whole and that asking again would not make whole (more purchases than are read): what it found held still
 * stands, the rest is not known.
 */
function keptHoldings(raw: unknown, version: number, asked: readonly string[]): Holdings | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as { v?: unknown; ids?: unknown; held?: unknown; lasting?: unknown; why?: unknown };
    if (value.v !== version || !Array.isArray(value.ids) || !Array.isArray(value.held)) return null;
    if (value.lasting !== undefined && value.lasting !== true) return null;
    // A lasting reading kept without why it lasts is read again: what "Send me the link" does turns on it.
    const why = value.why === "volume" || value.why === "refused" ? value.why : null;
    if (value.lasting === true && !why) return null;
    const ids = new Set(value.ids.filter((id): id is string => typeof id === "string"));
    if (!asked.every((id) => ids.has(id))) return null;
    const held = new Set(value.held.filter((id): id is string => typeof id === "string" && ids.has(id)));
    if (value.lasting === true && why) return { held, whole: false, lasting: true, why, unread: new UnreadPurchasesError("more than is read (kept a minute)", true) };
    return { held, whole: true, lasting: false };
  } catch {
    return null;
  }
}

/**
 * What this address holds among the community's products and `extra` (the products of the lessons a search found),
 * read once and kept per community, address and settings' version, so the gate, the spaces, the events and the
 * lessons of a page are all answered from it (the pre-review of 9 November 2026, P1). Kept five minutes when it
 * holds every product asked, one minute otherwise, as the answers it replaces were; only a reading that was whole
 * is kept, so a "not known" is asked again on the next page.
 *
 * `pay`, when given, is asked only when no reading is kept, after the kept one is looked for and before Stripe is:
 * refused, nothing is read and the answer is "refused" (the caller shows the resting page).
 */
export async function holdingsOf(store: Store, config: CommunityConfig, email: string, extra?: readonly string[]): Promise<Holdings>;
export async function holdingsOf(store: Store, config: CommunityConfig, email: string, extra: readonly string[], pay: () => Promise<boolean>): Promise<Holdings | "refused">;
export async function holdingsOf(
  store: Store,
  config: CommunityConfig,
  email: string,
  extra: readonly string[] = [],
  pay?: () => Promise<boolean>,
): Promise<Holdings | "refused"> {
  const id = store.community?.id;
  const asked = [...new Set([...config.access, ...extra])].filter((pid) => itemFor(store, pid));
  if (!id || asked.length === 0) return { held: new Set(), whole: true, lasting: false };
  if (!isRedisConfigured()) return notRead(new Error("the database is not set up"));
  let raw: unknown;
  try {
    [raw] = await redisPipeline([["GET", holdingsKey(id, email)]]);
  } catch (error) {
    return notRead(error);
  }
  const kept = keptHoldings(raw, config.v, asked);
  if (kept) return kept;
  if (pay && !(await pay())) return "refused";
  const read = await readHoldings(store, email, asked, false);
  if (!read.whole) console.error("reading what a community member holds failed", read.unread);
  // A passing fault is not kept, so the next page asks again. One that asking again will not change (more purchases
  // than are read) is kept a minute, as a "no" is, so a member past it does not cost every page a reading of Stripe.
  if (!read.whole && !read.lasting) return read;
  const every = read.whole && asked.every((pid) => read.held.has(pid));
  const record = { v: config.v, ids: asked, held: [...read.held], ...(read.whole ? {} : { lasting: true, why: read.why }) };
  // Keeping it is a saving only: a failed write leaves the reading just made to decide.
  await redisPipeline([["SET", holdingsKey(id, email), JSON.stringify(record), "EX", every ? OPEN_SECONDS : SHUT_SECONDS]]).catch(
    (error) => console.error("keeping what a community member holds failed", error),
  );
  return read;
}

/**
 * Whether this address holds a community ticket, said as it is: "unknown" when Stripe could not be asked, or not
 * read to its end (CX-123 rule 24, 9 November 2026), never a "no" a paying member would be told as "you have
 * nothing that opens it". From the reading the community's doors share (holdingsOf), or `holdings` when the caller
 * has it.
 */
export async function ticketState(store: Store, config: CommunityConfig, email: string, holdings?: Holdings): Promise<Ticket> {
  if (!store.community?.id) return false;
  return heldAnswer(holdings ?? (await holdingsOf(store, config, email)), config.access);
}

async function ticketFor(store: Store, ids: string[], email: string, cacheKey: string, version: number | string, strict = false): Promise<boolean> {
  const answer = await ticketAnswer(store, ids, email, cacheKey, version);
  if ("ok" in answer) return answer.ok;
  // Stripe could not be asked, or not read whole. Nobody is let in on a guess, and the answer is not kept, so the
  // next page asks again. A door that would take something away on a no is told it could not be asked.
  if (strict) throw answer.unread;
  console.error("checking community access failed", answer.unread);
  return false;
}

/**
 * Stripe's answer for one address and these products, kept under `cacheKey` with `version`: `ok` when it is known,
 * `unread` (what went wrong) when it is not. Only a known answer is kept; keeping it is a saving only, so a failed
 * write leaves the answer just read to decide.
 */
async function ticketAnswer(store: Store, ids: string[], email: string, cacheKey: string, version: number | string): Promise<{ ok: boolean } | { unread: unknown }> {
  if (!ids.some((pid) => itemFor(store, pid))) return { ok: false };
  const [cached] = await redisPipeline([["GET", cacheKey]]);
  if (typeof cached === "string") {
    try {
      const value = JSON.parse(cached) as { v?: unknown; ok?: unknown };
      if (value.v === version && typeof value.ok === "boolean") return { ok: value.ok };
    } catch {}
  }
  const read = await readHoldings(store, email, ids, true);
  const answer = heldAnswer(read, ids);
  if (answer === "unknown") return { unread: read.unread };
  await redisPipeline([["SET", cacheKey, JSON.stringify({ v: version, ok: answer }), "EX", answer ? OPEN_SECONDS : SHUT_SECONDS]]).catch((error) => {
    console.error("keeping a community access answer failed", error);
  });
  return { ok: answer };
}

/**
 * Whether somebody the community let in may see one space: the creator
 * always; a member when the space is for everyone, or when their address
 * holds one of the products it is kept for — among those that still open the
 * community.
 *
 * This is the same gate an event uses (lib/community-events.ts mayAttend),
 * and deliberately so: a space kept for the buyers of one product is worth
 * nothing if the answer can be got at from somewhere else, so there is one
 * answer, cached under the community's own version, and it moves the moment
 * the creator changes what opens the community.
 */
export async function maySeeSpace(
  store: Store,
  config: CommunityConfig,
  space: { id: string; only: string[] },
  viewer: { owner: boolean; email: string; holdings?: Holdings | null },
): Promise<boolean> {
  // An answer that could not be read is not a yes: the space stays shut, never opened on a guess.
  return (await spaceAnswer(store, config, space, viewer)) === true;
}

/**
 * maySeeSpace's answer as it is: "unknown" when Stripe, or the kept answer, could not be read (CX-123 rule 24,
 * 9 November 2026), so a page can say it could not check instead of telling a member who may hold the product
 * that the space is not for them. From the reading the community's doors share (holdingsOf), or the viewer's own.
 */
export async function spaceAnswer(
  store: Store,
  config: CommunityConfig,
  space: { id: string; only: string[] },
  viewer: { owner: boolean; email: string; holdings?: Holdings | null },
): Promise<Ticket> {
  if (viewer.owner) return true;
  // The same rule the creator's "View as a member" uses (lib/community-gate.ts).
  const gate = spaceGate(space, config.access);
  if (gate.open) return true;
  if (!store.community?.id) return false;
  return heldAnswer(viewer.holdings ?? (await holdingsOf(store, config, viewer.email)), gate.needs);
}

/**
 * The spaces one viewer may see, in the creator's order, all answered from one
 * reading of what they hold (holdingsOf).
 */
export async function visibleSpaces(
  store: Store,
  config: CommunityConfig,
  viewer: { owner: boolean; email: string; holdings?: Holdings | null },
): Promise<Space[]> {
  return (await spaceChecks(store, config, viewer)).spaces;
}

/**
 * visibleSpaces, with the ids of the kept spaces whose answer was not known kept apart (never shown, never said to be
 * closed), and whether that will stay so however often they are asked (`lasting`).
 */
export async function spaceChecks(
  store: Store,
  config: CommunityConfig,
  viewer: { owner: boolean; email: string; holdings?: Holdings | null },
): Promise<{ spaces: Space[]; unchecked: Set<string>; lasting: boolean }> {
  const unchecked = new Set<string>();
  if (viewer.owner) return { spaces: config.spaces, unchecked, lasting: false };
  const gated = config.spaces.filter((s) => s.only.length);
  if (!gated.length) return { spaces: config.spaces, unchecked, lasting: false };
  // One reading for every kept space, never one per space.
  const holdings = viewer.holdings ?? (await holdingsOf(store, config, viewer.email));
  const answers = await Promise.all(gated.map((s) => spaceAnswer(store, config, s, { ...viewer, holdings })));
  const mine = new Set(gated.filter((_, i) => answers[i] === true).map((s) => s.id));
  gated.forEach((s, i) => {
    if (answers[i] === "unknown") unchecked.add(s.id);
  });
  // `lasting`: the unchecked ones will stay so however often they are asked, and are said with a way to the creator.
  return { spaces: config.spaces.filter((s) => !s.only.length || mine.has(s.id)), unchecked, lasting: unchecked.size > 0 && unknownForGood(holdings) };
}

/** Forgets Stripe's answer for one address, so the next request asks again. */
export async function forgetTicket(store: Store, email: string): Promise<void> {
  if (!store.community) return;
  await redisPipeline([["DEL", okKey(store.community.id, email), holdingsKey(store.community.id, email)]]);
}

type CookieJar = { get(name: string): { value: string } | undefined };

export type Viewer =
  /** No community, or it is switched off. */
  | { state: "off" }
  /** Nobody we know: the page asks for an address. */
  | { state: "out"; config: CommunityConfig }
  /** A proved address that holds no ticket. */
  | { state: "closed"; config: CommunityConfig; email: string }
  /**
   * A proved address whose ticket could not be checked (Stripe could not be read whole): neither in nor closed.
   * `lasting` when asking again will tell no more (more purchases than are read): the gate then says to write to the
   * creator, never to try again in a minute (the pre-review of 9 November 2026, P3).
   */
  | { state: "unknown"; config: CommunityConfig; email: string; lasting: boolean }
  /** Taken out by the creator. */
  | { state: "removed"; config: CommunityConfig; email: string }
  | {
      state: "in";
      config: CommunityConfig;
      email: string;
      /** CREATOR for the creator, else the member's key. */
      key: string;
      owner: boolean;
      /** The member's own record; null for the creator, or when the community is full. */
      member: Member | null;
      /** Whether they may post, comment, like and report. */
      canWrite: boolean;
      /** What they hold, read once for this request (holdingsOf): the spaces and events of the page are answered from it. Null for the creator. */
      holdings: Holdings | null;
    };

/**
 * Who is looking at this community, and what they may do, asked afresh.
 * The creator is always in, even while it is switched off, so they can set
 * it up before anybody else sees it.
 */
export async function communityViewer(store: Store, cookies: CookieJar): Promise<Viewer> {
  const id = store.community?.id;
  if (!id) return { state: "off" };
  const config = await readConfig(id);
  if (!config) return { state: "off" };
  const learner: Learner | null = await learnerFrom(store, cookies).catch(() => null);
  if (learner?.owner) {
    return { state: "in", config, email: learner.email, key: CREATOR, owner: true, member: null, canWrite: true, holdings: null };
  }
  if (!store.community?.on) return { state: "off" };
  if (!learner || learner.scope !== "all") return { state: "out", config };
  const key = memberKey(learner.email);
  const existing = await readMember(id, key);
  if (existing?.removed) return { state: "removed", config, email: learner.email };
  const holdings = await holdingsOf(store, config, learner.email);
  const ticket = await ticketState(store, config, learner.email, holdings);
  // Not known is said as such, never as "nothing that opens it" to somebody who may have paid (CX-123 rule 24).
  if (ticket === "unknown") return { state: "unknown", config, email: learner.email, lasting: holdings.lasting };
  if (!ticket) return { state: "closed", config, email: learner.email };
  const member = await touchMember(id, learner.email, existing, store);
  // The first time somebody comes in, the creator's welcome, sent privately
  // from the creator, where messages are on (lib/community-dm.ts). Once: the
  // record did not exist before this request, and the one made is theirs.
  if (!existing && member) {
    await welcome(id, config, member.k, store).catch((error) => console.error("sending a community welcome failed", error));
  }
  return {
    state: "in",
    config,
    email: learner.email,
    key,
    owner: false,
    member,
    canWrite: Boolean(member && !member.muted),
    holdings,
  };
}

/**
 * Sends the creator's welcome to a member who has just come in for the first
 * time, privately, from the creator — once, whatever happens at the same
 * moment: two first requests both find no record, and the mark lets only one
 * of them send. Nothing is sent while private messages are off.
 */
export async function welcome(id: string, config: CommunityConfig, member: string, room: DataStore): Promise<boolean> {
  if (!config.welcome.trim() || !config.dm.on) return false;
  // The welcome's mark, once a member: counted in the store's room (lib/order-data.ts).
  const [first] = await orderWrite(room, [["HSETNX", `nl:cm:${id}:wel`, member, Math.floor(Date.now() / 1000)]]);
  if (Number(first) !== 1) return false;
  // A welcome that does not fit in the store's data room is not sent; the member still comes in.
  const sent = await sendMessage(id, config.dm, CREATOR, member, config.welcome, room).catch((error) => {
    if (error instanceof DataRoomError) return { ok: false as const };
    throw error;
  });
  return sent.ok;
}

// ------------------------------------------------------------ emailed links

type LinkGrant = { e: string; k: string; h: string };

function displayName(name: string): string {
  return name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store";
}

function senderAddress(): string {
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  return (match ? match[1] : NIMBUS_FROM).trim();
}

/** A whole number from one up after INCR, or null when the reply is not exactly that. */
function incremented(reply: unknown): number | null {
  const count = countOf(reply);
  return count !== null && count >= 1 ? count : null;
}

/**
 * Whether one more request fits in the hour: true or false on a count read in
 * its exact shape, null when the answer is missing, cut short or of another
 * shape, which is never taken as room (CX-123 rule 24).
 */
async function within(key: string, limit: number): Promise<boolean | null> {
  const both = repliesFor(
    await redisPipeline([
      ["SET", key, "0", "EX", RATE_WINDOW_SECONDS, "NX"],
      ["INCR", key],
    ]),
    2,
  );
  if (!both || (both[0] !== "OK" && both[0] !== null)) return null;
  const count = incremented(both[1]);
  return count === null ? null : count <= limit;
}

/** "unchecked": the store's Stripe account refuses to be read, so nobody's access can be checked; nothing was sent. */
export type LinkRequest = "sent" | "email" | "limited" | "error" | "unchecked";

/**
 * Emails a way in, when the address holds a ticket. "sent" either way: only
 * whoever reads the inbox learns whether it did, so the form cannot be used
 * to find out who bought what, or to fill a stranger's inbox.
 */
export async function requestCommunityLink(input: {
  store: Store;
  email: string;
  ip: string;
  origin: string;
}): Promise<LinkRequest> {
  const { store, ip, origin } = input;
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  const id = store.community?.id;
  if (!id || !store.community?.on || !isRedisConfigured()) return "error";
  // A count that could not be read sends nothing; it is said as the email not sent, never as too many requests.
  const byConnection = await within(`nl:rl:cm:ip:${sha(`${ip}|${store.handle}`).slice(0, 32)}`, IP_LIMIT);
  if (byConnection === null) return "error";
  if (!byConnection) return "limited";
  const byAddress = await within(`nl:rl:cm:addr:${emailKey(raw)}`, ADDRESS_LIMIT);
  if (byAddress === null) return "error";
  if (!byAddress) return "limited";

  const config = await readConfig(id);
  if (!config) return "error";
  const member = await readMember(id, memberKey(raw));
  if (member?.removed) return "sent";
  const holdings = await holdingsOf(store, config, raw);
  const ticket = heldAnswer(holdings, config.access);
  // Not confirmed for now: "try again", never a quiet "sent" with nothing sent to somebody who paid. Not confirmed
  // for good because of the purchases' volume: the link is sent, as to somebody who may hold one, and the gate it
  // opens says to write to the creator; never an "error" that trying again will not change (the pre-review's P3).
  // Not confirmed because the store's Stripe account refuses the read: nothing about this address is known, so no
  // link is made and no email sent to somebody who may never have dealt with the store; the answer says to write to
  // the creator, and is the same for every address (Claude 6's F2 on #3395). Either way the form tells nobody whether
  // the address bought anything.
  if (ticket === "unknown" && !holdings.lasting) return "error";
  if (ticket === "unknown" && holdings.why !== "volume") return "unchecked";
  if (ticket === false) return "sent";

  const token = randomBytes(32).toString("hex");
  const grant: LinkGrant = { e: normaliseEmail(raw), k: storeKey(store), h: store.handle };
  await redisPipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", LINK_SECONDS]]);
  const link = `${origin}/api/store/community/open?token=${token}`;
  const sent = await sendEmail({ meter: { by: "store", store: store, kind: "transactional" },
    from: `"${displayName(store.name)} via Marktmorgen" <${senderAddress()}>`,
    to: normaliseEmail(raw),
    subject: communityWords(store.language).linkSubject(config.name).slice(0, 200),
    text: communityWords(store.language).linkBody(config.name, link, store.name),
  });
  return sent ? "sent" : "error";
}

/**
 * Spends one open of an emailed link, and says who it was for. An answer
 * not in its exact shape gives no pass and is thrown: it is neither an
 * expired link nor one used too many times (CX-123 rule 24).
 */
export async function openCommunityLink(token: string): Promise<LinkGrant | null> {
  if (!TOKEN_PATTERN.test(token) || !isRedisConfigured()) return null;
  const replies = repliesFor(
    await redisPipeline([
      ["GET", linkKey(token)],
      ["SET", opensKey(token), "0", "EX", LINK_SECONDS, "NX"],
      ["INCR", opensKey(token)],
    ]),
    3,
  );
  const raw = replies?.[0];
  const opens = replies && (replies[1] === "OK" || replies[1] === null) ? incremented(replies[2]) : null;
  if (!replies || (typeof raw !== "string" && raw !== null) || opens === null) throw new UnknownReplyError("a community link's opens");
  if (typeof raw !== "string" || opens > MAX_LINK_OPENS) return null;
  try {
    const grant = JSON.parse(raw) as LinkGrant;
    return typeof grant.e === "string" && typeof grant.h === "string" && typeof grant.k === "string" ? grant : null;
  } catch {
    return null;
  }
}

/**
 * Forgets the answers kept about whether one address may come into the
 * community and its spaces, and the mark that it was welcomed
 * (lib/community-erasure.ts).
 */
export async function forgetAccessPerson(id: string, email: string, spaceIds: string[], productIds: string[]): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const key = emailKey(email);
  const replies = await redisPipeline([
    ["DEL", okKey(id, email), holdingsKey(id, email), ...spaceIds.map((space) => `nl:cm:${id}:sp:ok:${space}:${key}`), ...productIds.map((p) => `nl:cm:${id}:sg:${p}:${key}`)],
    ["HDEL", `nl:cm:${id}:wel`, key],
  ]);
  return replies.reduce<number>((sum, n) => sum + (Number(n) || 0), 0);
}
