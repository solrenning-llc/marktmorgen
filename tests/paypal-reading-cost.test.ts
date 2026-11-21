/**
 * A reading of PayPal asked for by a view of the studio's affiliates page or a press of "Check with PayPal"
 * (lib/paypal-payouts.ts, settlePayPal; C5-20261121-1459-PAYPAL-READING) is a new token from the creator's PayPal app
 * and up to ten pages of every open batch, each waited on for up to 20 s, and the writes back. The press took one
 * studio request (the route's default) and the view the page's four, each priced as a light studio request, while the
 * reading held its function for up to the route's 60 s, and the page's for the platform's longer default: on the
 * Store's 2,000 studio requests, $6.93 a year or more that no line priced.
 *
 * What is held, with a Redis stand-in, a PayPal stand-in and a clock that moves 20 s with each PayPal call:
 *   - a reading takes paypalReadingUnits studio requests before PayPal is asked, worth at least its cost at the
 *     registry's own figures, at every size; its commands and bytes are inside what the units count;
 *   - with no room, nothing is asked of PayPal, the mark is let go and the press is told it could not check;
 *   - a reading starts no PayPal call that could not end inside PAYPAL_READING_MS: the batches it does not reach stay
 *     on their way, and the page sets maxDuration = 60, as the route does;
 *   - a batch whose answer is not known is sent again only by the daily job, which takes no studio request.
 *
 * Synthetic data only.
 */
import { readFileSync } from "node:fs";
import * as pp from "@/lib/paypal-payouts";
import { connectPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { takeAllowance } from "@/lib/store-allowance";
import type { Store } from "@/lib/store";
import * as registry from "./plan-cost-registry";
import { UNIT_COST } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { markLive } from "./live-store";
import { done, is, part } from "./check";

const STATS = "statsreading1";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const OPEN = `nl:pp:open:${STATS}`;

/** The clock: each PayPal call takes 20 s when `slow`, the most one may wait (lib/paypal-payouts.ts, TIMEOUT_MS). */
const realNow = Date.now.bind(Date);
let shift = 0;
let slow = false;
Date.now = () => realNow() + shift;

let tokens = 0;
let reads = 0;
let posts = 0;
/** Each batch's lines and what PayPal says of them. */
const status = new Map<string, string>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code });
  if (url.hostname === "api.stripe.com") return json({ object: "list", data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (slow) shift += 20_000;
  if (url.pathname === "/v1/oauth2/token") {
    tokens += 1;
    return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts", expires_in: 32400 });
  }
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    posts += 1;
    return json({ name: "VALIDATION_ERROR" }, 400);
  }
  const batch = /^\/v1\/payments\/payouts\/(BATCH\w+)$/.exec(url.pathname)?.[1];
  if (batch) {
    reads += 1;
    const mine = [...status.entries()].filter(([k]) => k.startsWith(`${batch}:`));
    return json({
      batch_header: { payout_batch_id: batch, batch_status: "PENDING" },
      total_pages: 1,
      items: mine.map(([k, s], i) => ({ payout_item_id: `ITEM${batch}${i}`, payout_batch_id: batch, transaction_status: s, payout_item: { sender_item_id: k.split(":")[1] } })),
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

/** Every command sent and every byte through the stand-in while `counting`; a script is billed as six. */
const pipeline = redis.pipeline.bind(redis);
let counting = false;
let commands = 0;
let bytes = 0;
redis.pipeline = (async (batch: (string | number)[][]) => {
  const answers = await pipeline(batch);
  if (counting) {
    for (const c of batch) commands += String(c[0]).toUpperCase() === "EVAL" ? 6 : 1;
    bytes += Buffer.byteLength(JSON.stringify(batch)) + Buffer.byteLength(JSON.stringify(answers ?? null));
  }
  return answers;
}) as typeof redis.pipeline;

function shop(): Store {
  return {
    sid: "sidreading01", handle: "readingpaypal", name: "Reading Kitchen", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestReading01", currency: "usd", catalog: { items: [] },
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

/** The store's studio requests left this window, read by taking one (and that one is then counted too). */
async function left(store: Store): Promise<number> {
  const taken = await takeAllowance(store, "studio", 1);
  if (!taken.ok || typeof taken.left !== "number") throw new Error(`the studio figure could not be read: ${JSON.stringify(taken)}`);
  return taken.left;
}

/** `batches` open batches of `lines` lines each, PayPal saying `say` of every line. */
async function openBatches(batches: number, lines: number, say: string): Promise<void> {
  status.clear();
  await pipeline([["DEL", OPEN, `nl:pp:pace:${STATS}`, `nl:pp:press:${STATS}`]]);
  for (let b = 0; b < batches; b += 1) {
    const id = `BATCH${b}READ`;
    const rows = Array.from({ length: lines }, (_, l) => ({ a: `aff${String(b).padStart(3, "0")}${String(l).padStart(5, "0")}`, c: 1_000 }));
    for (const row of rows) status.set(`${id}:${row.a}`, say);
    await pipeline([["HSET", OPEN, id, JSON.stringify({ at: realNow(), currency: "usd", lines: rows })]]);
  }
  await pipeline([["SADD", "nl:pp:stores", "sidreading01"]]);
}

const num = (name: string): number => Number((pp as Record<string, unknown>)[name]);
const unitsFor = (batches: number, lines: number): number => {
  const fn = (pp as Record<string, unknown>).paypalReadingUnits;
  return typeof fn === "function" ? (fn as (b: number, l: number) => number)(batches, lines) : 0;
};
const readingCost = (c: number, b: number): number => {
  const fn = (registry as Record<string, unknown>).paypalReadingCost;
  return typeof fn === "function" ? (fn as (c: number, b: number) => number)(c, b) : Number.POSITIVE_INFINITY;
};

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_reading_only";
  console.error = () => {};
  redis.clear();
  const store = shop();
  await markLive(store);
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("PayPal stand-in not connected");

  part("What a reading costs, and what it takes first");
  const base = num("PAYPAL_READING_BASE_UNITS");
  const per = num("PAYPAL_READING_UNIT_COMMANDS");
  const perBatch = num("PAYPAL_READING_BATCH_COMMANDS");
  const perLine = num("PAYPAL_READING_LINE_COMMANDS");
  is("whole numbers of studio requests and commands, each at least one", [base, per, perBatch, perLine].every((n) => Number.isSafeInteger(n) && n >= 1), true);
  // The bytes a reading moves: its open batches read (HGETALL) and written back, a line's JSON at the most 120 bytes
  // and its payout written once, and each batch's own fields; 4,000 bytes of its own besides.
  const bytesAt = (b: number, l: number) => 4_000 + b * 400 + b * l * 1_200;
  for (const [b, l] of [[0, 0], [1, 1], [5, 20], [51, 300], [200, 1_000]]) {
    const cost = readingCost(40 + b * perBatch + b * l * perLine, bytesAt(b, l));
    is(`${b} batches of ${l} lines: its studio requests are worth at least its cost`, unitsFor(b, b * l) * UNIT_COST.studio >= cost, true);
  }

  part("A press takes them before PayPal is asked, and its work is inside what they count");
  await openBatches(3, 4, "SUCCESS");
  const before = await left(store);
  tokens = 0;
  reads = 0;
  counting = true;
  commands = 0;
  bytes = 0;
  const press = await settlePayPal(store, { press: true });
  counting = false;
  const after = await left(store);
  is("PayPal was asked: one token and each batch read", [press.asked !== false, tokens, reads], [true, 1, 3]);
  is("its studio requests taken (besides the one each count takes)", before - after - 1, unitsFor(3, 12));
  is(`its commands (${commands}) inside the units' own and its base's forty`, commands <= 40 + 3 * perBatch + 12 * perLine, true);
  is(`its bytes (${bytes}) inside what its cost counts`, bytes <= bytesAt(3, 4), true);

  part("A view takes them only when it reads");
  await openBatches(1, 1, "PENDING");
  const v0 = await left(store);
  await settlePayPal(store, { paced: true });
  const v1 = await left(store);
  await settlePayPal(store, { paced: true });
  const v2 = await left(store);
  is("the view that read took them; the next, inside the pace, took none", [v0 - v1 - 1, v1 - v2 - 1], [unitsFor(1, 1), 0]);

  part("With no room, nothing is asked of PayPal");
  await openBatches(1, 1, "PENDING");
  const room = await left(store);
  if (room > 1) await takeAllowance(store, "studio", room - 1);
  tokens = 0;
  reads = 0;
  const refused = await settlePayPal(store, { press: true });
  is("no token, no page", [tokens, reads], [0, 0]);
  is("it says nothing could be checked, and may be tried again at once (its mark let go)", [refused.asked, refused.unavailable, refused.retryNow, refused.waiting], [false, true, true, 1]);
  const [mark] = await pipeline([["GET", `nl:pp:press:${STATS}`]]);
  is("no press mark left", mark, null);

  part("A reading ends its calls inside its time");
  redis.clear();
  await markLive(store);
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("PayPal stand-in not connected again");
  await openBatches(3, 2, "SUCCESS");
  tokens = 0;
  reads = 0;
  slow = true;
  const start = Date.now();
  const timed = await settlePayPal(store, { press: true });
  const spent = Date.now() - start;
  slow = false;
  is("the token and one page, no call it could not finish", [tokens, reads], [1, 1]);
  is(`inside PAYPAL_READING_MS (${spent} ms)`, Number.isSafeInteger(num("PAYPAL_READING_MS")) && spent <= num("PAYPAL_READING_MS"), true);
  is("one batch's lines paid, the two not reached still on their way", [timed.paid, timed.waiting], [2, 4]);
  is("the route and the page are each a 60 s function", [
    readFileSync("app/api/store/affiliates/paypal/route.ts", "utf8").includes("export const maxDuration = 60;"),
    readFileSync("app/studio/affiliates/page.tsx", "utf8").includes("export const maxDuration = 60;"),
  ], [true, true]);
  is("the reading's time leaves room for the writes inside 60 s", num("PAYPAL_READING_MS") + 20_000 <= 60_000, true);

  part("A batch whose answer is not known is sent again only by the daily job");
  await pipeline([["DEL", OPEN, `nl:pp:pace:${STATS}`, `nl:pp:press:${STATS}`]]);
  const unknown = "?nl-statsreading-unknown1";
  await pipeline([["HSET", OPEN, unknown, JSON.stringify({ at: realNow(), currency: "usd", lines: [{ a: "affunknown001", c: 1_000 }] })]]);
  const mOf = async () => (JSON.parse(String((await pipeline([["HGET", OPEN, unknown]]))[0])) as { m?: number; t?: number });
  posts = 0;
  await settlePayPal(store, { press: true });
  await pipeline([["DEL", `nl:pp:pace:${STATS}`]]);
  await settlePayPal(store, { paced: true });
  const untouched = await mOf();
  is("a press and a view leave it as it was: not tried, not marked", [posts, untouched.m ?? 0, untouched.t ?? 0], [0, 0, 0]);
  const d0 = await left(store);
  await settlePayPal(store);
  const d1 = await left(store);
  const settled = await mOf();
  is("the daily job takes it up (here, left for the creator's own check: it kept no app)", settled.m, 1);
  is("and takes no studio request", d0 - d1 - 1, 0);
  done();
}

main().catch((error) => {
  console.log(`not ok - ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
