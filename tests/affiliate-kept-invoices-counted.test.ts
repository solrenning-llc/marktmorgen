/**
 * The paid invoices the affiliate book keeps between readings (audit A1, lib/affiliates.ts) are read and written back
 * whole, up to BOOK_INVOICES_KEPT_BYTES each way, by every reading of a store with Stripe and affiliates. The API and
 * MCP readers count them before reading (bookWork), and so does the affiliate's own page (affiliatePageCost). Every
 * other reading did not: the studio's affiliates page, its spreadsheet, the payout file and its confirmation, the
 * PayPal press, payday and the settling of an unknown PayPal answer (Claude 7's MEDIUM on #3378, @61a7cf1c47 and
 * @73ac47d96b: "kept-invoice reads uncosted on studio/payout paths").
 *
 * Now such a reading takes KEPT_INVOICES_STUDIO_UNITS of the store's studio requests before it reads them, priced
 * here at the registry's own figures; with no room it reads no invoice, so the book is not checked and nothing is
 * paid from it. A reading already counted (keptPaid) takes nothing more.
 *
 * Synthetic data, Stripe and PayPal stand-ins.
 */
import * as rules from "@/lib/api-read-rules";
import { BOOK_INVOICES_KEPT_BYTES, BOOK_KEPT_INVOICES_BYTES, BOOK_KEPT_INVOICES_MARK_BYTES, bookWork } from "@/lib/api-read-rules";
import { readBook } from "@/lib/affiliates";
import { affiliates as apiAffiliates } from "@/lib/api-read";
import { affiliatesTool } from "@/lib/mcp-tools";
import { connectPayPal, payWithPayPal, unsettledBook } from "@/lib/paypal-payouts";
import { takeAllowance } from "@/lib/store-allowance";
import { MAX_STORE_BYTES, type Store } from "@/lib/store";
import { AFFILIATE_PAGE_COMMANDS, TAKE_COMMANDS, UNIT_COST, affiliatePageWork, perMegabyte, request } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { markLive } from "./live-store";
import { done, is, part } from "./check";

const STATS = "statsidkept01";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const EMPTY = { object: "list", data: [], has_more: false };
const NOW = Math.floor(Date.now() / 1000) - 3600;
const META = { via: "aaaaaaaaaaaa", store: "keptinv", kind: "plan", product: "p1", via_rate: "30" };

let invoiceCalls = 0;
const created: Record<string, unknown>[] = [];

/** One paid plan payment of $30.00 sold through Sara's link, in the shape Stripe gives it (API 2026-08-26.dahlia). */
const invoice = {
  id: "in_1",
  object: "invoice",
  status: "paid",
  amount_paid: 3000,
  currency: "usd",
  created: NOW,
  status_transitions: { paid_at: NOW },
  total_taxes: [],
  parent: { subscription_details: { metadata: META } },
  payments: { object: "list", data: [{ object: "invoice_payment", status: "paid", payment: { type: "payment_intent", payment_intent: "pi_inv_1" } }], has_more: false },
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") {
    if (url.pathname === "/v1/invoices") {
      invoiceCalls++;
      return json({ object: "list", data: [invoice], has_more: false });
    }
    return json(EMPTY);
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") {
    return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts openid", expires_in: 32400 });
  }
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    created.push(body);
    return json({ batch_header: { payout_batch_id: `BATCH${created.length}ABC`, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } }, 201);
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(over: Record<string, unknown> = {}): Store {
  return {
    sid: "sidkeptinv01",
    handle: "keptinv",
    name: "Kept Invoices",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    stripeAccountId: "acct_1TestKeptInv01",
    currency: "usd",
    catalog: { items: [] },
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
    ...over,
  } as unknown as Store;
}

/** The store's studio requests left this window, read by taking one (and that one is then counted too). */
async function left(store: Store): Promise<number> {
  const taken = await takeAllowance(store, "studio", 1);
  if (!taken.ok || typeof taken.left !== "number") throw new Error(`the studio figure could not be read: ${JSON.stringify(taken)}`);
  return taken.left;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_kept_invoices_only";
  redis.clear();
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", JSON.stringify({ id: "aaaaaaaaaaaa", email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
  ]);
  const store = shop();
  await markLive(store);
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("PayPal stand-in not connected");
  const units = Number((rules as Record<string, unknown>).KEPT_INVOICES_STUDIO_UNITS);

  part("What reading and writing back the kept invoices costs, in studio requests");
  const kept = 2 * BOOK_INVOICES_KEPT_BYTES;
  // The GET of the kept invoices, and their write back: one script of four commands (EVAL, HGET, GET, SET) since
  // it is fenced by the store's erasure (Codex L-20261119-1003, lib/store-live-cache.ts setWhileStoreLive).
  const cost = request("heavy", 5, kept) + perMegabyte(kept);
  is("a whole number of studio requests, at least one", Number.isSafeInteger(units) && units >= 1, true);
  is("worth at least the five commands and both megabytes at a heavy request's price", units * UNIT_COST.studio >= cost, true);
  // Past the ceiling (Board #5285 row #3378): the GET, and the mark of it written in place of the invoices, its script
  // sent twice when the first answer is "unknown": nine commands, the kept invoices one way and two marks the other.
  // A mark is the record's fixed fields and the store's sale handles, which live in the store's own record: at most
  // MAX_STORE_BYTES, and a few hundred bytes for the rest (the account id, `since` and `over`).
  const MARK_BYTES = MAX_STORE_BYTES + 512;
  // The readers' figure for one mark is at least this bound, and their bytes for the path cover the dearer of the write
  // back and two marks (Claude 3 xvBY8's LEVE on #5384: two marks are past the write's bytes).
  is("one mark's bytes, as the readers count them, cover a store record's handles and its JSON", BOOK_KEPT_INVOICES_MARK_BYTES >= MARK_BYTES, true);
  is("the path's bytes cover the kept invoices read and the dearer of their write back and two marks",
    BOOK_KEPT_INVOICES_BYTES >= BOOK_INVOICES_KEPT_BYTES + Math.max(BOOK_INVOICES_KEPT_BYTES, 2 * MARK_BYTES), true);
  const ceilingCost = request("heavy", 9, BOOK_INVOICES_KEPT_BYTES + 2 * MARK_BYTES) + perMegabyte(BOOK_INVOICES_KEPT_BYTES + 2 * MARK_BYTES);
  is("past the ceiling, worth at least the nine commands, the kept invoices read and two marks written", units * UNIT_COST.studio >= ceilingCost, true);
  // The API and MCP readers count the same path the same way (Claude 7 HHH's MEDIO on #5384, 7110143161): the GET and
  // the mark's script of four, sent twice, are nine commands in bookWork too, never one a script. Only the kept
  // invoices differ between these two sizes (no entries, so no PayPal slices and no refund marks; no products).
  const sizesWith = { kept: true, entries: 0, people: 1, leads: 0, paypalRefunds: 0, stripe: true, products: 0 };
  const keptPart = bookWork(sizesWith, 0).commands - bookWork({ ...sizesWith, stripe: false }, 0).commands;
  is("the API and MCP readers count the kept invoices' path as nine commands, as the studio does", keptPart, 9);
  // And the same difference in trips and bytes: the GET, then the write back or the mark sent twice, three trips; and
  // BOOK_KEPT_INVOICES_BYTES moved (Claude 3 xvBY8's LEVE on #5384: no check held roundTrips).
  const withKept = bookWork(sizesWith, 0);
  const withoutKept = bookWork({ ...sizesWith, stripe: false }, 0);
  is("and three round trips, and the path's bytes", [withKept.roundTrips - withoutKept.roundTrips, withKept.bytes - withoutKept.bytes], [3, BOOK_KEPT_INVOICES_BYTES]);
  // And the affiliate's own page (affiliatePageRead, the model its units are held to in tests/plan-cost-registry.test.ts)
  // counts the same path the same way (Claude 3's LOW on #5384, 7113942268): never the two commands it counted before.
  // Computed, not read from the registry's text (Claude 6 jAAv7's NIT on #5384): a book so large that its kept copy is
  // at BOOK_SNAPSHOT_MAX_BYTES with or without the invoices' lines, so the same writes either way, and only the kept
  // invoices' path differs between reading Stripe or not.
  const bigBook = { fields: 1_000_000, rows: 0, listings: 0, stripePages: 1 };
  const pagePart = affiliatePageWork(bigBook).commands - affiliatePageWork({ ...bigBook, stripePages: 0 }).commands;
  is("the affiliate's page counts the kept invoices' path as BOOK_KEPT_INVOICES_COMMANDS too", [pagePart, rules.BOOK_KEPT_INVOICES_COMMANDS], [9, 9]);
  // And its bytes, the same way: on that book only the kept invoices' path differs, so exactly BOOK_KEPT_INVOICES_BYTES
  // (Claude 3 xvBY8's LEVE on #5384 @0664391217: no test held them).
  const pageBytes = affiliatePageWork(bigBook).bytes - affiliatePageWork({ ...bigBook, stripePages: 0 }).bytes;
  is("and the kept invoices' path's bytes as BOOK_KEPT_INVOICES_BYTES", pageBytes, BOOK_KEPT_INVOICES_BYTES);
  // And nothing taken off the rest of the page: an empty book that reads no Stripe page counts the page's own commands,
  // the window's take, two commands for its one write of the kept book (WRITE_BYTES a write, lib/affiliate-book-snapshot.ts)
  // and the three refund marks, from the registry's figures.
  is("an empty book, no Stripe page: the page's commands, its take, one write and the three marks, nothing less",
    affiliatePageWork({ fields: 0, rows: 0, listings: 0, stripePages: 0 }).commands, AFFILIATE_PAGE_COMMANDS + TAKE_COMMANDS + 2 + 3);

  part("A studio or payout reading takes them before it reads, and reads whole");
  const before = await left(store);
  const book = await readBook(store);
  const after = await left(store);
  is("checked, Sara's renewal on it", [book.invoicesChecked, book.lines.length], [true, 1]);
  is("its studio requests taken (besides the one each count takes)", before - after - 1, units);

  part("With no room for them, no invoice is read and nothing is paid from the book");
  const room = await left(store);
  if (room > 1) await takeAllowance(store, "studio", room - 1);
  invoiceCalls = 0;
  const short = await readBook(store);
  is("not checked, no renewal, Stripe's invoices not asked", [short.invoicesChecked, short.lines.length, invoiceCalls], [false, 0, 0]);
  is("so no payout file or confirmation is made from it", unsettledBook(short), "invoices");
  const pressed = await payWithPayPal(store);
  is("and the PayPal press sends nothing", [pressed.ok ? "sent" : pressed.reason, created.length], ["invoices", 0]);

  part("Controls: a reading already counted takes nothing more, nor does a store without Stripe");
  redis.clear();
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", JSON.stringify({ id: "aaaaaaaaaaaa", email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
  ]);
  const start = await left(store);
  const api = (await apiAffiliates(store, async () => null)) as { invoices_checked?: unknown };
  const mcp = (await affiliatesTool(store, async () => null)) as { invoices_checked?: unknown };
  const paidAhead = await readBook(store, undefined, { keptPaid: true } as Parameters<typeof readBook>[2]);
  is("the API, MCP and an already counted reading: checked", [api.invoices_checked, mcp.invoices_checked, paidAhead.invoicesChecked], [true, true, true]);
  is("none of them took a studio request", start - (await left(store)) - 1, 0);
  const noStripe = shop({ stripeAccountId: undefined });
  const plain = await left(noStripe);
  await readBook(noStripe);
  is("a store without Stripe reads no invoice and takes none", plain - (await left(noStripe)) - 1, 0);

  done();
}

void main();
