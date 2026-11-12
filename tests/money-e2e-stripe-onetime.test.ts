/**
 * Money hunt, end to end: Stripe one-time products, bundles and a cart of
 * several lines (synthetic only; no network, no real Stripe, no email).
 *
 * There is no Stripe webhook receiver: money state is pulled from the
 * creator's connected account whenever a page needs it. So the "replays" and
 * "out of order" cases here are: the same paid checkout read twice (two
 * spellings of the buyer's address, a refund row listed twice, the same order
 * counted twice), a refund or a dispute read before the sale it gives back is
 * among the sales read, list rows reordered, and replies partial or unknown.
 *
 * Invariants held at each step, through the real exported code:
 *   1. charged = refunded + kept, in the creator's numbers (lib/stats.ts
 *      readSales, keptIn), on the receipt (lib/receipt-pdf.ts receiptFrom)
 *      and in GET /api/v1/sales (lib/api-sales.ts sales);
 *   2. access follows lib/refunds.ts: paid or partly refunded keeps it, fully
 *      refunded or a dispute lost closes it; an open or won dispute does not;
 *   3. nothing happens twice on a replay (one purchase listed, one order
 *      counted, one refund subtracted);
 *   4. an unknown, partial or malformed reply is never success, paid, zero,
 *      or "no refund".
 *
 * The parts headed "Was RED:" show defects found on main (f964dbd9); each failed
 * there on purpose and names its bug id. Every other part is a regression net
 * and passes on main.
 */
import { claimHandle, ensureStatsId, addProduct, setProductCourse, setStripeAccount, storeForEmail, type Store } from "@/lib/store";
import { disputeLost, givenBack, purchaseRefunded, refundedInFull } from "@/lib/refunds";
import { purchasesFor } from "@/lib/buyer-orders";
import { receiptFrom, type Seller } from "@/lib/receipt-pdf";
import { sales } from "@/lib/api-sales";
import { readSales } from "@/lib/stats";
import { countOrder, ordersIn } from "@/lib/orders";
import { calendarWindow } from "@/lib/allowance-window";
import { storeFolder } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_money_e2e_onetime_stand_in";

const OWNER = "money-onetime@example.com";
const HANDLE = "moneyonetime";
const ACCOUNT = "acct_MoneyOneTime01";
const NOW = Date.parse("2026-11-10T12:00:00Z");
const SEC = Math.floor(NOW / 1000);
const DAY = 86_400;

// ---------------------------------------------------------------------------
// A synthetic Stripe account, routed by path and query.
// ---------------------------------------------------------------------------
type Json = Record<string, unknown>;
/** Checkouts listed for a buyer's address (the orders page). */
const buyerSessions: Record<string, Json[]> = {};
/** A charge's disputes, as GET /disputes?charge= lists them. */
const chargeDisputes: Record<string, Json> = {};
/** The checkouts, refunds and disputes the creator's numbers read. */
let statsSessions: Json[] = [];
let refundPages: Json[] = [];
let disputePages: Json[] = [];
/** The page GET /api/v1/sales reads. */
let apiPage: Json = { object: "list", data: [], has_more: false };
const asked: string[] = [];

const list = (data: unknown[], hasMore = false): Json => ({ object: "list", data, has_more: hasMore });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com") throw new Error(`no network in this test: ${url}`);
  if ((init?.method ?? "GET") !== "GET") throw new Error(`this test only reads Stripe: ${init?.method} ${url}`);
  const path = url.pathname.replace(/^\/v1/, "");
  const q = url.searchParams;
  asked.push(`${path}?${q}`);
  const answer = (body: unknown) => Response.json(body);
  if (path === "/checkout/sessions") {
    if (q.has("customer_details[email]")) return answer(list(buyerSessions[q.get("customer_details[email]") ?? ""] ?? []));
    if (q.getAll("expand[]").includes("data.payment_intent.latest_charge") && !q.has("status")) return answer(apiPage);
    return answer(list(statsSessions));
  }
  if (path === "/refunds") return answer(refundPages.shift() ?? list([]));
  if (path === "/disputes") {
    const charge = q.get("charge");
    if (charge) return answer(chargeDisputes[charge] ?? list([]));
    return answer(disputePages.shift() ?? list([]));
  }
  return answer(list([]));
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const charge = (id: string, amount: number, back = 0, extra: Json = {}): Json => ({
  object: "charge", id, amount, amount_refunded: back, refunded: back >= amount, disputed: false,
  paid: true, status: "succeeded", currency: "usd", created: SEC - DAY, payment_intent: `pi_${id.slice(3)}`, ...extra,
});
const intent = (ch: Json): Json => ({ object: "payment_intent", id: `pi_${String(ch.id).slice(3)}`, status: "succeeded", latest_charge: ch });
const dispute = (id: string, chargeId: string, status: string, amount: number, extra: Json = {}): Json => ({
  object: "dispute", id, charge: chargeId, status, amount, currency: "usd", created: SEC - DAY, payment_intent: `pi_${chargeId.slice(3)}`, ...extra,
});

/** One of the buyer's paid checkouts, its payment and charge expanded. */
const checkout = (id: string, product: string, ch: Json, extra: Json = {}): Json => ({
  id, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid",
  created: SEC - DAY, customer: null, metadata: { store: HANDLE, product }, payment_intent: intent(ch), ...extra,
});

async function main(): Promise<void> {
  redis.clear();
  const realError = console.error;
  console.error = () => {};

  await claimHandle(OWNER, HANDLE, "Money One Time", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const made = async (title: string, price: string, course: string) => {
    const added = await addProduct(OWNER, title, "", price, null);
    if (!added.ok) throw new Error(`no ${title}`);
    await setProductCourse(OWNER, added.product.id, { id: course, lessons: 3 });
    return added.product.id;
  };
  const guide = await made("Sourdough Guide", "49", "a".repeat(32));
  const kit = await made("Starter Kit", "30", "b".repeat(32));
  const store = (await storeForEmail(OWNER)) as Store;

  // -------------------------------------------------------------------------
  part("1. Access rule (lib/refunds.ts): paid, partial, full, dispute open / won / lost");
  // -------------------------------------------------------------------------
  const chPaid = charge("ch_Paid000001", 4900);
  const chPart = charge("ch_Part000001", 4900, 1500);
  const chFull = charge("ch_Full000001", 4900, 4900);
  const chOpen = charge("ch_Open000001", 4900, 0, { disputed: true });
  const chWon = charge("ch_Won0000001", 4900, 0, { disputed: true });
  const chLost = charge("ch_Lost000001", 4900, 0, { disputed: true });
  const chLostFx = charge("ch_LostFx0001", 4900, 0, { disputed: true });
  chargeDisputes.ch_Open000001 = list([dispute("dp_open1", "ch_Open000001", "needs_response", 4900)]);
  chargeDisputes.ch_Won0000001 = list([dispute("dp_won1", "ch_Won0000001", "won", 4900)]);
  chargeDisputes.ch_Lost000001 = list([dispute("dp_lost1", "ch_Lost000001", "lost", 4900)]);
  // A lost dispute for less than the charge (exchange rate): still the whole payment taken back (owner, 4 Nov 2026).
  chargeDisputes.ch_LostFx0001 = list([dispute("dp_lostfx", "ch_LostFx0001", "lost", 4730)]);
  const doors = async (ch: Json) => [refundedInFull(intent(ch)), await givenBack(ACCOUNT, intent(ch)), await purchaseRefunded(ACCOUNT, { mode: "payment", payment_intent: intent(ch) })];
  is("paid: kept everywhere", await doors(chPaid), [false, false, false]);
  is("partly refunded: kept (the creator chose to keep part)", await doors(chPart), [false, false, false]);
  is("refunded in full: given back", await doors(chFull), [true, true, true]);
  is("dispute open: kept", await doors(chOpen), [false, false, false]);
  is("dispute won by the creator: kept", await doors(chWon), [false, false, false]);
  is("dispute lost: given back (refundedInFull sees refunds only)", await doors(chLost), [false, true, true]);
  is("dispute lost for less than the charge: still given back", await doors(chLostFx), [false, true, true]);
  is("the same full refund read twice: same answer, nothing kept between reads", [refundedInFull(intent(chFull)), refundedInFull(intent(chFull))], [true, true]);

  part("1b. Dispute lists reordered, partial, malformed or naming another charge");
  const chTwo = charge("ch_TwoDisp001", 4900, 0, { disputed: true });
  chargeDisputes.ch_TwoDisp001 = list([dispute("dp_a", "ch_TwoDisp001", "won", 1000), dispute("dp_b", "ch_TwoDisp001", "lost", 3900)]);
  const first = await givenBack(ACCOUNT, intent(chTwo));
  chargeDisputes.ch_TwoDisp001 = list([dispute("dp_b", "ch_TwoDisp001", "lost", 3900), dispute("dp_a", "ch_TwoDisp001", "won", 1000)]);
  is("a lost dispute decides whichever order the rows come in", [first, await givenBack(ACCOUNT, intent(chTwo))], [true, true]);
  const throws = async (work: Promise<unknown>) => work.then(() => "answered", () => "unknown");
  chargeDisputes.ch_TwoDisp001 = list([dispute("dp_a", "ch_TwoDisp001", "won", 1000)], true);
  is("a won row on a list that says there is more: unknown, never 'not lost'", await throws(disputeLost(ACCOUNT, intent(chTwo))), "unknown");
  is("…and the door lets the buyer in meanwhile (keptUnlessLost, documented)", await purchaseRefunded(ACCOUNT, { mode: "payment", payment_intent: intent(chTwo) }), false);
  chargeDisputes.ch_TwoDisp001 = { object: "list", data: "nope", has_more: false };
  is("a reply that is not a list: unknown", await throws(givenBack(ACCOUNT, intent(chTwo))), "unknown");
  chargeDisputes.ch_TwoDisp001 = list([dispute("dp_x", "ch_SomeoneElse1", "lost", 4900)]);
  is("another charge's lost dispute never closes this buyer's door", [await throws(givenBack(ACCOUNT, intent(chTwo))), await purchaseRefunded(ACCOUNT, { mode: "payment", payment_intent: intent(chTwo) })], ["unknown", false]);
  is("a charge not expanded is never refunded, never lost", [refundedInFull({ object: "payment_intent", latest_charge: "ch_Paid000001" }), await givenBack(ACCOUNT, { object: "payment_intent", latest_charge: "ch_Paid000001" })], [false, false]);

  // -------------------------------------------------------------------------
  part("2. The buyer's list of purchases follows the same rule, each checkout once");
  // -------------------------------------------------------------------------
  const listed = async (email: string) => (await purchasesFor(store, email)).map((p) => p.reference).sort();
  const cs = (n: string) => `cs_test_money${n.padStart(10, "0")}`;
  buyerSessions["ana@example.com"] = [checkout(cs("ana1"), guide, chPaid), checkout(cs("ana2"), kit, chPart)];
  // The same paid checkout returned under both spellings of the address (Stripe keeps it as typed): listed once.
  buyerSessions["Ana@Example.com "] = buyerSessions["ana@example.com"];
  is("paid and partly refunded: both listed, each once", await listed("Ana@Example.com "), [cs("ana1"), cs("ana2")]);
  buyerSessions["ben@example.com"] = [checkout(cs("ben1"), guide, chFull)];
  is("refunded in full: off the list", await listed("ben@example.com"), []);
  buyerSessions["cy@example.com"] = [checkout(cs("cy1"), guide, chOpen), checkout(cs("cy2"), kit, chWon)];
  is("dispute open or won: still listed", await listed("cy@example.com"), [cs("cy1"), cs("cy2")]);
  buyerSessions["dee@example.com"] = [checkout(cs("dee1"), guide, chLost), checkout(cs("dee2"), kit, chLostFx)];
  is("dispute lost (any amount): off the list", await listed("dee@example.com"), []);
  buyerSessions["eve@example.com"] = [checkout(cs("eve1"), guide, chFull), checkout(cs("eve2"), guide, chPaid, { created: SEC - 3600 })];
  is("refunded, then bought again: the new purchase is listed", await listed("eve@example.com"), [cs("eve2")]);
  buyerSessions["fay@example.com"] = [checkout(cs("fay1"), guide, chPaid, { payment_status: "unpaid" })];
  is("a checkout Stripe says is unpaid: nothing handed over", await listed("fay@example.com"), []);

  // -------------------------------------------------------------------------
  part("3. Receipt PDF: total = charged, refunded shown, refused when given back or disputed");
  // -------------------------------------------------------------------------
  const seller: Seller = { name: "Money One Time", address: "1 Main St, Dover, DE", handles: new Set([HANDLE]) };
  const REF = "cs_test_receiptCart00001";
  // A cart of three lines: a product, a bundle and a ticked extra, with a discount and tax on top.
  const lines = [
    { id: "li_line000001", description: "Sourdough Guide", quantity: 1, amount_subtotal: 4900, currency: "usd" },
    { id: "li_line000002", description: "Baker's Bundle (3 products)", quantity: 1, amount_subtotal: 9900, currency: "usd" },
    { id: "li_line000003", description: "Starter Kit", quantity: 2, amount_subtotal: 6000, currency: "usd" },
  ];
  const receiptSession = (ch: Json, extra: Json = {}): Json => ({
    id: REF, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", currency: "usd",
    amount_subtotal: 20_800, amount_total: 20_800 - 800 + 1000,
    total_details: { amount_discount: 800, amount_shipping: 0, amount_tax: 1000 },
    customer_details: { email: "gus@example.com" }, metadata: { store: HANDLE }, payment_intent: intent(ch), ...extra,
  });
  const cartCharge = (back: number, extra: Json = {}) => charge("ch_Cart000001", 21_000, back, extra);
  const r = (ch: Json, page: Json = list(lines), session = receiptSession(ch)) => receiptFrom(seller, REF, session, page);
  const paidReceipt = r(cartCharge(0));
  is("paid: one receipt, total = what was charged, nothing refunded",
    paidReceipt.ok ? [paidReceipt.receipt.total, paidReceipt.receipt.refunded, paidReceipt.receipt.lines.length] : paidReceipt, [21_000, 0, 3]);
  const partReceipt = r(cartCharge(6000));
  is("partly refunded: charged = refunded + kept on the receipt",
    partReceipt.ok ? [partReceipt.receipt.total, partReceipt.receipt.refunded, partReceipt.receipt.total - partReceipt.receipt.refunded] : partReceipt, [21_000, 6000, 15_000]);
  is("refunded in full: no receipt", r(cartCharge(21_000)), { ok: false, why: "refunded" });
  is("disputed (open, won or lost: Stripe keeps the flag): no receipt", r(cartCharge(0, { disputed: true })), { ok: false, why: "disputed" });
  is("refunded more than charged: unreadable, never a receipt", r(cartCharge(25_000, { refunded: false })), { ok: false, why: "unreadable" });
  is("a charge that is not the checkout's total: unreadable", r(charge("ch_Cart000001", 20_000)), { ok: false, why: "unreadable" });
  is("lines reordered: the same receipt", (() => {
    const back = r(cartCharge(0), list([...lines].reverse()));
    return back.ok ? [back.receipt.total, back.receipt.lines.map((l) => l.amount).reduce((a, b) => a + b, 0)] : back;
  })(), [21_000, 20_800]);
  is("lines that say there are more: refused, never a cut receipt", r(cartCharge(0), list(lines.slice(0, 2), true)), { ok: false, why: "too_many_lines" });
  is("a line missing from a whole page: does not add up, unreadable", r(cartCharge(0), list(lines.slice(0, 2))), { ok: false, why: "unreadable" });
  is("a line whose amount is not read: unreadable, never zero", r(cartCharge(0), list([lines[0], { ...lines[1], amount_subtotal: "9900" }, lines[2]])), { ok: false, why: "unreadable" });
  is("the payment not expanded: unreadable", r(cartCharge(0), list(lines), receiptSession(cartCharge(0), { payment_intent: "pi_Cart000001" })), { ok: false, why: "unreadable" });
  is("an unpaid checkout: no receipt", r(cartCharge(0), list(lines), receiptSession(cartCharge(0), { payment_status: "unpaid" })), { ok: false, why: "not_paid" });

  // -------------------------------------------------------------------------
  part("4. GET /api/v1/sales: refunded and disputed off the charge, unknown never zero");
  // -------------------------------------------------------------------------
  const apiSession = (id: string, ch: Json, amount: number, meta: Json = {}): Json => ({
    id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created: SEC - 2 * DAY,
    payment_intent: intent(ch), invoice: null, amount_total: amount, currency: "usd", total_details: { amount_discount: 0 },
    customer_details: { email: "hal@example.com", name: "Hal" }, metadata: { store: HANDLE, product: guide, title: "Sourdough Guide", ...meta },
  });
  const read = async () => {
    const page = await sales(store, null, async () => null);
    return page && !(page instanceof Response) ? page : null;
  };
  apiPage = list([
    apiSession("cs_api_paid01", charge("ch_ApiPaid0001", 4900), 4900),
    apiSession("cs_api_part01", charge("ch_ApiPart0001", 4900, 1200), 4900),
    apiSession("cs_api_full01", charge("ch_ApiFull0001", 4900, 4900), 4900),
    apiSession("cs_api_disp01", charge("ch_ApiDisp0001", 4900, 0, { disputed: true }), 4900),
    apiSession("cs_api_bndl01", charge("ch_ApiBndl0001", 9900), 9900, { bundle: `${guide},${kit}` }),
  ]);
  const page = await read();
  is("each sale: amount, refunded, disputed off its own charge",
    page?.data.map((s) => [s.checkout_session, s.amount_cents, s.refunded_cents, s.disputed]),
    [["cs_api_paid01", 4900, 0, false], ["cs_api_part01", 4900, 1200, false], ["cs_api_full01", 4900, 4900, false], ["cs_api_disp01", 4900, 0, true], ["cs_api_bndl01", 9900, 0, false]]);
  is("a bundle sale names its products", page?.data[4]?.bundle_items && (page.data[4].bundle_items as { id: string }[]).map((p) => p.id), [guide, kit]);
  is("no sale says more was refunded than charged", page?.data.every((s) => (s.refunded_cents as number) <= (s.amount_cents as number)), true);
  apiPage = list([apiSession("cs_api_unk01", { ...charge("ch_ApiUnk00001", 4900), amount_refunded: undefined }, 4900)]);
  is("a charge whose refund is not read: the page is unknown, never 'no refund'", await read(), null);
  apiPage = list([apiSession("cs_api_unk02", { ...charge("ch_ApiUnk00002", 4900), disputed: "no" }, 4900)]);
  is("a charge whose dispute flag is not read: unknown", await read(), null);
  apiPage = list([{ ...apiSession("cs_api_unk03", charge("ch_ApiUnk00003", 4900), 4900), payment_intent: "pi_ApiUnk00003" }]);
  is("a payment not expanded: unknown, never 'nothing charged'", await read(), null);
  apiPage = { ...list([apiSession("cs_api_more1", charge("ch_ApiMore0001", 4900), 4900)], true), data: [{ id: 42 }] };
  is("a list whose rows are not checkouts: unknown", await read(), null);

  // -------------------------------------------------------------------------
  part("5. Creator's numbers (lib/stats.ts readSales): sales − refunds − disputes = kept");
  // -------------------------------------------------------------------------
  const sale = (id: string, pi: string, cents: number, extra: Json = {}): Json => ({
    id, object: "checkout.session", status: "complete", payment_status: "paid", amount_total: cents, currency: "usd",
    created: SEC - 3 * DAY, payment_intent: pi, customer_details: { email: "ivy@example.com" }, metadata: { store: HANDLE, product: guide }, ...extra,
  });
  const refund = (id: string, pi: string, cents: number, extra: Json = {}): Json => ({ id, object: "refund", status: "succeeded", amount: cents, currency: "usd", created: SEC - DAY, payment_intent: pi, ...extra });
  const statsDispute = (id: string, pi: string, status: string, cents: number, extra: Json = {}): Json => ({ id, object: "dispute", status, amount: cents, currency: "usd", created: SEC - DAY, payment_intent: pi, charge: `ch_${pi.slice(3)}`, ...extra });
  statsSessions = [sale("cs_test_statsA00001", "pi_StatsA0001", 5000), sale("cs_test_statsB00001", "pi_StatsB0001", 3000), sale("cs_test_statsC00001", "pi_StatsC0001", 2000)];
  const kept = async () => {
    const got = await readSales(store, NOW);
    const usd = got?.keptIn?.d30.lines.find((l) => l.currency === "usd");
    return { got, usd: usd ? { sales: usd.salesCents, refunds: usd.refundCents, disputes: usd.disputeCents, kept: usd.keptCents, missing: usd.missing } : null };
  };
  // Sale A: a partial refund, then the rest (two refund rows): fully given back. Sale B: dispute lost. Sale C: dispute won.
  refundPages = [list([refund("re_A1", "pi_StatsA0001", 1000), refund("re_A2", "pi_StatsA0001", 4000)])];
  disputePages = [list([statsDispute("dp_B", "pi_StatsB0001", "lost", 3000), statsDispute("dp_C", "pi_StatsC0001", "won", 2000)])];
  const base = await kept();
  is("charged = refunded + disputed + kept, and a won dispute takes nothing", base.usd, { sales: 10_000, refunds: 5000, disputes: 3000, kept: 2000, missing: [] });
  is("every refund matched to a sale read: the cash flow is complete", base.got?.cashflowComplete, true);
  refundPages = [list([refund("re_A2", "pi_StatsA0001", 4000), refund("re_A1", "pi_StatsA0001", 1000)])];
  disputePages = [list([statsDispute("dp_C", "pi_StatsC0001", "won", 2000), statsDispute("dp_B", "pi_StatsB0001", "lost", 3000)])];
  is("rows reordered: the same kept money", (await kept()).usd, base.usd);
  refundPages = [list([refund("re_A1", "pi_StatsA0001", 1000), refund("re_A1", "pi_StatsA0001", 1000)])];
  disputePages = [list([])];
  is("the same refund listed twice: never subtracted twice, the reading is unknown", (await kept()).usd?.kept, null);
  // A refund read before its sale is among the sales read (the checkout is newer than the list read, or another store's).
  refundPages = [list([refund("re_Early", "pi_NotReadYet1", 1500)])];
  disputePages = [list([])];
  const early = await kept();
  is("a refund whose sale was not read: still subtracted, and the cash flow not complete", [early.usd?.refunds, early.usd?.kept, early.got?.cashflowComplete], [1500, 8500, false]);
  // Every page the numbers may read (five) says there is more: the reading stops before the end.
  refundPages = Array.from({ length: 5 }, (_, i) => list([refund(`re_More${i}`, "pi_StatsA0001", 100)], true));
  disputePages = [list([])];
  is("a refund list that stops early: not complete", (await kept()).got?.cashflowComplete, false);
  refundPages = [{ data: "nope" }];
  disputePages = [list([])];
  is("a refund reply that is not a list: kept unknown, never 'no refund'", (await kept()).usd?.kept, null);
  refundPages = [list([refund("re_Zero", "pi_StatsA0001", 1000, { amount: "1000" })])];
  disputePages = [list([])];
  is("a refund whose amount is not read: kept unknown, never zero", (await kept()).usd?.kept, null);
  refundPages = [list([])];
  disputePages = [list([statsDispute("dp_Open", "pi_StatsB0001", "needs_response", 3000)])];
  is("an open dispute: the bank holds the money, out of kept", (await kept()).usd?.kept, 7000);

  // -------------------------------------------------------------------------
  part("6. The same paid checkout confirmed twice counts one order");
  // -------------------------------------------------------------------------
  const folder = await storeFolder(OWNER);
  const month = calendarWindow(NOW).id;
  const ref = "checkout:cs_test_moneyReplay00001";
  const once = await countOrder(store, ref, 4900, NOW);
  const twice = await countOrder(store, ref, 4900, NOW);
  const thrice = await countOrder(store, ref, 4900, NOW);
  is("return page, cron and email retry: counted once", [once, twice, thrice, await ordersIn(folder, month)], [true, false, false, 1]);

  // =========================================================================
  // Defects found on main (f964dbd9): each part below failed there and passes with its fix.
  // =========================================================================
  part("Was RED: MM-E2E-OT-1 — a refund whose date is not read silently drops out of the creator's kept money");
  // Was RED on main: MM-E2E-OT-1 (lib/stats.ts readRefunds: `created: typeof row.created === "number" ? … : 0`)
  // The refund lands on 1970-01-01, outside every window, and keptIn's holdsUnread skips days before the window:
  // the store is shown as having kept the whole sale, with the reading said complete.
  refundPages = [list([refund("re_NoDate", "pi_StatsA0001", 5000, { created: "yesterday" })])];
  disputePages = [list([])];
  const noDate = await kept();
  is("MM-E2E-OT-1: kept is unknown, never the whole sale", noDate.usd?.kept, null);
  is("MM-E2E-OT-1: the cash flow is not complete", noDate.got?.cashflowComplete, false);

  part("Was RED: MM-E2E-OT-2 — a dispute whose amount or date is not read silently drops out of kept money");
  // Was RED on main: MM-E2E-OT-2 (lib/stats.ts readDisputes: `const cents = … ? row.amount : 0; if (!cents) continue;` and `created … : 0`)
  // A lost dispute with an amount that does not read is skipped without marking the reading partial.
  refundPages = [list([])];
  disputePages = [list([statsDispute("dp_NoAmt", "pi_StatsB0001", "lost", 3000, { amount: "3000" })])];
  const noAmount = await kept();
  is("MM-E2E-OT-2: a lost dispute's amount unread: kept is unknown", noAmount.usd?.kept, null);
  is("MM-E2E-OT-2: and disputes are not said complete", noAmount.got?.disputesComplete, false);
  refundPages = [list([])];
  disputePages = [list([statsDispute("dp_NoDay", "pi_StatsB0001", "lost", 3000, { created: null })])];
  is("MM-E2E-OT-2: a lost dispute's date unread: kept is unknown", (await kept()).usd?.kept, null);

  part("Was RED: MM-E2E-OT-3 — a paid sale whose amount is not read counts as $0 in the creator's numbers");
  // Was RED on main: MM-E2E-OT-3 (lib/stats.ts readPaidSales: `cents: typeof row.amount_total === "number" ? … : 0`, `created: … : Date.now()`)
  statsSessions = [sale("cs_test_statsA00001", "pi_StatsA0001", 5000), sale("cs_test_statsZ00001", "pi_StatsZ0001", 0, { amount_total: "3000" })];
  refundPages = [list([])];
  disputePages = [list([])];
  const noTotal = await kept();
  is("MM-E2E-OT-3: kept is unknown, never the readable sale alone", noTotal.usd?.kept, null);
  is("MM-E2E-OT-3: the reading is not complete", noTotal.got?.paymentsComplete, false);

  // MM-E2E-OT-4 (LEVE, not fixed here): GET /api/v1/sales reads amount_refunded without the charge's amount, so a
  // refund above the charge, or a charge that is not the checkout's total, is echoed; the fix needs every
  // api-sales fixture to carry the charge's amount, left to its own pull request.

  console.error = realError;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
