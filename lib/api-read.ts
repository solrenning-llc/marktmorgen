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
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import type { Store } from "@/lib/store";
import { listingsToRead, productIds, readListing, readListings } from "@/lib/catalog";
import { leadsKey, parseContact } from "@/lib/contacts";
import { memberPage } from "@/lib/community";
import { readCourse } from "@/lib/course";
import { studentPage } from "@/lib/learn";
import { BOOK_STRIPE_PAGES, bookSizes, readBook } from "@/lib/affiliates";
import { paidCalls } from "@/lib/calls";
import { productLink } from "@/lib/checkout-recovery";
import { apiReadUnits, bookWork, bookingsWork, numbersWork, productsPageWork, scannedPageWork, studentsPageWork } from "@/lib/api-read-rules";
import { readsSales } from "@/lib/stats";
import { paypalCounts } from "@/lib/paypal-sales";

export type Page<T> = { data: T[]; next: string | null };

/** How many rows one page of a long list holds. */
export const API_PAGE = 200;

/**
 * Takes `more` of the store's API requests before a reading that costs more
 * than its request (lib/api-guard.ts, takeMoreApi): null when taken, else the
 * refusal to send as it is. The three readers below that read more than a
 * page take it before they read; the others fit in their request.
 */
export type Charge = (more: number) => Promise<Response | null>;

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
export async function leads(store: Store, cursor: string | null, onlyAgreed: boolean): Promise<Page<Record<string, unknown>>> {
  return (await scanLeads(store, cursor, onlyAgreed)).page;
}

/** leads, with what its scan read and what it sends taken before it is sent (scannedPageWork): the refusal, as it is, when it is not left. What /api/v1/leads answers. */
export async function chargedLeads(store: Store, cursor: string | null, onlyAgreed: boolean, charge: Charge): Promise<Page<Record<string, unknown>> | Response> {
  const { page, readBytes } = await scanLeads(store, cursor, onlyAgreed);
  const refused = await charge(apiReadUnits(scannedPageWork(1, readBytes, sentBytes(page))));
  return refused ?? page;
}

async function scanLeads(store: Store, cursor: string | null, onlyAgreed: boolean): Promise<{ page: Page<Record<string, unknown>>; readBytes: number }> {
  if (!store.listId || !isRedisConfigured()) return { page: { data: [], next: null }, readBytes: 0 };
  const start = cursor && /^\d{1,20}$/.test(cursor) ? cursor : "0";
  const [reply] = await redisPipeline([["HSCAN", leadsKey(store.listId), start, "COUNT", API_PAGE]]);
  if (!Array.isArray(reply) || reply.length < 2) return { page: { data: [], next: null }, readBytes: 0 };
  const next = String(reply[0]);
  const flat = Array.isArray(reply[1]) ? (reply[1] as unknown[]) : [];
  const data: Record<string, unknown>[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const c = parseContact(flat[i + 1]);
    if (!c) continue;
    const mailable = c.agreed && !c.unsub;
    if (onlyAgreed && !mailable) continue;
    data.push({
      email: String(flat[i]),
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
  const readBytes = flat.reduce((n: number, v) => n + Buffer.byteLength(String(v)), 0);
  return { page: { data, next: next === "0" ? null : next }, readBytes };
}

/** The community's members, as the creator's own member list shows them. */
export async function members(store: Store, cursor: string | null, charge: Charge): Promise<Page<Record<string, unknown>> | Response> {
  const id = store.community?.id;
  if (!id) return { data: [], next: null };
  const start = cursor && /^\d{1,20}$/.test(cursor) ? cursor : "0";
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
  // What the scan answered and what is sent, counted and taken before anything is sent (scannedPageWork).
  const refused = await charge(apiReadUnits(scannedPageWork(2, page.bytes, sentBytes(out))));
  return refused ?? out;
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
export async function affiliates(store: Store, charge: Charge): Promise<{ data: Record<string, unknown>[]; currency: string; refunds_checked: boolean } | Response> {
  const refused = await chargeBook(store, charge);
  if (refused) return refused;
  const book = await readBook(store);
  return {
    currency: book.currency,
    // When Stripe could not be asked about refunds, the amounts may be high.
    // Said, so a tool paying from these numbers can wait for a clean read.
    refunds_checked: book.refundsChecked,
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
 * What one reading of the numbers takes (lib/stats-report.ts readNumbers, and
 * lib/mcp-tools.ts readFullNumbers before its listings), sized first by the
 * PayPal sales and refunds kept, taken before anything else is read: null
 * when taken, else the refusal (lib/api-read-rules.ts, numbersWork).
 */
export async function chargeNumbers(store: Store, charge: Charge): Promise<Response | null> {
  const kept = Boolean(store.statsId);
  const sales = readsSales(store);
  const paypal = kept && sales ? await paypalCounts(store.statsId) : { sales: 0, refunds: 0 };
  if (!paypal) throw new Error("the PayPal sales could not be counted");
  return charge(apiReadUnits(numbersWork({ kept, sales, stripe: Boolean(store.stripeAccountId), paypalSales: paypal.sales, paypalRefunds: paypal.refunds })));
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
