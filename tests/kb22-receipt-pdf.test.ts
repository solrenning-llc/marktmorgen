/**
 * 601 [KB22] unit U1 (docs/reviews/c5-kb22-audit.md): one sale's receipt as a
 * tagged PDF (PDF/UA, AX274), downloaded from the studio's list of sales.
 *
 * The receipt is the creator's: the sale is a direct charge on their own
 * Stripe account, read there each time and kept nowhere. Every figure on it
 * is one Stripe gave for that sale; a figure missing, of another type, or
 * that does not add up makes no file at all, never a receipt with a zero.
 * Synthetic data only: Stripe and the email service are stand-ins.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";
import {
  RECEIPT_MAX_DESCRIPTION,
  RECEIPT_MAX_LINES,
  RECEIPT_PDF_MAX_BYTES,
  RECEIPT_PDF_UNITS,
  RECEIPT_STRIPE_TIMEOUT_MS,
  receiptDrawable,
  receiptFrom,
  receiptPdf,
  receiptTexts,
} from "@/lib/receipt-pdf";
import { claimHandle, ensureStatsId, setMailSettings, setStripeAccount, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { GET as receiptFile, maxDuration } from "@/app/api/store/receipt-pdf/route";
import { ORIGIN_PER_BYTE, SHAPES, UNIT_COST, request } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const REF = "cs_test_a1B2c3D4e5F6g7H8i9J0";
const HANDLE = "harborreceipts";

/** A paid one-time checkout as the creator's Stripe account returns it, read with its payment and charge expanded. */
function paidSession(over: Record<string, unknown> = {}, charge: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REF,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    currency: "usd",
    amount_subtotal: 5400,
    amount_total: 5260,
    total_details: { amount_discount: 500, amount_shipping: 0, amount_tax: 360 },
    customer_details: { email: "dana@example.com" },
    metadata: { store: HANDLE, product: "p1" },
    payment_intent: {
      id: "pi_1TestReceipt0001",
      object: "payment_intent",
      status: "succeeded",
      amount: 5260,
      currency: "usd",
      latest_charge: {
        id: "ch_1TestReceipt0001",
        object: "charge",
        paid: true,
        status: "succeeded",
        amount: 5260,
        amount_refunded: 0,
        refunded: false,
        disputed: false,
        currency: "usd",
        created: 1_790_000_000,
        ...charge,
      },
    },
    ...over,
  };
}

/** Its lines, one page of GET /checkout/sessions/:id/line_items. */
function linesPage(rows?: Record<string, unknown>[], hasMore = false): Record<string, unknown> {
  return {
    object: "list",
    has_more: hasMore,
    data: rows ?? [
      { id: "li_1TestLine0001", object: "item", description: "Sourdough Course", quantity: 1, amount_subtotal: 4900, amount_total: 4767, currency: "usd" },
      { id: "li_1TestLine0002", object: "item", description: "Starter jar label pack", quantity: 2, amount_subtotal: 500, amount_total: 493, currency: "usd" },
    ],
  };
}

const seller = { name: "Harbor Kitchen", address: "12 Pier Road, Portland, ME 04101, USA", handles: new Set([HANDLE]) };

/** Each element of the structure tree, in reading order, and the document's own marks. */
async function structure(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const root = doc.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
  const document = root.lookup(PDFName.of("K"), PDFDict);
  const kids = document.lookup(PDFName.of("K"), PDFArray).asArray().map((ref) => doc.context.lookup(ref as PDFRef, PDFDict));
  const metadata = doc.context.lookup(doc.catalog.get(PDFName.of("Metadata")) as PDFRef) as PDFRawStream;
  const xmp = new TextDecoder().decode(decodePDFRawStream(metadata).decode());
  const marked = doc.catalog.lookup(PDFName.of("MarkInfo"), PDFDict).get(PDFName.of("Marked"))?.toString();
  const display = doc.catalog.lookup(PDFName.of("ViewerPreferences"), PDFDict).get(PDFName.of("DisplayDocTitle"))?.toString();
  return { doc, roles: kids.map((k) => k.get(PDFName.of("S"))!.toString()), xmp, marked, display, pages: doc.getPageCount() };
}

/** What Stripe answers in the route's part, by path. */
const onStripe = new Map<string, { status: number; body: unknown }>();
const stripeCalls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  stripeCalls.push(url.pathname);
  const kept = onStripe.get(url.pathname);
  if (kept) return new Response(JSON.stringify(kept.body), { status: kept.status });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${url.pathname}` } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_receipts_only_a_stand_in";

  part("Read from Stripe's own figures");
  const read = receiptFrom(seller, REF, paidSession(), linesPage());
  is("a paid sale is a receipt", read.ok, true);
  if (!read.ok) throw new Error("no receipt");
  const r = read.receipt;
  is("every figure is Stripe's, unchanged", [r.subtotal, r.discount, r.shipping, r.tax, r.taxIncluded, r.total, r.refunded, r.currency, r.paidAt], [5400, 500, 0, 360, false, 5260, 0, "usd", 1_790_000_000]);
  is("the lines as Stripe lists them", r.lines, [{ description: "Sourdough Course", quantity: 1, amount: 4900 }, { description: "Starter jar label pack", quantity: 2, amount: 500 }]);
  is("the buyer's address as they paid with it", r.buyerEmail, "dana@example.com");
  is("the seller as the store keeps them", [r.sellerName, r.sellerAddress], ["Harbor Kitchen", "12 Pier Road, Portland, ME 04101, USA"]);

  part("What it says, in order");
  is("seller, sale, items, totals, and who charged it", receiptTexts(r).map((t) => `${t.role}:${t.text}`), [
    "H1:Receipt from Harbor Kitchen",
    "P:12 Pier Road, Portland, ME 04101, USA",
    "H2:Sale",
    "P:Paid on September 21, 2026, 2:13 PM UTC",
    "P:Paid by dana@example.com",
    `P:Stripe reference ${REF}`,
    "H2:Items",
    "P:Sourdough Course, quantity 1: $49",
    "P:Starter jar label pack, quantity 2: $5",
    "H2:Totals",
    "P:Subtotal: $54",
    "P:Discount: -$5",
    "P:Tax: $3.60",
    "P:Total paid: $52.60",
    "H2:About this receipt",
    "P:Harbor Kitchen charged this payment on their own Stripe account. Marktmorgen made this file from Stripe's record of the sale and did not take or hold the payment.",
  ]);
  const noAddress = receiptFrom({ ...seller, address: null }, REF, paidSession(), linesPage());
  is("no postal address kept: none is made up", noAddress.ok && receiptTexts(noAddress.receipt).some((t) => /Pier|address/i.test(t.text)), false);

  part("Tax as Stripe reports it");
  const inclusive = receiptFrom(seller, REF, paidSession({ amount_subtotal: 5400, amount_total: 4900, total_details: { amount_discount: 500, amount_shipping: 0, amount_tax: 817 } }, { amount: 4900 }), linesPage());
  is("tax inside the prices: said so, not added again", inclusive.ok && [inclusive.receipt.taxIncluded, receiptTexts(inclusive.receipt).find((t) => t.text.startsWith("Tax"))?.text], [true, "Tax included in the prices above: $8.17"]);
  const shipped = receiptFrom(seller, REF, paidSession({ amount_total: 5660, total_details: { amount_discount: 500, amount_shipping: 400, amount_tax: 360 } }, { amount: 5660 }), linesPage());
  is("shipping shown when Stripe charged it", shipped.ok && receiptTexts(shipped.receipt).some((t) => t.text === "Shipping: $4"), true);
  const untaxed = receiptFrom(seller, REF, paidSession({ amount_total: 4900, total_details: { amount_discount: 500, amount_shipping: 0, amount_tax: 0 } }, { amount: 4900 }), linesPage());
  is("no tax charged: Stripe's zero is shown as Stripe's", untaxed.ok && receiptTexts(untaxed.receipt).find((t) => t.text.startsWith("Tax"))?.text, "Tax: $0");
  const yen = receiptFrom(seller, REF, paidSession({ currency: "jpy", amount_subtotal: 2700, amount_total: 2700, total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 } }, { amount: 2700, currency: "jpy" }), linesPage([{ id: "li_1TestLineYen01", description: "Kit", quantity: 1, amount_subtotal: 2700, amount_total: 2700, currency: "jpy" }]));
  is("a currency without cents is written whole", yen.ok && receiptTexts(yen.receipt).find((t) => t.text.startsWith("Total paid"))?.text, "Total paid: ¥2,700");
  is("the payment's currency must be the sale's", receiptFrom(seller, REF, paidSession({}, { currency: "eur" }), linesPage()), { ok: false, why: "unreadable" });

  part("Refunds");
  const partly = receiptFrom(seller, REF, paidSession({}, { amount_refunded: 1000 }), linesPage());
  is("part refunded: the refund and what is left, both from Stripe's figures", partly.ok && receiptTexts(partly.receipt).filter((t) => /Refunded|after refunds/.test(t.text)).map((t) => t.text), ["Refunded: $10", "Paid after refunds: $42.60"]);
  is("refunded in full: no receipt", receiptFrom(seller, REF, paidSession({}, { amount_refunded: 5260, refunded: true }), linesPage()), { ok: false, why: "refunded" });
  is("a refund larger than the charge is not a figure to print", receiptFrom(seller, REF, paidSession({}, { amount_refunded: 9999 }), linesPage()), { ok: false, why: "unreadable" });
  is("a disputed payment: no receipt while Stripe holds it", receiptFrom(seller, REF, paidSession({}, { disputed: true }), linesPage()), { ok: false, why: "disputed" });

  part("Not a receipt");
  is("another store's sale on the same account", receiptFrom(seller, REF, paidSession({ metadata: { store: "someoneelse" } }), linesPage()), { ok: false, why: "unknown" });
  is("a sale with no store named", receiptFrom(seller, REF, paidSession({ metadata: {} }), linesPage()), { ok: false, why: "unknown" });
  is("Stripe answering for another checkout", receiptFrom(seller, REF, paidSession({ id: "cs_test_zzzzzzzzzzzzzzzz" }), linesPage()), { ok: false, why: "unknown" });
  is("not paid", receiptFrom(seller, REF, paidSession({ status: "open", payment_status: "unpaid" }), linesPage()), { ok: false, why: "not_paid" });
  is("paid later by bank (not settled)", receiptFrom(seller, REF, paidSession({ payment_status: "unpaid" }), linesPage()), { ok: false, why: "not_paid" });
  is("a membership: its invoices are Stripe's", receiptFrom(seller, REF, paidSession({ mode: "subscription" }), linesPage()), { ok: false, why: "subscription" });
  is("nothing charged", receiptFrom(seller, REF, paidSession({ amount_total: 0, payment_intent: null, payment_status: "no_payment_required" }), linesPage()), { ok: false, why: "nothing_charged" });

  part("A figure unknown makes no file, never a zero");
  const missingTax = paidSession({ total_details: { amount_discount: 500, amount_shipping: 0 } });
  is("tax missing", receiptFrom(seller, REF, missingTax, linesPage()), { ok: false, why: "unreadable" });
  is("tax as text", receiptFrom(seller, REF, paidSession({ total_details: { amount_discount: 500, amount_shipping: 0, amount_tax: "360" } }), linesPage()), { ok: false, why: "unreadable" });
  is("totals that do not add up", receiptFrom(seller, REF, paidSession({ amount_total: 5261 }, { amount: 5261 }), linesPage()), { ok: false, why: "unreadable" });
  is("lines that do not add up to the subtotal", receiptFrom(seller, REF, paidSession(), linesPage([{ id: "li_1TestLine0001", description: "Sourdough Course", quantity: 1, amount_subtotal: 4900, amount_total: 4767, currency: "usd" }])), { ok: false, why: "unreadable" });
  is("a line Stripe gave in another shape", receiptFrom(seller, REF, paidSession(), linesPage([{ id: "li_1TestLine0001", description: "Sourdough Course", quantity: 1, amount_subtotal: 5400, currency: "usd" }, { id: "li_1TestLine0002", description: null, quantity: 1, amount_subtotal: 0, currency: "usd" }])), { ok: false, why: "unreadable" });
  is("a list that goes on past one page", receiptFrom(seller, REF, paidSession(), linesPage(undefined, true)), { ok: false, why: "too_many_lines" });
  const tooMany = Array.from({ length: RECEIPT_MAX_LINES + 1 }, (_, i) => ({ id: `li_1TestMany${String(i).padStart(4, "0")}`, description: "Kit", quantity: 1, amount_subtotal: i === 0 ? 5400 : 0, currency: "usd" }));
  is(`more than ${RECEIPT_MAX_LINES} lines: refused, never cut short`, receiptFrom(seller, REF, paidSession(), linesPage(tooMany)), { ok: false, why: "too_many_lines" });
  is("a line name longer than any checkout here gives", receiptFrom(seller, REF, paidSession(), linesPage([{ id: "li_1TestLine0001", description: "x".repeat(RECEIPT_MAX_DESCRIPTION + 1), quantity: 1, amount_subtotal: 5400, currency: "usd" }])), { ok: false, why: "unreadable" });
  is("a list in another shape", receiptFrom(seller, REF, paidSession(), { data: "nope" }), { ok: false, why: "unreadable" });
  is("a charge for another amount", receiptFrom(seller, REF, paidSession({}, { amount: 5000 }), linesPage()), { ok: false, why: "unreadable" });
  is("the payment not expanded", receiptFrom(seller, REF, paidSession({ payment_intent: "pi_1TestReceipt0001" }), linesPage()), { ok: false, why: "unreadable" });
  is("no buyer address", receiptFrom(seller, REF, paidSession({ customer_details: null }), linesPage()), { ok: false, why: "unreadable" });

  part("Figures that cannot be true make no file (Codex P M1/L1 on #2952)");
  // One line of 100 cents, so each case below changes only the tax or the date.
  const hundred = linesPage([{ id: "li_1TestLineTax01", object: "item", description: "Kit", quantity: 1, amount_subtotal: 100, amount_total: 100, currency: "usd" }]);
  const included = (tax: number) => receiptFrom(seller, REF, paidSession({ amount_subtotal: 100, amount_total: 100, total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: tax } }, { amount: 100 }), hundred);
  is("tax said to be inside a total smaller than it: unreadable", included(101), { ok: false, why: "unreadable" });
  is("tax said to be the whole of a total: unreadable", included(100), { ok: false, why: "unreadable" });
  const smaller = included(99);
  is("control: tax inside the total and smaller than it still reads", smaller.ok && [smaller.receipt.taxIncluded, smaller.receipt.tax, smaller.receipt.total], [true, 99, 100]);
  const none = included(0);
  is("control: no tax on a total that adds up without it still reads", none.ok && [none.receipt.taxIncluded, none.receipt.tax], [false, 0]);
  const MAX_SECONDS = 8_640_000_000_000; // the last second a Date can hold (8.64e15 ms)
  const at = (created: number) => receiptFrom(seller, REF, paidSession({}, { created }), linesPage());
  is("a charge date past any Date: unreadable, not a crash", at(Number.MAX_SAFE_INTEGER), { ok: false, why: "unreadable" });
  is("a charge date one second past the last Date: unreadable", at(MAX_SECONDS + 1), { ok: false, why: "unreadable" });
  const last = at(MAX_SECONDS);
  let lastDrawable: unknown;
  try { lastDrawable = last.ok && (await receiptDrawable(last.receipt)); } catch (error) { lastDrawable = `threw ${String(error)}`; }
  is("control: the last date a Date can hold still reads and draws", [last.ok, lastDrawable], [true, true]);

  part("The file: tagged for a screen reader (PDF/UA)");
  const one = await structure(await receiptPdf(r));
  is("one page, a heading first, every text an element, in order", [one.pages, one.roles.length, one.roles[0]], [1, receiptTexts(r).length, "/H1"]);
  is("the roles are the texts' roles, in reading order", one.roles, receiptTexts(r).map((t) => `/${t.role}`));
  is("its title shown instead of the file name, and its language", [one.doc.getTitle(), one.doc.catalog.get(PDFName.of("Lang"))?.toString(), one.display], ["Receipt from Harbor Kitchen — September 21, 2026", "(en-US)", "true"]);
  is("marked, with the PDF/UA part in its XMP", [one.marked, one.xmp.includes("<pdfuaid:part>1</pdfuaid:part>"), one.xmp.includes("<dc:language><rdf:Bag><rdf:li>en-US</rdf:li>")], ["true", true, true]);
  const lines = Array.from({ length: RECEIPT_MAX_LINES }, (_, i) => ({ description: `Line ${i + 1}: ${"A long product name with many words in it ".repeat(12)}`.slice(0, RECEIPT_MAX_DESCRIPTION), quantity: 99, amount: 999_999 }));
  const drawStart = performance.now();
  const longest = await receiptPdf({ ...r, lines, subtotal: 99_999_900, total: 99_999_900, discount: 0, tax: 0, sellerAddress: "x".repeat(200) });
  const many = await structure(longest);
  console.log(`  (the heaviest drawn in ${Math.round(performance.now() - drawStart)} ms, ${longest.byteLength} bytes, ${many.pages} pages)`);
  is("the most lines run over pages and stay in order", [many.pages > 1, many.roles.filter((role) => role === "/H2").length], [true, 4]);
  is(`the heaviest file stays under ${RECEIPT_PDF_MAX_BYTES} bytes (${longest.byteLength})`, longest.byteLength <= RECEIPT_PDF_MAX_BYTES, true);

  part("Its cost: inside the studio's own requests, taken before Stripe is read");
  const worst = request("step", 40, 200_000) + RECEIPT_PDF_MAX_BYTES * ORIGIN_PER_BYTE;
  is(`${RECEIPT_PDF_UNITS} studio requests ($${(RECEIPT_PDF_UNITS * UNIT_COST.studio).toFixed(6)}) cover the worst file ($${worst.toFixed(6)})`, RECEIPT_PDF_UNITS * UNIT_COST.studio >= worst, true);
  is("the function stops within the shape priced", maxDuration <= SHAPES.step.seconds, true);
  is("both Stripe reads, side by side, end inside it", RECEIPT_STRIPE_TIMEOUT_MS < maxDuration * 1000, true);
  const route = readFileSync("app/api/store/receipt-pdf/route.ts", "utf8");
  is("the rest of the requests are taken before Stripe is read", route.indexOf("countStudio(store, null, RECEIPT_PDF_UNITS - 1)") > 0 && route.indexOf("countStudio(store, null, RECEIPT_PDF_UNITS - 1)") < route.indexOf("readReceipt("), true);

  part("Downloaded from the studio");
  const OWNER = "receipts@example.com";
  await claimHandle(OWNER, HANDLE, "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestReceipts01", true);
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "12 Pier Road, Portland, ME 04101, USA" });
  const store = (await storeForEmail(OWNER))!;
  const session = await openSession(OWNER);
  const get = (query: string, signedIn = true) =>
    receiptFile(new NextRequest(`https://marktmorgen.com/api/store/receipt-pdf?${query}`, { headers: signedIn ? { cookie: `${SESSION_COOKIE}=${session}` } : {} }));
  const sessionPath = `/v1/checkout/sessions/${REF}`;
  const linesPath = `/v1/checkout/sessions/${REF}/line_items`;
  const answer = (sale: unknown, items: unknown, status = 200) => {
    onStripe.set(sessionPath, { status, body: status === 200 ? sale : { error: { message: "No such checkout.session" } } });
    onStripe.set(linesPath, { status, body: status === 200 ? items : { error: { message: "No such checkout.session" } } });
  };
  answer(paidSession(), linesPage());
  is("signed out: refused, nothing read", [(await get(`reference=${REF}`, false)).status >= 300, stripeCalls.length], [true, 0]);
  is("which sale: asked, nothing read", [(await get("reference=nope")).status, stripeCalls.length], [400, 0]);
  const ok = await get(`store=${store.sid}&reference=${REF}`);
  const bytes = new Uint8Array(await ok.arrayBuffer());
  is("the file, made on request, kept nowhere", [ok.status, ok.headers.get("content-type"), ok.headers.get("cache-control"), ok.headers.get("content-disposition")], [200, "application/pdf", "private, no-store", 'attachment; filename="receipt-2026-09-21.pdf"']);
  is("read on the creator's account: the sale and its lines, once each", stripeCalls.slice().sort(), [sessionPath, linesPath].sort());
  is("the same receipt as its figures make", (await structure(bytes)).doc.getTitle(), "Receipt from Harbor Kitchen — September 21, 2026");
  answer(paidSession({ metadata: { store: "someoneelse" } }), linesPage());
  const other = await get(`reference=${REF}`);
  is("another store's sale: not found, no PDF", [other.status, other.headers.get("content-type")?.startsWith("application/pdf") ?? false], [404, false]);
  answer(paidSession({ status: "open", payment_status: "unpaid" }), linesPage());
  is("unpaid: said so, no PDF", (await get(`reference=${REF}`)).status, 409);
  answer(paidSession({}, { amount_refunded: 5260, refunded: true }), linesPage());
  const refunded = await get(`reference=${REF}`);
  is("refunded in full: said so, no PDF", [refunded.status, await refunded.text()], [409, "This sale was refunded in full, so there is no receipt for it."]);
  answer(paidSession(), linesPage(), 404);
  is("not on this account: not found", (await get(`reference=${REF}`)).status, 404);
  answer(paidSession(), linesPage(), 500);
  const down = await get(`reference=${REF}`);
  is("Stripe not answering: unavailable, no PDF", [down.status, down.headers.get("content-type")?.startsWith("application/pdf") ?? false], [503, false]);
  answer(missingTax, linesPage());
  const unread = await get(`reference=${REF}`);
  is("a figure unknown: no PDF, and the reason in plain words", [unread.status, (await unread.text()).includes("Stripe dashboard")], [502, true]);
  answer(paidSession({}, { created: Number.MAX_SAFE_INTEGER }), linesPage());
  let farOff: unknown;
  try {
    const answered = await get(`reference=${REF}`);
    farOff = [answered.status, answered.headers.get("content-type")?.startsWith("application/pdf") ?? false];
  } catch (error) {
    farOff = `threw ${String(error)}`;
  }
  is("a charge date no Date can hold: the plain refusal, never a bare 500", farOff, [502, false]);

  part("Reached from the list of sales");
  const page = readFileSync("app/studio/page.tsx", "utf8");
  is("each one-time sale has its receipt, the link naming the sale and saying it is a PDF", page.includes("Download the receipt (PDF)<span className=\"sr-only\">"), true);
  is("the link goes to this route, for this store", page.includes("/api/store/receipt-pdf?"), true);
  done();
}
void main();
