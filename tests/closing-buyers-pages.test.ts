/**
 * A closing store's buyers, found by Stripe's search of payments that name the
 * store, are read page by page (lib/closing-buyers.ts, tellBuyers). Rule 30,
 * the same class Claude 6 found in lib/closing-holds.ts (eachSold) on #3108:
 * a page that does not say exactly whether more follow was read as the last
 * one. has_more missing or not a boolean, has_more true with no cursor to the
 * next page, or data that is not a list: the rest of that handle's payments
 * were skipped, the round ended as done, and those buyers were never told the
 * store closes.
 *
 * Now a page out of shape acts on none of its rows and the round is not done:
 * the cursor stays where it was, the closing job tries again, and only a page
 * Stripe says is the last one finishes. The controls: a healthy list of two
 * pages tells every buyer exactly once, and a verified last page finishes.
 *
 * Stripe and the email sender are stand-ins (fetch below); Redis is the
 * in-memory one. Nothing real is reached.
 */
import { creditKey, startClosingCredit } from "@/lib/closing-credit";
import { EMAILS_PER_BUYER_PER_ENDING } from "@/lib/closing-buyers-rules";
import { tellBuyers, type Told } from "@/lib/closing-buyers";
import { claimHandle, storeFolder, storeForEmail, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** The search's pages for each handle, by the page cursor asked for ("" the first). */
const pages = new Map<string, Map<string, unknown>>();
let searches = 0;
const sent: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") {
    type One = { to: string | string[] };
    const body = JSON.parse(String(init?.body)) as One | One[];
    const all = Array.isArray(body) ? body : [body];
    for (const m of all) sent.push([m.to].flat()[0]);
    return json(Array.isArray(body) ? { data: all.map((_, i) => ({ id: `email_${sent.length}_${i}` })) } : { id: `email_${sent.length}` });
  }
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  if (url.pathname === "/v1/payment_intents/search" && (init?.method ?? "GET") === "GET") {
    searches += 1;
    const handle = (url.searchParams.get("query") ?? "").match(/metadata\['store'\]:'([^']+)'/)?.[1] ?? "";
    const page = pages.get(handle)?.get(url.searchParams.get("page") ?? "");
    if (page === undefined) return json({ error: { message: "no such page" } }, 400);
    return json(page);
  }
  return json({ error: { message: "not stubbed" } }, 404);
}) as typeof fetch;

const payment = (n: string, email: string) => ({ id: `pi_${n}`, object: "payment_intent", status: "succeeded", receipt_email: email, metadata: {}, latest_charge: null });
const list = (rows: unknown[], hasMore: boolean, next: string | null) => ({ object: "search_result", data: rows, has_more: hasMore, next_page: next });

const E = Date.UTC(2026, 10, 1);
const DAY = E + 30 * 86_400_000;
const START = 100;

let made = 0;
/** A closing store connected to its own Stripe account, its credit set, nobody kept here (only payments to find). */
async function closingStore(handle: string): Promise<{ store: Store; folder: string }> {
  made += 1;
  const owner = `${handle}@example.com`;
  await claimHandle(owner, handle, `Pages ${made}`, "");
  const shop = await storeForEmail(owner);
  if (!shop) throw new Error("the test store was not made");
  const store: Store = { ...shop, stripeAccountId: `acct_1Pages${String(made).padStart(10, "0")}` };
  const folder = await storeFolder(storeRef(store));
  await startClosingCredit(folder, START);
  return { store, folder };
}

const creditOf = async (folder: string) => Number((await redis.pipeline([["GET", creditKey(folder)]]))[0]);
const countOf = (email: string) => sent.filter((to) => to === email).length;
const run = async (store: Store, after: string, pagesRead = 0): Promise<Told | "rejected"> => {
  try {
    return await tellBuyers(store, E, DAY, after, Date.now() + 60_000, pagesRead);
  } catch {
    return "rejected";
  }
};
const shapeOf = (told: Told | "rejected") => (told === "rejected" ? told : { done: told.done, after: told.after, pages: told.pages });

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.COMPANY_POSTAL_ADDRESS = "1 Test Street, Testville, DE 19901, USA";
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const realError = console.error;
  console.error = () => {};

  // ------------------------------------------------------------ controls
  part("A healthy list of two pages: every buyer is told exactly once, and the round is done");
  {
    const { store, folder } = await closingStore("pageshealthy");
    pages.set("pageshealthy", new Map<string, unknown>([
      ["", list([payment("h1", "ann@buyers.example.com"), payment("h2", "ben@buyers.example.com")], true, "p2")],
      ["p2", list([payment("h3", "cat@buyers.example.com")], false, null)],
    ]));
    const from = searches;
    const told = await run(store, "");
    is("done after the page Stripe says is the last, cursor past the handle", shapeOf(told), { done: true, after: "1|", pages: 2 });
    is("two pages read", searches - from, 2);
    is("each buyer told exactly once", ["ann", "ben", "cat"].map((n) => countOf(`${n}@buyers.example.com`)), [1, 1, 1]);
    is("each buyer's credit taken once", await creditOf(folder), START - 3 * EMAILS_PER_BUYER_PER_ENDING);
    const again = await run(store, told === "rejected" ? "" : told.after, told === "rejected" ? 0 : told.pages);
    is("a run after it is done reads nothing more and tells nobody twice", [shapeOf(again), searches - from, ["ann", "ben", "cat"].map((n) => countOf(`${n}@buyers.example.com`))], [{ done: true, after: "1|", pages: 2 }, 2, [1, 1, 1]]);
  }

  part("A verified last page finishes: has_more false, with or without a cursor");
  for (const [label, next] of [["no cursor (null)", null], ["a cursor beside has_more false", "pstale"]] as const) {
    const handle = next === null ? "pageslastnull" : "pageslaststale";
    const { store } = await closingStore(handle);
    pages.set(handle, new Map<string, unknown>([["", list([payment(`${handle}1`, `${handle}@buyers.example.com`)], false, next)]]));
    const told = await run(store, "");
    is(`${label}: done`, shapeOf(told), { done: true, after: "1|", pages: 1 });
    is(`${label}: its buyer told once`, countOf(`${handle}@buyers.example.com`), 1);
  }

  // ------------------------------------------------- pages out of shape
  // Page 1 is healthy and says more follow; page 2 is out of shape; page 3 is the last.
  const OFF: [string, (rows: unknown[]) => unknown][] = [
    ["has_more missing", (rows) => ({ object: "search_result", data: rows, next_page: "p3" })],
    ["has_more as text \"true\"", (rows) => ({ object: "search_result", data: rows, has_more: "true", next_page: "p3" })],
    ["has_more as the number 1", (rows) => ({ object: "search_result", data: rows, has_more: 1, next_page: "p3" })],
    ["has_more null", (rows) => ({ object: "search_result", data: rows, has_more: null, next_page: "p3" })],
    ["has_more true with no next cursor (null)", (rows) => ({ object: "search_result", data: rows, has_more: true, next_page: null })],
    ["has_more true with an empty cursor", (rows) => ({ object: "search_result", data: rows, has_more: true, next_page: "" })],
    ["has_more true with a cursor that is not text", (rows) => ({ object: "search_result", data: rows, has_more: true, next_page: 3 })],
    ["data that is an object, not a list", (rows) => ({ object: "search_result", data: { ...rows }, has_more: true, next_page: "p3" })],
    ["data missing, saying it is the last", () => ({ object: "search_result", has_more: false, next_page: null })],
    ["data as text", () => ({ object: "search_result", data: "pi_x", has_more: false, next_page: null })],
  ];
  let n = 0;
  for (const [label, offShape] of OFF) {
    n += 1;
    const handle = `pagesoff${String.fromCharCode(96 + n)}`;
    part(`A page out of shape (${label}): no row acted on, the round is not done, the cursor stays`);
    const { store, folder } = await closingStore(handle);
    const ann = `${handle}ann@buyers.example.com`;
    const ben = `${handle}ben@buyers.example.com`;
    const cat = `${handle}cat@buyers.example.com`;
    const second = [payment(`${handle}2`, ben)];
    const book = new Map<string, unknown>([
      ["", list([payment(`${handle}1`, ann)], true, "p2")],
      ["p2", offShape(second)],
      ["p3", list([payment(`${handle}3`, cat)], false, null)],
    ]);
    pages.set(handle, book);
    const told = await run(store, "");
    is(`${label}: not done, the cursor where it was before the page, the page counted as read`, shapeOf(told), { done: false, after: "0|p2", pages: 2 });
    is(`${label}: only the healthy page's buyer is told; none on the page out of shape, none after it`, [countOf(ann), countOf(ben), countOf(cat)], [1, 0, 0]);
    is(`${label}: only the healthy page's credit is taken`, await creditOf(folder), START - EMAILS_PER_BUYER_PER_ENDING);

    // Stripe answers the same page in its shape on the next run: the job goes on from the cursor and finishes.
    book.set("p2", list(second, true, "p3"));
    const retried = await run(store, told === "rejected" ? "" : told.after, told === "rejected" ? 0 : told.pages);
    is(`${label}: the retry from the cursor finishes after the verified last page`, shapeOf(retried), { done: true, after: "1|", pages: 4 });
    is(`${label}: in all, every buyer told exactly once`, [countOf(ann), countOf(ben), countOf(cat)], [1, 1, 1]);
    is(`${label}: in all, each buyer's credit taken once`, await creditOf(folder), START - 3 * EMAILS_PER_BUYER_PER_ENDING);
  }

  console.error = realError;
  done();
}

void main();
