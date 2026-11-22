/**
 * The daily job sends a batch whose answer is not known again (lib/paypal-payouts.ts, settleUnknown) at most once a
 * day, for up to seven days, and before each try it reads the store's whole affiliate book (readBook) to check every
 * line is still owed. That book read is the store's work, as large as its programme, and nothing counted it: the
 * press's units (paypalPressUnits) pay for the press's own book read, and the kept invoices' four studio requests pay
 * only for the invoices (unit #96, C5-20261121-1459-PAYPAL-READING, "still open").
 *
 * What is held, with a Redis stand-in and a PayPal stand-in:
 *   - before it reads the book, a try takes unknownRetryUnits(bookSizes) studio requests, worth at least the book read
 *     (bookWork at the programme's size) and its own commands at the registry's figures, at every size;
 *   - a try's own commands, measured, are inside what the base counts;
 *   - with no room, or a programme that cannot be counted, it sends nothing and counts no try: the entry waits, and
 *     after seven days goes to the creator's own check, as before;
 *   - controls: with room, the same request is sent again from the same app and the batch is then held under its id.
 *
 * Synthetic data only.
 */
import * as pp from "@/lib/paypal-payouts";
import { connectPayPal, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { BOOK_STRIPE_PAGES, bookSizes } from "@/lib/affiliates";
import { KEPT_INVOICES_STUDIO_UNITS, bookWork } from "@/lib/api-read-rules";
import { takeAllowance } from "@/lib/store-allowance";
import type { Store } from "@/lib/store";
import { COMMAND, UNIT_COST } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { markLive } from "./live-store";
import { done, is, part } from "./check";

const STATS = "statsretry01";
const OPEN = `nl:pp:open:${STATS}`;
const CLIENT = "AAAAAAAAAAAAAAAAAAAAclientA0123456789";
const SECRET = "secretAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SCOPE = "https://uri.paypal.com/payments/payouts openid";

/** "drop": PayPal makes the batch and the answer is lost; "make": it makes it and answers. */
let mode: "drop" | "make" = "make";
let posts = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ object: "list", data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "tokenA", token_type: "Bearer", scope: SCOPE, expires_in: 32400 });
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    posts += 1;
    if (mode === "drop") throw new TypeError("fetch failed: the answer was lost");
    return json({ batch_header: { payout_batch_id: `BATCH${posts}RTY`, batch_status: "PENDING" } }, 201);
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

/** Every command sent to the stand-in while `counting`; a script is billed as six. */
const pipeline = redis.pipeline.bind(redis);
let counting = false;
let commands = 0;
redis.pipeline = (async (batch: (string | number)[][]) => {
  if (counting) for (const c of batch) commands += String(c[0]).toUpperCase() === "EVAL" ? 6 : 1;
  return pipeline(batch);
}) as typeof redis.pipeline;

function shop(): Store {
  return {
    sid: "sidretry01", handle: "retrykitchen", name: "Retry Kitchen", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestRetry00001", currency: "usd", catalog: { items: [] },
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

/** The store's studio requests left this window, read by taking one (and that one is then counted too). */
async function left(store: Store): Promise<number> {
  const taken = await takeAllowance(store, "studio", 1);
  if (!taken.ok || typeof taken.left !== "number") throw new Error(`the studio figure could not be read: ${JSON.stringify(taken)}`);
  return taken.left;
}

/** One affiliate owed, a batch sent whose answer was lost: one "?" entry, kept with the app it was sent from. */
async function unknownBatch(store: Store): Promise<void> {
  redis.clear();
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = JSON.stringify({ id: "aaaaaaaaaaaa", email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = JSON.stringify({ ref: "cs_1", pi: "pi_cs_1", aff: "aaaaaaaaaaaa", at, product: "p1", title: "Guide", base: 10000, total: 10000, currency: "usd", rate: 30, self: false });
  await pipeline([["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person], ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale]]);
  await markLive(store);
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("PayPal stand-in not connected");
  mode = "drop";
  await payWithPayPal(store);
  mode = "make";
  posts = 0;
}

async function unknownEntry(): Promise<Record<string, unknown> | null> {
  const [raw] = await pipeline([["HGETALL", OPEN]]);
  const flat = raw as string[];
  for (let i = 0; i < flat.length; i += 2) if (flat[i].startsWith("?")) return JSON.parse(flat[i + 1]) as Record<string, unknown>;
  return null;
}

const num = (name: string): number => Number((pp as Record<string, unknown>)[name]);
const unitsFor = (sizes: Parameters<typeof bookWork>[0]): number => {
  const fn = (pp as Record<string, unknown>).unknownRetryUnits;
  return typeof fn === "function" ? (fn as (s: typeof sizes) => number)(sizes) : 0;
};

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_unknown_retry_only";
  console.error = () => {};
  const store = shop();

  part("What a try costs, and what it takes first");
  const base = num("UNKNOWN_RETRY_BASE_UNITS");
  const per = num("UNKNOWN_RETRY_UNIT_COMMANDS");
  is("whole numbers of studio requests and commands, each at least one", [base, per].every((n) => Number.isSafeInteger(n) && n >= 1), true);
  const own = 80;
  for (const [people, entries, leads, refunds, products] of [[0, 0, 0, 0, 0], [1, 1, 0, 0, 1], [200, 2_000, 500, 500, 50], [5_000, 50_000, 5_000, 5_000, 200]]) {
    const sizes = { kept: true, entries, people, leads, paypalRefunds: refunds, stripe: true, products };
    const book = bookWork(sizes, BOOK_STRIPE_PAGES).commands;
    is(`${people} affiliates and ${entries} entries: its studio requests are worth at least its book read and its own ${own} commands`, unitsFor(sizes) * UNIT_COST.studio >= (book + own) * COMMAND, true);
  }

  part("A try takes them before it reads the book, and its own commands are inside the base's");
  await unknownBatch(store);
  const sizes = await bookSizes(store);
  if (!sizes) throw new Error("the programme could not be counted");
  const before = await left(store);
  counting = true;
  commands = 0;
  await settlePayPal(store);
  counting = false;
  const after = await left(store);
  is("its studio requests taken, besides the kept invoices' and the one each count takes", before - after - 1 - KEPT_INVOICES_STUDIO_UNITS, unitsFor(sizes));
  const book = bookWork(sizes, BOOK_STRIPE_PAGES).commands;
  is(`the run's commands (${commands}) inside its book read (${book}) and the ${own} its base counts`, commands <= book + own, true);
  is("control: the same request sent again, and the batch held under its id", [posts, await unknownEntry()], [1, null]);

  part("With no room, nothing is sent and no try is counted");
  await unknownBatch(store);
  const room = await left(store);
  if (room > 1) await takeAllowance(store, "studio", room - 1);
  await settlePayPal(store);
  const waiting = await unknownEntry();
  is("no request sent", posts, 0);
  is("the entry still there, no try counted, not left for the creator's check", [waiting !== null, waiting?.t ?? 0, waiting?.m ?? 0], [true, 0, 0]);

  part("A programme that cannot be counted sends nothing either");
  await unknownBatch(store);
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: (string | number)[][]) => {
    if (batch.some((c) => String(c[0]).toUpperCase() === "HLEN" && String(c[1]).startsWith(`nl:aff:${STATS}:`))) throw new Error("synthetic: the programme's sizes are not read");
    return real(batch);
  }) as typeof redis.pipeline;
  await settlePayPal(store);
  redis.pipeline = real as typeof redis.pipeline;
  const unread = await unknownEntry();
  is("no request sent, the entry waits with no try counted", [posts, unread !== null, unread?.t ?? 0], [0, true, 0]);
  done();
}

main().catch((error) => {
  console.log(`not ok - ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
