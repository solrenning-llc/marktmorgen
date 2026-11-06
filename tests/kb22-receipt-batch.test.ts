/**
 * 601 [KB22] unit U3 (docs/reviews/c5-kb22-audit.md): a month's receipts in
 * one download, bounded before anything is made.
 *
 * The creator picks a month, or days inside one month. The store's one-time
 * paid sales in those days are counted from its own Stripe account, a few
 * bounded pages; above RECEIPT_BATCH_MAX the download is refused with the
 * count, before a single receipt is read or numbered. Each receipt is the
 * one-sale receipt (U1, lib/receipt-pdf.ts) with the store's number (U2,
 * lib/receipt-number.ts); the files go into a ZIP in number order, under a
 * byte ceiling. A sale with no receipt is never silently missing: it is named
 * in not-included.txt with its reason. The studio requests the whole download
 * can cost are taken before Stripe is read (owner's rule MR).
 * Synthetic data only: Stripe is a stand-in.
 */
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";
import {
  LEFT_OUT_FILE,
  RECEIPT_BATCH_MAX,
  RECEIPT_BATCH_READS_AT_ONCE,
  RECEIPT_BATCH_RESERVE_SECONDS,
  RECEIPT_LIST_PAGES,
  SKIP_WORDS,
  lastMonthDays,
  notIncludedText,
  receiptRange,
  zipStored,
} from "@/lib/receipt-batch-rules";
import { RECEIPT_BATCH_MAX_BYTES, RECEIPT_BATCH_SHAPE, RECEIPT_BATCH_UNITS, receiptBatch } from "@/lib/receipt-batch";
import { RECEIPT_PDF_MAX_BYTES, RECEIPT_PDF_UNITS, RECEIPT_STRIPE_TIMEOUT_MS } from "@/lib/receipt-pdf";
import { claimHandle, ensureStatsId, saleHandles, setMailSettings, setStripeAccount, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { GET as receiptOne } from "@/app/api/store/receipt-pdf/route";
import { GET as receiptMany, maxDuration } from "@/app/api/store/receipt-batch/route";
import { RECEIPT_BATCH_COST, UNIT_COST, readShapeCost } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const HANDLE = "harborbatch";
const ACCOUNT = "acct_1TestBatch0001";
/** Seconds of a day of October 2026, UTC. */
const OCT = (day: number, hour = 12, minute = 0) => Date.UTC(2026, 9, day, hour, minute) / 1000;

let made = 0;
/** A paid one-time checkout of the store, as the list returns it with its payment and charge expanded. */
function sale(ref: string, paidAt: number, over: Record<string, unknown> = {}, charge: Record<string, unknown> = {}): Record<string, unknown> {
  made += 1;
  return {
    id: ref,
    object: "checkout.session",
    created: paidAt - 60,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    currency: "usd",
    amount_subtotal: 4900,
    amount_total: 4900,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    customer_details: { email: `buyer${made}@example.com` },
    metadata: { store: HANDLE, product: "p1" },
    payment_intent: {
      id: `pi_1TestBatch${String(made).padStart(6, "0")}`,
      object: "payment_intent",
      status: "succeeded",
      latest_charge: {
        id: `ch_1TestBatch${String(made).padStart(6, "0")}`,
        object: "charge",
        paid: true,
        status: "succeeded",
        amount: 4900,
        amount_refunded: 0,
        refunded: false,
        disputed: false,
        currency: "usd",
        created: paidAt,
        ...charge,
      },
    },
    ...over,
  };
}
const lines = { object: "list", has_more: false, data: [{ id: "li_1TestBatchLine01", object: "item", description: "Sourdough Course", quantity: 1, amount_subtotal: 4900, amount_total: 4900, currency: "usd" }] };
const ref = (name: string) => `cs_test_batch${name.padEnd(16, "0")}`;

/** The stand-in Stripe: the list of checkouts in pages, and each sale's lines. */
let listed: Record<string, unknown>[] = [];
let listStatus = 200;
let listOverride: unknown = null;
const lineStatus = new Map<string, number>();
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  calls.push(`${url.pathname}${url.search}`);
  if (url.pathname === "/v1/checkout/sessions") {
    if (listStatus !== 200) return new Response(JSON.stringify({ error: { message: "down" } }), { status: listStatus });
    if (listOverride) return new Response(JSON.stringify(listOverride), { status: 200 });
    const after = url.searchParams.get("starting_after");
    const from = after ? listed.findIndex((row) => row.id === after) + 1 : 0;
    const limit = Number(url.searchParams.get("limit"));
    const rows = listed.slice(from, from + limit);
    return new Response(JSON.stringify({ object: "list", data: rows, has_more: from + limit < listed.length }), { status: 200 });
  }
  const m = /^\/v1\/checkout\/sessions\/([^/]+)\/line_items$/.exec(url.pathname);
  if (m) {
    const status = lineStatus.get(m[1]) ?? 200;
    return new Response(JSON.stringify(status === 200 ? lines : { error: { message: "nope" } }), { status });
  }
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (one) {
    const row = listed.find((r) => r.id === one[1]);
    return new Response(JSON.stringify(row ?? { error: { message: "No such checkout.session" } }), { status: row ? 200 : 404 });
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${url.pathname}` } }), { status: 404 });
}) as typeof fetch;

/** The entries of a ZIP, read by its central directory, each checked against its own CRC-32. */
function unzip(bytes: Uint8Array): { name: string; data: Uint8Array; crcOk: boolean; stored: boolean }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error("no end of central directory");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("bad central entry");
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error("bad local entry");
    const localName = view.getUint16(local + 26, true);
    const localExtra = view.getUint16(local + 28, true);
    const data = bytes.subarray(local + 30 + localName + localExtra, local + 30 + localName + localExtra + size);
    out.push({ name, data, crcOk: crc32(data) >>> 0 === crc, stored: method === 0 });
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_receipt_batch_only_a_stand_in";

  part("Which days: one month, or days inside one month");
  const october = receiptRange(new URLSearchParams("month=2026-10"));
  is("a month runs from its first second to the next month's", october.ok && [october.from, october.to, october.label], [OCT(1, 0), Date.UTC(2026, 10, 1) / 1000, "October 1, 2026 to October 31, 2026"]);
  const half = receiptRange(new URLSearchParams("from=2026-10-01&to=2026-10-15"));
  is("days inside a month: the last day whole", half.ok && [half.from, half.to, half.slug], [OCT(1, 0), OCT(16, 0), "2026-10-01-to-2026-10-15"]);
  for (const [what, query] of [
    ["across two months", "from=2026-10-20&to=2026-11-05"],
    ["the end before the start", "from=2026-10-15&to=2026-10-01"],
    ["a day that does not exist", "from=2026-02-01&to=2026-02-30"],
    ["no days at all", ""],
    ["another shape", "from=10/01/2026&to=10/31/2026"],
    ["a month that does not exist", "month=2026-13"],
  ] as const) {
    const r = receiptRange(new URLSearchParams(query));
    is(`refused: ${what}, with a sentence to act on`, !r.ok && r.message.length > 20, true);
  }

  part("The ZIP: stored files, each with its own check");
  const a = new TextEncoder().encode("first file");
  const b = new Uint8Array([0, 1, 2, 255, 254]);
  const zipped = unzip(zipStored([{ name: "receipt-R-000001.pdf", bytes: a }, { name: "not-included.txt", bytes: b }], new Date(Date.UTC(2026, 10, 6, 10, 30))));
  is("the names, in the order given", zipped.map((e) => e.name), ["receipt-R-000001.pdf", "not-included.txt"]);
  is("every byte kept, every CRC-32 right, nothing compressed", zipped.map((e) => [Array.from(e.data), e.crcOk, e.stored]), [[Array.from(a), true, true], [Array.from(b), true, true]]);
  is("an empty list is still a readable ZIP", unzip(zipStored([], new Date())).length, 0);

  part("What was left out, said plainly");
  const text = notIncludedText("October 1, 2026 to October 31, 2026", [{ reference: ref("x1"), why: "refunded" }, { reference: ref("x2"), why: "slow" }], 3);
  is("every sale left out is named with its reason", [text.includes(`${ref("x1")}: `), text.includes(`${ref("x2")}: `), /refunded in full/.test(text), /did not answer in time/.test(text)], [true, true, true, true]);
  is("and how many receipts the folder does have", /3 receipts are in this download/.test(text), true);
  is("every reason fits the line its ceiling allows", Object.values(SKIP_WORDS).every((w) => w.length <= 200), true);
  is("the form starts with last month", [lastMonthDays(Date.UTC(2026, 10, 6, 3)), lastMonthDays(Date.UTC(2027, 0, 2))], [{ from: "2026-10-01", to: "2026-10-31" }, { from: "2026-12-01", to: "2026-12-31" }]);

  part("Its cost: counted and capped before anything is read");
  is(`at most ${RECEIPT_BATCH_MAX} receipts a download`, RECEIPT_BATCH_MAX <= 50, true);
  is("the ZIP's ceiling holds every receipt at its heaviest", RECEIPT_BATCH_MAX_BYTES >= RECEIPT_BATCH_MAX * RECEIPT_PDF_MAX_BYTES, true);
  is("and stays under what a function may send back (4.5 MB)", RECEIPT_BATCH_MAX_BYTES < 4_500_000, true);
  const worst = readShapeCost(RECEIPT_BATCH_SHAPE);
  is(`${RECEIPT_BATCH_UNITS} studio requests ($${(RECEIPT_BATCH_UNITS * UNIT_COST.studio).toFixed(6)}) cover the worst download ($${worst.toFixed(6)})`, RECEIPT_BATCH_UNITS * UNIT_COST.studio >= worst, true);
  is("the registry shows the same line", RECEIPT_BATCH_COST, worst);
  is("never dearer than downloading each receipt on its own", RECEIPT_BATCH_UNITS <= RECEIPT_BATCH_MAX * RECEIPT_PDF_UNITS, true);
  is("the shape priced holds the function's whole time, all of it on the CPU", [maxDuration <= RECEIPT_BATCH_SHAPE.seconds, RECEIPT_BATCH_SHAPE.cpu >= RECEIPT_BATCH_SHAPE.seconds], [true, true]);
  is("every sale's lines and every page of the list are priced as a page waited on", RECEIPT_BATCH_SHAPE.stripePages >= RECEIPT_LIST_PAGES + RECEIPT_BATCH_MAX, true);
  is("reads stop with time left to number, draw and send", RECEIPT_BATCH_RESERVE_SECONDS * 1000 + RECEIPT_STRIPE_TIMEOUT_MS < maxDuration * 1000, true);
  const route = readFileSync("app/api/store/receipt-batch/route.ts", "utf8");
  const take = route.indexOf("countStudio(store, null, RECEIPT_BATCH_UNITS - 1)");
  is("the whole download's requests are taken before Stripe is read", take > 0 && take < route.indexOf("receiptBatch("), true);

  part("Downloaded from the studio");
  const OWNER = "batch@example.com";
  await claimHandle(OWNER, HANDLE, "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "12 Pier Road, Portland, ME 04101, USA" });
  const store = (await storeForEmail(OWNER))!;
  const session = await openSession(OWNER);
  const get = (query: string, signedIn = true, path = "receipt-batch") =>
    (path === "receipt-batch" ? receiptMany : receiptOne)(new NextRequest(`https://marktmorgen.com/api/store/${path}?${query}`, { headers: signedIn ? { cookie: `${SESSION_COOKIE}=${session}` } : {} }));

  // The store's studio requests this month, started again between parts (a store with no plan has a few hundred).
  const studioKeys = () => redis.keys().filter((k) => k.startsWith("nl:allow:studio:"));
  const refill = async () => { for (const k of studioKeys()) await redis.pipeline([["DEL", k]]); };
  const studioUsed = async () => (await Promise.all(studioKeys().map(async (k) => Number((await redis.pipeline([["GET", k]]))[0] ?? 0)))).reduce((a, b) => a + b, 0);

  listed = [
    sale(ref("a"), OCT(5)),
    sale(ref("b"), OCT(3)),
    sale(ref("c"), OCT(7), {}, { amount_refunded: 4900, refunded: true }),
    sale(ref("d"), OCT(9), { mode: "subscription" }),
    sale(ref("e"), OCT(10), { metadata: { store: "someoneelse" } }),
    sale(ref("f"), Date.UTC(2026, 8, 30, 23, 50) / 1000),
    // Opened on September 30th and paid just after midnight: October's.
    sale(ref("g"), OCT(1, 0, 1), { created: Date.UTC(2026, 8, 30, 23, 59) / 1000 }),
    sale(ref("h"), OCT(11), { payment_status: "unpaid" }),
  ];

  calls.length = 0;
  is("signed out: refused, nothing read", [(await get("month=2026-10", false)).status >= 300, calls.length], [true, 0]);
  const wrong = await get("from=2026-10-20&to=2026-11-05");
  is("days across two months: asked again, nothing read", [wrong.status, calls.length], [400, 0]);

  // One sale's receipt was downloaded on its own first: it keeps its number in the batch.
  const single = await get(`store=${store.sid}&reference=${ref("a")}`, true, "receipt-pdf");
  is("a receipt downloaded on its own first is R-000001", [single.status, single.headers.get("content-disposition")], [200, 'attachment; filename="receipt-R-000001.pdf"']);

  await refill();
  calls.length = 0;
  const res = await get(`store=${store.sid}&month=2026-10`);
  is(`the download took ${RECEIPT_BATCH_UNITS} studio requests, the studio's own check among them`, await studioUsed(), RECEIPT_BATCH_UNITS);
  const bytes = new Uint8Array(await res.arrayBuffer());
  is("a ZIP, made on request, kept nowhere", [res.status, res.headers.get("content-type"), res.headers.get("cache-control"), res.headers.get("content-disposition")], [200, "application/zip", "private, no-store", 'attachment; filename="receipts-2026-10-01-to-2026-10-31.zip"']);
  is("under its ceiling", bytes.byteLength <= RECEIPT_BATCH_MAX_BYTES, true);
  const entries = unzip(bytes);
  is("the receipts in number order, then what was left out", entries.map((e) => e.name), ["receipt-R-000001.pdf", "receipt-R-000002.pdf", "receipt-R-000003.pdf", LEFT_OUT_FILE]);
  is("every file whole", entries.every((e) => e.crcOk && e.stored), true);
  const titles = await Promise.all(entries.slice(0, 3).map(async (e) => (await PDFDocument.load(e.data)).getTitle()));
  is("the sale numbered first keeps its number; the new ones are numbered in the order they were paid", titles, [
    "Receipt R-000001 from Harbor Kitchen — October 5, 2026",
    "Receipt R-000002 from Harbor Kitchen — October 1, 2026",
    "Receipt R-000003 from Harbor Kitchen — October 3, 2026",
  ]);
  const left = new TextDecoder().decode(entries[3].data);
  is("the refunded sale is named with its reason, never silently missing", [left.includes(ref("c")), /refunded in full/.test(left)], [true, true]);
  is("a membership, another store's sale, an unpaid checkout or September's sale is not October's receipt", [ref("d"), ref("e"), ref("f"), ref("h")].some((r) => left.includes(r) || titles.join().includes(r)), false);
  const listCalls = calls.filter((c) => c.startsWith("/v1/checkout/sessions?"));
  is("the list is read once, a day early (a checkout stays open up to a day), complete checkouts only, payment expanded", [listCalls.length, listCalls[0]?.includes(`created[gte]=${OCT(1, 0) - 86_400}`), listCalls[0]?.includes(`created[lt]=${Date.UTC(2026, 10, 1) / 1000}`), listCalls[0]?.includes("status=complete"), listCalls[0]?.includes("expand[]=data.payment_intent.latest_charge")], [1, true, true, true, true]);
  is("each sale's lines read once; no sale read again", calls.filter((c) => c.endsWith("/line_items") || c.includes("/line_items?")).length, 4);

  calls.length = 0;
  const again = unzip(new Uint8Array(await (await get(`store=${store.sid}&month=2026-10`)).arrayBuffer()));
  is("downloaded again: the same numbers on the same sales", await Promise.all(again.slice(0, 3).map(async (e) => (await PDFDocument.load(e.data)).getTitle())), titles);

  part("Over the cap: refused with the count, before anything is read or numbered");
  await refill();
  listed = Array.from({ length: RECEIPT_BATCH_MAX + 1 }, (_, i) => sale(ref(`many${i}`), OCT(1 + (i % 28))));
  calls.length = 0;
  const counted = (await redis.pipeline([["GET", `nl:rcpt:seq:${store.sid}`]]))[0];
  const over = await get("month=2026-10");
  const overText = await over.text();
  is("refused, with the count and what to do", [over.status, overText.includes(`${RECEIPT_BATCH_MAX + 1} paid sales`), overText.includes(`${RECEIPT_BATCH_MAX}`), /shorter/.test(overText)], [409, true, true, true]);
  is("no sale's lines read", calls.some((c) => c.includes("/line_items")), false);
  is("no number given", (await redis.pipeline([["GET", `nl:rcpt:seq:${store.sid}`]]))[0], counted);
  const halfMonth = await get("from=2026-10-01&to=2026-10-14");
  is("half the month fits", [halfMonth.status, halfMonth.headers.get("content-type")], [200, "application/zip"]);

  part("Unknown never becomes a partial download presented as complete");
  await refill();
  listed = Array.from({ length: RECEIPT_LIST_PAGES * 100 + 1 }, (_, i) => sale(ref(`open${i}`), OCT(2), { metadata: { store: "someoneelse" } }));
  const tooLong = await get("month=2026-10");
  is("more checkouts than the pages read: refused, nothing made", [tooLong.status, /shorter/.test(await tooLong.text())], [409, true]);
  listed = [sale(ref("p"), OCT(2))];
  listOverride = { object: "list", has_more: false, data: [sale(ref("q"), OCT(2)), { id: 42 }] };
  is("a row of the list unreadable: no file", (await get("month=2026-10")).status, 502);
  listOverride = { object: "list", data: [] };
  is("a list without has_more: no file", (await get("month=2026-10")).status, 502);
  listOverride = null;
  listStatus = 500;
  const down = await get("month=2026-10");
  is("Stripe not answering the list: unavailable, no file", [down.status, down.headers.get("content-type")?.includes("zip") ?? false], [503, false]);
  listStatus = 200;
  await refill();
  listed = [sale(ref("r"), OCT(2)), sale(ref("s"), OCT(3))];
  lineStatus.set(ref("s"), 500);
  const partly = unzip(new Uint8Array(await (await get("month=2026-10")).arrayBuffer()));
  is("one sale's lines not answered: that sale named, the rest made", [partly.filter((e) => e.name.endsWith(".pdf")).length, new TextDecoder().decode(partly[partly.length - 1].data).includes(ref("s"))], [1, true]);
  lineStatus.clear();
  listed = [];
  const none = await get("month=2026-10");
  is("no sales in those days: said so, no file", [none.status, (await none.text()).includes("October 1, 2026 to October 31, 2026")], [404, true]);

  part("Out of time: the sales not read are named, never dropped");
  listed = Array.from({ length: RECEIPT_BATCH_READS_AT_ONCE * 2 }, (_, i) => sale(ref(`late${i}`), OCT(4)));
  const range = receiptRange(new URLSearchParams("month=2026-10"));
  if (!range.ok) throw new Error("range");
  let clock = 0;
  const fresh = (await storeForEmail(OWNER))!;
  // The first round of reads takes the time left: the second is not started.
  const late = await receiptBatch(fresh, ACCOUNT, range, {
    now: () => clock,
    readsUntil: RECEIPT_STRIPE_TIMEOUT_MS + 1,
    stopAt: 10 * RECEIPT_STRIPE_TIMEOUT_MS,
    afterRound: () => { clock += RECEIPT_STRIPE_TIMEOUT_MS; },
  });
  is("a file, with the first round's receipts and the rest named", late.ok && [late.included, late.skipped.length, late.skipped.every((s) => s.why === "slow")], [RECEIPT_BATCH_READS_AT_ONCE, RECEIPT_BATCH_READS_AT_ONCE, true]);
  clock = 0;
  const stopped = await receiptBatch(fresh, ACCOUNT, range, { now: () => clock, readsUntil: 10 * RECEIPT_STRIPE_TIMEOUT_MS, stopAt: 1, afterRound: () => { clock += 2; } });
  is("past the hard stop while numbering or drawing: no file at all", [stopped.ok, !stopped.ok && stopped.status], [false, 503]);
  is("handles read as the store's own", saleHandles(fresh).has(HANDLE), true);

  part("Reached from the list of sales");
  const page = readFileSync("app/studio/page.tsx", "utf8");
  is("a form that goes to this route, for this store", page.includes('action="/api/store/receipt-batch"'), true);
  is("each date has its label, and the cap is said before asking", [page.includes('htmlFor="receipt-batch-from"'), page.includes('htmlFor="receipt-batch-to"'), page.includes("{RECEIPT_BATCH_MAX} receipts")], [true, true, true]);
  done();
}
void main();
