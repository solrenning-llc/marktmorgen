/**
 * #5010 row 150 (route envelope sweep 2f36; coordinators 5d3c and ca62): the affiliate programme's spreadsheet
 * (app/api/store/affiliates/export) reads the whole book, whose rows nothing caps but the store's data room, and took
 * one essential request whatever its size. Now, while a plan runs, it takes the units of its work at the programme's
 * size from the studio figure before reading (lib/affiliate-book-export.ts, bookExportUnits); once the plan has ended,
 * ENDED_BOOK_EXPORTS of its own, priced in the closing. Checked here:
 *   - at every size, the units it takes cover what the work costs (bookExportCost of bookExportWork);
 *   - through the real route, it takes exactly those units, and what it really sends to Redis, reads, sends to the
 *     browser and asks Stripe stays within the work counted;
 *   - with the figure short, nothing of the book is read, and the answer says what it needs and what is left;
 *   - once the plan has ended, it takes nothing from the figure, ENDED_BOOK_EXPORTS times, then says so;
 *   - the closing carries those downloads (closureCost.books).
 * Synthetic: the in-memory Redis, a Stripe stand-in with empty lists, no email.
 */
import { NextRequest } from "next/server";
import { GET as exportRoute } from "@/app/api/store/affiliates/export/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { putMember } from "@/lib/team";
import { bookSizes } from "@/lib/affiliates";
import { BOOK_CSV_HEADER_BYTES, BOOK_RECORDS_MAX_BYTES, bookExportSettled, bookExportUnits, bookExportWork } from "@/lib/affiliate-book-export";
import { MAX_AFFILIATES } from "@/lib/affiliate-setting";
import { BOOK_PAYPAL_REFUNDS, type BookSizes } from "@/lib/api-read-rules";
import { ENDED_BOOK_EXPORTS } from "@/lib/plan-closing-rules";
import { allowanceUsed, giveAllowance, takeAllowance } from "@/lib/store-allowance";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { MAX_STORE_BYTES, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { TIERS } from "@/lib/plan";
import { DATA_ROOM_BYTES, ENTRY_BYTES } from "@/lib/store-data-rules";
import { UNIT_COST, bookExportCost, closureCost, endedBookExportCost } from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let stripePages = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.stripe.com") {
    stripePages += 1;
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
/** While counting: every command sent (a script billed with each redis.call written in it), and the bytes each way. */
let counting = false;
let commands = 0;
let bytes = 0;
/** While set, the book's records answer in a shape no reading accepts (a failed reading, #5256 audit). */
let breakBook = false;
redis.pipeline = (async (batch: Commands) => {
  if (breakBook && batch.some((c) => String(c[0]).toUpperCase() === "HGETALL" && /^nl:aff:[^:]+:sales$/.test(String(c[1])))) throw new Error("synthetic: the book does not read");
  const replies = await real(batch);
  if (counting) {
    for (const c of batch) {
      commands += 1;
      if (String(c[0]).toUpperCase() === "EVAL") commands += (String(c[1]).match(/redis\.call\(/g) ?? []).length;
    }
    bytes += JSON.stringify(batch).length + JSON.stringify(replies).length;
  }
  return replies;
}) as typeof redis.pipeline;

async function shop(owner: string, handle: string): Promise<{ store: Store; session: string }> {
  await claimHandle(owner, handle, `${handle} store`, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1${handle.padEnd(15, "x").slice(0, 15)}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  return { store: (await storeForEmail(owner))!, session: await openSession(owner) };
}

/** A programme of `people` affiliates, each with `sales` sales, at the longest note and title. */
async function seed(store: Store, people: number, sales: number): Promise<void> {
  const id = (i: number) => `a${String(i).padStart(11, "0")}`;
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const batch: Commands = [];
  for (let i = 0; i < people; i += 1) {
    batch.push(["HSET", `nl:aff:${store.statsId}:people`, id(i), JSON.stringify({ id: id(i), email: `p${i}@example.com`, code: `code${i}`, status: "approved", appliedAt: 1, decidedAt: 2, note: "n".repeat(200) })]);
    for (let n = 0; n < sales; n += 1) {
      batch.push(["HSET", `nl:aff:${store.statsId}:sales`, `cs_${i}_${n}`, JSON.stringify({ ref: `cs_${i}_${n}`, pi: `pi_${i}_${n}`, aff: id(i), at, product: "p1", title: "T".repeat(200), base: 10000, total: 10000, currency: "usd", rate: 30, self: false })]);
    }
  }
  await real(batch);
}

const get = (session: string) => exportRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates/export", { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_book_export_only";

  part("At every size, the units taken cover what the spreadsheet's work costs");
  const grid: BookSizes[] = [];
  for (const entries of [0, 10, 1_000, 100_000, 1_000_000, Math.floor(BOOK_RECORDS_MAX_BYTES / ENTRY_BYTES)]) {
    for (const stripe of [false, true]) {
      grid.push({ kept: true, entries, people: Math.min(MAX_AFFILIATES, entries), leads: Math.floor(entries / 4), paypalRefunds: Math.min(BOOK_PAYPAL_REFUNDS, entries), stripe, products: 1_000 });
    }
  }
  is("each size's units at the studio unit's price are at least its work's cost", grid.filter((s) => bookExportUnits(s) * UNIT_COST.studio < bookExportCost(bookExportWork(s))).map((s) => `${s.entries}/${s.stripe}`), []);

  part("A creator at the largest programme any room can hold can still download it within one month's studio figure");
  // Every entry the book reads is kept in the store's data room, each counted at ENTRY_BYTES at the least
  // (lib/store-data-rules.ts), so the largest room any plan has holds at most BOOK_RECORDS_MAX_BYTES / ENTRY_BYTES.
  const most = Math.floor(BOOK_RECORDS_MAX_BYTES / ENTRY_BYTES);
  const largest: BookSizes = { kept: true, entries: most, people: MAX_AFFILIATES, leads: most, paypalRefunds: BOOK_PAYPAL_REFUNDS, stripe: true, products: 1_000 };
  for (const tier of TIERS) {
    const held = bookExportUnits(largest);
    is(`${tier}: the largest programme (${most} entries) holds ${held} of the plan's ${STORE_ALLOWANCES[tier].studio} studio requests`, held > 0 && held <= STORE_ALLOWANCES[tier].studio, true);
  }

  part("Through the real route, a programme of 30 affiliates with 4 sales each");
  const { store, session } = await shop("book-export-owner@example.com", "bookexport");
  await seed(store, 30, 4);
  const sizes = (await bookSizes(store))!;
  const work = bookExportWork(sizes);
  const units = bookExportUnits(sizes);
  const reading = bookExportSettled(sizes, 0);
  const before = await allowanceUsed(store, "studio");
  counting = true;
  commands = 0;
  bytes = 0;
  stripePages = 0;
  const response = await get(session);
  const csv = await response.text();
  counting = false;
  is("the spreadsheet is sent", [response.status, (response.headers.get("content-type") ?? "").startsWith("text/csv"), csv.split("\n").length > 120], [200, true, true]);
  const kept = bookExportSettled(sizes, Buffer.byteLength(csv, "utf8"));
  is(`it holds ${reading} studio units for its reading first, and takes ${kept} in all once the file (${Buffer.byteLength(csv, "utf8")} bytes) is made, never more than its bound (${units})`, [(await allowanceUsed(store, "studio")) - before, reading <= kept, kept <= units, kept > 1], [kept, true, true, true]);
  is("what it keeps still covers its work with the file as sent", kept * UNIT_COST.studio >= bookExportCost({ ...work, sent: Buffer.byteLength(csv, "utf8") }), true);
  is(`what it sends to Redis (${commands}) is within the work counted (${work.commands}) and the take's own`, commands <= work.commands + 8, true);
  is(`what moves to and from Redis (${bytes}) is within the bytes counted (${work.bytes})`, bytes <= work.bytes, true);
  is(`the file (${csv.length} bytes) is within what it may send (${work.sent})`, csv.length <= work.sent && work.sent >= BOOK_CSV_HEADER_BYTES, true);
  is(`the Stripe pages it asks (${stripePages}) are within those counted (${work.stripePages})`, stripePages <= work.stripePages, true);

  part("A reading that fails keeps only what its reading took: two clicks on a book that does not read never empty the month (#5256 audit 7bab 1, 3c4a)");
  {
    const failedBefore = await allowanceUsed(store, "studio");
    breakBook = true;
    const one = await get(session);
    const two = await get(session);
    breakBook = false;
    is("both answered as failures, no file", [one.status, two.status], [500, 500]);
    is(`each kept only its reading's units (${reading}), never the whole bound (${units})`, (await allowanceUsed(store, "studio")) - failedBefore, 2 * reading);
  }

  part("With the figure short of its reading, nothing of the book is read, and the answer says what it needs");
  const used = await allowanceUsed(store, "studio");
  if (!(await takeAllowance(store, "studio", STORE_ALLOWANCES.creator.studio - used - reading + 1)).ok) throw new Error("setup: the figure could not be filled");
  counting = true;
  commands = 0;
  const short = await get(session);
  counting = false;
  const words = await short.text();
  is("refused, saying how many it needs and how many are left", [short.status, words.startsWith(`This download needs ${reading.toLocaleString("en-US")} of your`), / left\./.test(words)], [429, true, true]);
  is("no record of the book was read", commands < 20, true);
  // With exactly its reading's units left it goes through, though less than the whole bound is left (7bab 7).
  await giveAllowance(store, "studio", 1);
  is("with exactly its reading's units left, it goes through", (await get(session)).status, 200);

  part("Once the plan has ended: the owner's own downloads, never the figure; failures and a teammate spend none");
  const ENDED_OWNER = "book-export-ended@example.com";
  const { store: ended, session: endedSession } = await shop(ENDED_OWNER, "bookexportended");
  await seed(ended, 3, 1);
  const admin = "book-export-admin@example.com";
  if (!(await putMember(ended, admin, "admin"))) throw new Error("setup: admin");
  await setSubscription(ENDED_OWNER, { customerId: "cus_bookexportended", subscriptionId: "sub_bookexportended", active: false, tier: "creator", period: paidPeriod() });
  const endedStore = (await storeForEmail(ENDED_OWNER))!;
  const endedBefore = await allowanceUsed(endedStore, "studio");
  const adminSession = await openSession(admin);
  is("a teammate with export is refused, before anything is counted", (await get(adminSession)).status, 403);
  breakBook = true;
  const failures = [(await get(endedSession)).status, (await get(endedSession)).status];
  breakBook = false;
  is("two failed readings in a row", failures, [500, 500]);
  const answers: number[] = [];
  for (let i = 0; i <= ENDED_BOOK_EXPORTS; i += 1) answers.push((await get(endedSession)).status);
  is(`still ${ENDED_BOOK_EXPORTS} downloads for the owner after them, then refused`, answers, [...Array.from({ length: ENDED_BOOK_EXPORTS }, () => 200), 429]);
  is("nothing taken from the ended store's figure", (await allowanceUsed(endedStore, "studio")) - endedBefore, 0);
  is("the refusal says so", (await (await get(endedSession)).text()).includes("since your plan ended"), true);

  part("The closing carries those downloads, at the largest programme its room can hold");
  for (const tier of TIERS) {
    const c = closureCost(tier);
    is(`${tier}: ${ENDED_BOOK_EXPORTS} spreadsheets priced in the closing`, c.books, ENDED_BOOK_EXPORTS * endedBookExportCost(DATA_ROOM_BYTES[tier] + MAX_STORE_BYTES));
    is(`${tier}: and counted in its total`, c.total >= c.books && c.books > 0, true);
    // The largest programme that tier's room holds, its work at the most, is within what the closing prices.
    const entries = Math.floor((DATA_ROOM_BYTES[tier] + MAX_STORE_BYTES) / ENTRY_BYTES);
    const work = bookExportWork({ kept: true, entries, people: MAX_AFFILIATES, leads: entries, paypalRefunds: BOOK_PAYPAL_REFUNDS, stripe: true, products: 1_000 });
    const priced = endedBookExportCost(DATA_ROOM_BYTES[tier] + MAX_STORE_BYTES);
    is(`${tier}: one priced spreadsheet (${priced.toFixed(4)} USD) covers the largest programme's work (${bookExportCost(work).toFixed(4)} USD)`, priced >= bookExportCost(work), true);
  }

  done();
}

void main().catch((error) => {
  console.log(error);
  process.exit(1);
});
