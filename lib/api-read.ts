/**
 * What the public API hands out, and in what shape.
 *
 * Every object here is built field by field from a list written out below —
 * never by spreading a stored record. Stored records carry things that must
 * never leave: a contact's unsubscribe token, a member's internal flags, an
 * affiliate's private note. A field added to a record later stays inside
 * until somebody decides, here, in writing, that it goes out.
 *
 * Each reader is the one the studio already uses for the same list, so the
 * API can never show a creator something different from what their own
 * dashboard shows them.
 *
 * Every time goes out as an ISO 8601 string in UTC, whatever it was kept as —
 * seconds for members and students, milliseconds for bookings and
 * affiliates, text already for contacts — so no tool has to guess the unit.
 */
import { apiError } from "@/lib/api-guard";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { productIds, readListing, readListings } from "@/lib/catalog";
import { listingsToRead } from "@/lib/catalog-read-count";
import { leadsKey, parseContact } from "@/lib/contacts";
import { memberPage } from "@/lib/community";
import { readCourse } from "@/lib/course";
import { studentPage } from "@/lib/learn";
import { BOOK_STRIPE_PAGES, bookSizes, readBook } from "@/lib/affiliates";
import { paidCalls } from "@/lib/calls";
import { productLink } from "@/lib/checkout-recovery";
import {
  type ReadWork, API_PAGE_ROWS, addWork, apiReadUnits, bookWork, bookingsWork, EVENTS_PROBE_MOST, eventsSentMost, eventsWork, listPageMost, numbersWork, productsPageWork, scannedPageWork, settledUnits,
  studentsPageWork,
} from "@/lib/api-read-rules";
import { type WebhookEvent, deliveryReadBound, recentDeliverySizes, recentLimit, recentMessagesOf } from "@/lib/webhooks";
import { readsSales } from "@/lib/stats";
import { paypalCounts } from "@/lib/paypal-sales";

export type Page<T> = { data: T[]; next: string | null };

/** How many rows one page of a long list holds. */
export const API_PAGE = API_PAGE_ROWS;

/**
 * Takes `more` of the store's API requests before a reading that costs more
 * than its request (lib/api-guard.ts, takeMoreApi): null when taken, else the
 * refusal to send as it is. `taken` is what the same reading already took,
 * when this is a later step of it (its refusal says so). Every reader below
 * past the door takes what it reads before it reads it.
 */
export type Charge = (more: number, taken?: number) => Promise<Response | null>;

/**
 * Sets `most` aside before a reading whose size is known only once read, and
 * hands back how to settle it at what it really took (lib/api-guard.ts,
 * holdMoreApi), or the refusal, with nothing read.
 */
export type Hold = (most: number) => Promise<Response | ((actual: number) => Promise<Response | null>)>;

/** Every field each list's rows go out with, so a field asked for is checked before anything is taken or read (lib/api-fields.ts, badFields). */
export const PRODUCT_FIELDS = ["id", "title", "price", "currency", "kind", "interval", "hidden", "url"] as const;
export const LEAD_FIELDS = ["email", "name", "agreed", "agreed_at", "unsubscribed", "unsubscribed_at", "first_at", "last_at", "products", "product_ids", "tags", "source"] as const;
export const MEMBER_FIELDS = ["email", "name", "handle", "listed", "announcements", "muted", "removed", "joined_at", "last_seen_at"] as const;
export const STUDENT_FIELDS = ["email", "lessons_done", "lessons_total", "started_at", "last_seen_at", "blocked"] as const;
export const AFFILIATE_FIELDS = ["id", "email", "code", "status", "applied_at", "clicks", "sales", "earned", "paid", "owed", "payable", "waiting"] as const;
export const BOOKING_FIELDS = ["id", "product_id", "title", "email", "name", "starts_at", "ends_at", "buyer_time_zone", "moved", "amount", "currency", "answers"] as const;

/** Bytes as sent. */
const sentBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

const isoFromSeconds = (s: number) => (s > 0 ? new Date(s * 1000).toISOString() : null);
const isoFromMs = (ms: number) => (ms > 0 ? new Date(ms).toISOString() : null);
const isoFromText = (t: string) => {
  if (!t) return null;
  const at = Date.parse(t);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};

/** The store itself: enough for a tool to know which store a key reads. */
export function storeInfo(store: Store) {
  return { handle: store.handle, name: store.name, currency: store.currency };
}

/**
 * Every product, in the creator's order, a page at a time. What reading the
 * page's listings costs is taken first, counted from the listings the store's
 * own record does not hold (lib/api-read-rules.ts, productsPageWork).
 */
export async function products(store: Store, cursor: string | null, charge: Charge): Promise<Page<Record<string, unknown>> | Response> {
  // The order is in the store's own index, so only the page asked for is
  // read. It used to read the whole catalogue to answer for twenty of it.
  const ids = productIds(store);
  const from = cursor && /^\d{1,6}$/.test(cursor) ? Number(cursor) : 0;
  const page = ids.slice(from, from + API_PAGE);
  const refused = await charge(apiReadUnits(productsPageWork(page.length, listingsToRead(store, page))));
  if (refused) return refused;
  const slice = await readListings(store, page);
  return {
    data: slice.map((p) => ({
      id: p.id,
      title: p.title,
      price: p.priceCents,
      currency: store.currency,
      kind: p.call ? "call" : p.course ? "course" : p.recurring ? "membership" : p.priceCents === 0 ? "free" : "one_time",
      interval: p.recurring?.interval ?? null,
      hidden: p.hidden === true,
      url: productLink(store, p.id),
    })),
    next: from + API_PAGE < ids.length ? String(from + API_PAGE) : null,
  };
}

/**
 * The creator's list: everybody who asked for something free, bought, or was
 * brought in by an import. The same rows the studio's CSV export writes, in
 * the same order Redis keeps them. `agreed=true` narrows it to those who
 * agreed to hear from the creator and have not left.
 */
export async function leads(store: Store, cursor: string | null, onlyAgreed: boolean): Promise<LeadsPage> {
  return (await scanLeads(store, cursor, onlyAgreed)).page;
}

/**
 * leads, paid for first: a page at its most (listPageMost) is set aside
 * before the scan, so a store without the requests it may take reads
 * nothing; then it is settled at what the scan read and what is sent
 * (scannedPageWork), before it is sent. The refusal, as it is, when it is
 * not left. What /api/v1/leads answers.
 */
export async function chargedLeads(store: Store, cursor: string | null, onlyAgreed: boolean, hold: Hold): Promise<LeadsPage | Response> {
  if (!store.listId || !isRedisConfigured()) return { data: [], next: null };
  return scannedPage(hold, listPageMost("leads", API_PAGE), async () => {
    const { page, readBytes } = await scanLeads(store, cursor, onlyAgreed);
    return { out: page, work: scannedPageWork(1, readBytes, sentBytes(page)) };
  });
}

/**
 * The store's recent messages of one event (GET /api/v1/events), paid for by
 * what they really are, each part before it is done (Codex G2, #2192):
 *   1. the measuring at its most (EVENTS_PROBE_MOST) is set aside before the
 *      log is read, so a store without it measures nothing;
 *   2. the log and the size of each delivery in it are looked up
 *      (recentDeliverySizes), and the rest of the reading is set aside at
 *      each delivery's bound (deliveryReadBound: what its tries may still
 *      write on it) and the most that can be sent of them;
 *   3. they are read, each only up to its bound (recentMessagesOf), and the
 *      whole is settled at the bytes read and sent (eventsWork), before they
 *      are sent.
 * The refusal, as it is, when a part is not left, with nothing of it done.
 * Measuring or reading that cannot be confirmed keeps what was set aside.
 */
export async function recentEvents(store: Store, type: WebhookEvent, limit: number, hold: Hold): Promise<Record<string, unknown>[] | Response> {
  const probeHeld = apiReadUnits(EVENTS_PROBE_MOST);
  const settleProbe = await hold(probeHeld);
  if (settleProbe instanceof Response) return settleProbe;
  const sized = await recentDeliverySizes(store);
  if (!sized) throw new Error("the recent deliveries could not be measured");
  const most = recentLimit(limit);
  const bounds = sized.sizes.map(deliveryReadBound);
  const whole = apiReadUnits(eventsWork({ deliveries: sized.ids.length, bytes: sized.logBytes + bounds.reduce((n, b) => n + b, 0), sent: eventsSentMost(bounds, most) }));
  // What the measuring already set aside counts toward the whole; only the rest is taken now.
  const restHeld = Math.max(0, whole - probeHeld);
  const settleRest = await hold(restHeld);
  if (settleRest instanceof Response) {
    // Nothing more is read: the measuring done is settled at what it was.
    await settleProbe(settledUnits({ commands: 1 + sized.ids.length, bytes: sized.logBytes, roundTrips: sized.ids.length ? 2 : 1 }, probeHeld));
    // Said with the whole the reading may take, not only the rest of it.
    const words = settleRest.status === 429 ? ((await settleRest.clone().json().catch(() => null)) as { error?: string } | null) : null;
    return words?.error === "monthly_limit"
      ? apiError(429, "monthly_limit", `This read may take up to ${(whole + 1).toLocaleString("en-US")} of your store's API requests, more than your store has left, so no event was read. The requests used to measure them stay counted.`)
      : settleRest;
  }
  const { messages, readBytes } = await recentMessagesOf(store, type, sized.ids, bounds, most);
  const due = settledUnits(eventsWork({ deliveries: sized.ids.length, bytes: sized.logBytes + readBytes, sent: sentBytes(messages) }), probeHeld + restHeld);
  // The whole is settled across the two: the measuring's part first, the rest after.
  const refusedProbe = await settleProbe(Math.min(due, probeHeld));
  const refused = await settleRest(Math.max(0, due - probeHeld));
  return refusedProbe ?? refused ?? messages;
}

/** A page set aside at `most`, read, and settled at what it did before it is sent (lib/api-guard.ts, holdMoreApi). */
async function scannedPage<T>(hold: Hold, most: ReadWork, read: () => Promise<{ out: T; work: ReadWork }>): Promise<T | Response> {
  const held = apiReadUnits(most);
  const settle = await hold(held);
  if (settle instanceof Response) return settle;
  const { out, work } = await read();
  const refused = await settle(settledUnits(work, held));
  return refused ?? out;
}

/** A page of the list, with how many contacts it holds that could not be read (only when there are any): never left out without a word (rule 24). */
type LeadsPage = Page<Record<string, unknown>> & { unreadable?: number };

async function scanLeads(store: Store, cursor: string | null, onlyAgreed: boolean): Promise<{ page: LeadsPage; readBytes: number }> {
  if (!store.listId || !isRedisConfigured()) return { page: { data: [], next: null }, readBytes: 0 };
  const start = cursor && /^\d{1,20}$/.test(cursor) ? cursor : "0";
  // HSCAN answers [cursor, [field, value, ...]] (CX-123 rule 24): a page in any other shape is unknown, never a
  // last or empty page, so a sync is never told it has the whole list when it has part of it (502 in the route).
  const reply = repliesFor(repliesFor(await redisPipeline([["HSCAN", leadsKey(store.listId), start, "COUNT", API_PAGE]]), 1)?.[0], 2);
  const cursorReply = reply?.[0];
  const next = typeof cursorReply === "string" && /^\d{1,20}$/.test(cursorReply) ? cursorReply : countOf(cursorReply) !== null ? String(cursorReply) : null;
  const flat = stringList(reply?.[1]);
  if (next === null || !flat || flat.length % 2 !== 0) throw new UnknownReplyError("a page of a store's list");
  const data: Record<string, unknown>[] = [];
  let unreadable = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const c = parseContact(flat[i + 1]);
    if (!c) {
      unreadable += 1;
      continue;
    }
    const mailable = c.agreed && !c.unsub;
    if (onlyAgreed && !mailable) continue;
    data.push({
      email: flat[i],
      name: c.name || null,
      agreed: c.agreed,
      agreed_at: isoFromText(c.agreedAt),
      unsubscribed: c.unsub,
      unsubscribed_at: isoFromText(c.unsubAt),
      first_at: isoFromText(c.firstAt),
      last_at: isoFromText(c.lastAt),
      products: c.titles,
      product_ids: c.ids,
      tags: c.tags,
      source: c.source || null,
    });
  }
  // The bytes the scan answered with, for the reading that pays for them (chargedLeads).
  const readBytes = flat.reduce((n, v) => n + Buffer.byteLength(v), 0);
  return { page: { data, next: next === "0" ? null : next, ...(unreadable ? { unreadable } : {}) }, readBytes };
}

/**
 * The community's members, as the creator's own member list shows them: a
 * page at its most set aside before the scan, settled at what it read and
 * sends before anything is sent, as the list's.
 */
export async function members(store: Store, cursor: string | null, hold: Hold): Promise<Page<Record<string, unknown>> | Response> {
  const id = store.community?.id;
  if (!id) return { data: [], next: null };
  const start = cursor && /^\d{1,20}$/.test(cursor) ? cursor : "0";
  return scannedPage(hold, listPageMost("members", API_PAGE), async () => {
    const page = await memberPage(id, start, API_PAGE);
    const out = {
      data: page.members.map((m) => ({
        email: m.e,
        name: m.n || null,
        handle: m.h || null,
        listed: m.dir && Boolean(m.n),
        announcements: m.mail,
        muted: m.muted,
        removed: m.removed,
        joined_at: isoFromSeconds(m.at),
        last_seen_at: isoFromSeconds(m.seen),
      })),
      next: page.next === "0" ? null : page.next,
    };
    return { out, work: scannedPageWork(2, page.bytes, sentBytes(out)) };
  });
}

/**
 * Everybody who has opened one course, with how far they got, a page at a
 * time in the order Redis keeps them. The page is read first; what each of
 * its students marked done is read only once the further requests that costs
 * are taken (lib/api-read-rules.ts, studentsPageWork), so a course of any size
 * costs by the page and never by the whole course at once.
 */
export async function students(
  store: Store,
  productId: string,
  cursor: string | null,
  charge: Charge,
): Promise<{ data: Record<string, unknown>[]; total: number; next: string | null } | Response | null> {
  // One product by id, which is one read — not every product in the store.
  const product = await readListing(store, productId);
  if (!product?.course) return null;
  const course = await readCourse(product.course.id);
  if (!course) return null;
  const lessons = course.modules.reduce((n, m) => n + m.lessons.length, 0);
  const start = cursor && /^\d{1,20}$/.test(cursor) ? cursor : "0";
  // What the charge said, kept outside the callback that asks it.
  const said: { refused: Response | null } = { refused: null };
  const page = await studentPage(course, start, API_PAGE, async (rows, blocked) => {
    said.refused = await charge(apiReadUnits(studentsPageWork(rows, blocked)));
    return said.refused === null;
  });
  if (said.refused) return said.refused;
  if (!page) throw new Error("the course's students could not be counted");
  return {
    total: page.total,
    data: page.students.map((s) => ({
      email: s.email,
      lessons_done: s.done,
      lessons_total: lessons,
      started_at: isoFromSeconds(s.since),
      last_seen_at: isoFromSeconds(s.lastSeen),
      blocked: s.blocked,
    })),
    next: page.next === "0" ? null : page.next,
  };
}

/**
 * The further API requests one reading of the affiliate program takes, from
 * its size counted just before (lib/affiliates.ts, bookSizes), taken before it
 * is read: null when taken, else the refusal. Shared with the MCP tool
 * (lib/mcp-tools.ts, affiliatesTool), which reads the same book.
 */
export async function chargeBook(store: Store, charge: Charge): Promise<Response | null> {
  const sizes = await bookSizes(store);
  if (!sizes) throw new Error("the affiliate program could not be counted");
  return charge(apiReadUnits(bookWork(sizes, BOOK_STRIPE_PAGES)));
}

/** Every affiliate, with what they have earned, been paid, and are owed. */
export async function affiliates(store: Store, charge: Charge): Promise<{ data: Record<string, unknown>[]; currency: string; refunds_checked: boolean; invoices_checked: boolean } | Response> {
  const refused = await chargeBook(store, charge);
  if (refused) return refused;
  const book = await readBook(store);
  return {
    currency: book.currency,
    // When Stripe could not be asked about refunds, the amounts may be high.
    // Said, so a tool paying from these numbers can wait for a clean read.
    refunds_checked: book.refundsChecked,
    // Nor every membership and plan payment (audit A1): the amounts may then be low. The same test as the studio's
    // batch file and its confirmation (unsettledBook), so a tool paying from these numbers waits as they do.
    invoices_checked: book.invoicesChecked,
    data: book.rows.map((r) => ({
      id: r.affiliate.id,
      email: r.affiliate.email,
      code: r.affiliate.code,
      status: r.affiliate.status,
      applied_at: isoFromMs(r.affiliate.appliedAt),
      clicks: r.clicks,
      sales: r.sales,
      earned: r.earned,
      paid: r.paid,
      owed: r.owed,
      payable: r.payable,
      waiting: r.waiting,
    })),
  };
}

/**
 * The further API requests one reading of the numbers takes (lib/stats-report.ts
 * readNumbers, and lib/mcp-tools.ts readFullNumbers before its listings), sized
 * first by the PayPal sales and refunds kept (lib/api-read-rules.ts,
 * numbersWork), for lib/api-numbers.ts to take before anything else is read.
 * `also` is work the same reading does with it, taken in the same go
 * (keeping a copy of them).
 */
export async function numbersUnits(store: Store, also: Partial<ReadWork> = {}): Promise<number> {
  const kept = Boolean(store.statsId);
  const sales = readsSales(store);
  const paypal = kept && sales ? await paypalCounts(store.statsId) : { sales: 0, refunds: 0 };
  if (!paypal) throw new Error("the PayPal sales could not be counted");
  const work = numbersWork({ kept, sales, stripe: Boolean(store.stripeAccountId), paypalSales: paypal.sales, paypalRefunds: paypal.refunds });
  return apiReadUnits(kept ? addWork(work, also) : work);
}

/**
 * Paid calls and session seats, each at the time it is booked for now. How
 * many there are is known only once Stripe has answered, so the further
 * requests its most (lib/api-read-rules.ts, bookingsWork) are taken before;
 * a store without Stripe connected reads nothing and takes none.
 */
export async function bookings(store: Store, charge: Charge): Promise<Record<string, unknown>[] | Response> {
  const refused = await charge(apiReadUnits(bookingsWork(Boolean(store.stripeAccountId))));
  if (refused) return refused;
  const rows = await paidCalls(store);
  return rows.map((c) => ({
    id: c.session,
    product_id: c.product,
    title: c.title,
    email: c.email,
    name: c.name,
    starts_at: isoFromMs(c.start),
    ends_at: isoFromMs(c.end),
    buyer_time_zone: c.buyerTz,
    moved: c.moves,
    amount: c.amount,
    // The currency it was paid in; the store's when the checkout said none.
    currency: c.currency || store.currency,
    answers: c.answers,
  }));
}
