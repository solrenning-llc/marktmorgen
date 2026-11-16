/**
 * What one press of "Pay with PayPal" (lib/paypal-payouts.ts, payWithPayPal) sends to Redis, held against the line
 * that pays for it (Claude 7 on #4488 @ddbc2cec8b, MÉDIO). A press is taken as one integration unit
 * (app/api/store/affiliates/paypal/route.ts, withinServiceWhy "paypal-pay"), priced at ten commands, and payday's
 * auto-pay (lib/affiliate-payday.ts) takes none; a press really sends the link read, the lock taken (up to its tries),
 * the whole book, who is on their way twice, the token's link, the lock held again (EVAL), the batch written down, its
 * settling and the lock let go (EVAL): 18 or more commands with two affiliates. Here each is counted, through the
 * Redis stand-in, on the paths that send the most, and held under PAYPAL_PRESS_COMMANDS (the press's own) and
 * PAYPAL_PRESS_BOOK_COMMANDS (its book read at the caps), which price PAYPAL_PRESS in the integrations line.
 * Synthetic: stand-ins for PayPal, Stripe and Redis.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectPayPal, payWithPayPal } from "@/lib/paypal-payouts";
import { bookSizes, readBook, BOOK_STRIPE_PAGES } from "@/lib/affiliates";
import { bookWork } from "@/lib/api-read-rules";
import { STORE_ALLOWANCES, NON_PAYING_ALLOWANCES } from "@/lib/store-allowance-rules";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import {
  COST_LINES, PAYPAL_PRESS, PAYPAL_PRESS_BOOK_COMMANDS, PAYPAL_PRESS_COMMANDS, PAYPAL_PRESS_LOCK_TRIES, PAYPAL_PRESS_SECONDS,
  PAYPAL_PRESSES_UNTAKEN, TAKE_COMMANDS, UNIT_COST, figureCost, nonPayingWorst, paypalPressExcess, request, lockTriesAtMost,
} from "./plan-cost-registry";

const STATS = "statspress1";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
let payoutStatus = 201;
const created: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ object: "list", data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts", expires_in: 32400 });
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    created.push(body);
    if (payoutStatus >= 500) return json({ name: "INTERNAL_SERVICE_ERROR" }, payoutStatus);
    return json({ batch_header: { payout_batch_id: `BATCH${created.length}ABC`, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } }, 201);
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidpress0001",
    handle: "pressharbor",
    name: "Press Harbor",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    stripeAccountId: "acct_1TestPress00001",
    currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

const pipeline = redis.pipeline.bind(redis);
/** Every command sent to the stand-in while `counting`, by name. */
let counting = false;
let sent: string[] = [];
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (counting) for (const c of commands) sent.push(String(c[0]).toUpperCase());
  return pipeline(commands);
}) as typeof redis.pipeline;

/** A program of `people` affiliates, each with two sales, and `open` batches already on their way for others. */
async function seed(store: Store, people: number, open: number): Promise<void> {
  redis.clear();
  created.length = 0;
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const id = (i: number) => `a${String(i).padStart(11, "0")}`;
  const commands: (string | number)[][] = [];
  for (let i = 0; i < people; i += 1) {
    commands.push(["HSET", `nl:aff:${STATS}:people`, id(i), JSON.stringify({ id: id(i), email: `p${i}@example.com`, code: `code${i}`, status: "approved", appliedAt: 1, decidedAt: 2, note: "" })]);
    for (const n of [1, 2]) {
      commands.push(["HSET", `nl:aff:${STATS}:sales`, `cs_${i}_${n}`, JSON.stringify({ ref: `cs_${i}_${n}`, pi: `pi_${i}_${n}`, aff: id(i), at, product: "p1", title: "Guide", base: 10000, total: 10000, currency: "usd", rate: 30, self: false })]);
    }
  }
  // Batches already on their way, for affiliates past the seeded ones: read whole by every onTheirWay.
  for (let b = 0; b < open; b += 1) {
    commands.push(["HSET", `nl:pp:open:${STATS}`, `OPEN${b}BATCHX`, JSON.stringify({ at: Date.now(), currency: "usd", lines: [{ a: `z${String(b).padStart(11, "0")}`, c: 100 }] })]);
  }
  await pipeline(commands);
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("synthetic PayPal app not kept");
}

/** The commands one press sends, and those its book read sends alone at the same size. */
async function press(store: Store): Promise<{ press: string[]; book: string[]; result: Awaited<ReturnType<typeof payWithPayPal>> }> {
  counting = true;
  sent = [];
  await readBook(store);
  const book = sent;
  sent = [];
  const result = await payWithPayPal(store);
  const all = sent;
  counting = false;
  return { press: all, book, result };
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_press_cost_only";
  const store = shop();

  part("The press's commands, on the path that sends a batch, are inside the priced constants");
  for (const [people, open] of [[2, 0], [40, 3], [300, 25]] as const) {
    await seed(store, people, open);
    const sizes = await bookSizes(store);
    assert.ok(sizes, "the program could be counted");
    payoutStatus = 201;
    const { press: all, book, result } = await press(store);
    is(`${people} affiliates: sent`, result.ok, true);
    const own = all.length - book.length;
    is(`${people} affiliates: the press's own commands (${own}) are within PAYPAL_PRESS_COMMANDS (${PAYPAL_PRESS_COMMANDS})`, own <= PAYPAL_PRESS_COMMANDS, true);
    is(`${people} affiliates: its book read (${book.length}) is within what bookWork counts at its size`, book.length <= bookWork(sizes!, BOOK_STRIPE_PAGES).commands, true);
    is(`${people} affiliates: and within PAYPAL_PRESS_BOOK_COMMANDS (${PAYPAL_PRESS_BOOK_COMMANDS})`, book.length <= PAYPAL_PRESS_BOOK_COMMANDS, true);
    // The lock: taken, held again once before the batch is written down, let go. One hold: a second one in a row
    // with nothing awaited between them would be a command that buys nothing.
    is(`${people} affiliates: one EVAL to hold the lock again and one to let it go`, all.filter((c) => c === "EVAL").length - book.filter((c) => c === "EVAL").length, 2);
  }

  part("The path whose answer is not known writes its counts: inside the same constant");
  await seed(store, 40, 3);
  payoutStatus = 500;
  {
    const { press: all, book, result } = await press(store);
    is("unknown", result.ok ? "sent" : result.reason, "unknown");
    is(`its own commands (${all.length - book.length}) are within PAYPAL_PRESS_COMMANDS`, all.length - book.length <= PAYPAL_PRESS_COMMANDS, true);
  }
  payoutStatus = 201;

  part("A press that waits on the lock tries it at most PAYPAL_PRESS_LOCK_TRIES times");
  await seed(store, 2, 0);
  await pipeline([["SET", `nl:pp:${STATS}:lock`, "another-press", "EX", 120]]);
  counting = true;
  sent = [];
  const busy = await payWithPayPal(store);
  counting = false;
  is("busy", busy.ok ? "sent" : busy.reason, "busy");
  const tries = sent.filter((c) => c === "SET").length;
  is(`the lock was tried ${tries} times, at most ${PAYPAL_PRESS_LOCK_TRIES}`, tries >= 2 && tries <= PAYPAL_PRESS_LOCK_TRIES, true);
  is("nothing sent while it waited", created.length, 0);

  part("The constants follow the code they count");
  const lockSource = readFileSync(join(process.cwd(), "lib/redis-lock.ts"), "utf8");
  const paySource = readFileSync(join(process.cwd(), "lib/paypal-payouts.ts"), "utf8");
  is("the lock's waits are still 20 ms doubled up to 250 ms", lockSource.includes("for (let wait = 20; ; wait = Math.min(wait * 2, 250))"), true);
  is("the press still waits 5 s for its lock", paySource.includes("withLock(`nl:pp:${statsId}:lock`, 120, 5_000, async (lock): Promise<PayResult>"), true);
  is("the tries counted from that schedule", PAYPAL_PRESS_LOCK_TRIES, lockTriesAtMost(5_000));
  is("the book read at the caps, priced", PAYPAL_PRESS_BOOK_COMMANDS >= bookWork({ kept: true, entries: 1, people: 1, leads: Number.MAX_SAFE_INTEGER, paypalRefunds: Number.MAX_SAFE_INTEGER, stripe: true, products: Number.MAX_SAFE_INTEGER }, BOOK_STRIPE_PAGES).commands, true);
  const route = readFileSync(join(process.cwd(), "app/api/store/affiliates/paypal/route.ts"), "utf8");
  const cron = readFileSync(join(process.cwd(), "app/api/cron/affiliates/route.ts"), "utf8");
  is("the studio's press and payday's run stop by PAYPAL_PRESS_SECONDS", [route, cron].every((s) => new RegExp(`export const maxDuration = (\\d+);`).test(s) && Number(/export const maxDuration = (\d+);/.exec(s)![1]) <= PAYPAL_PRESS_SECONDS), true);
  is("the studio's press takes its integration unit before it reads", route.indexOf('withinServiceWhy("paypal-pay"') >= 0 && route.indexOf('withinServiceWhy("paypal-pay"') < route.indexOf("payWithPayPal(store)"), true);

  part("PAYPAL_PRESS prices every command counted, held all its seconds, and the integrations line pays for it");
  is("a press at the most", PAYPAL_PRESS >= request("wait", PAYPAL_PRESS_COMMANDS + PAYPAL_PRESS_BOOK_COMMANDS + TAKE_COMMANDS, 20_000), true);
  is("held for the whole of its seconds, not a call's ten", PAYPAL_PRESS > UNIT_COST.integration, true);
  const line = COST_LINES.find((l) => l.id === "integrations")!;
  for (const tier of ["creator", "pro", "scale"] as const) {
    // Every integration unit of the month spent on a press, and payday's auto-pay, which takes none.
    const want = figureCost(STORE_ALLOWANCES[tier], "integration") + STORE_ALLOWANCES[tier].integration * (PAYPAL_PRESS - UNIT_COST.integration) + PAYPAL_PRESSES_UNTAKEN * PAYPAL_PRESS;
    is(`${tier}: the integrations line pays every press at its most`, line.monthlyUsd(tier) >= want - 1e-12, true);
    is(`${tier}: paypalPressExcess is that difference`, Math.abs(paypalPressExcess(STORE_ALLOWANCES[tier].integration) - (want - figureCost(STORE_ALLOWANCES[tier], "integration"))) < 1e-12, true);
  }
  is("payday's auto-pay: one a store a month (claimMonth)", PAYPAL_PRESSES_UNTAKEN, 1);
  // A store that pays nothing can press with its own integration figure: its share carries the same excess.
  const registry = readFileSync(join(process.cwd(), "tests/plan-cost-registry.ts"), "utf8");
  const worst = registry.slice(registry.indexOf("export function nonPayingWorst"), registry.indexOf("\n}\n", registry.indexOf("export function nonPayingWorst")));
  is("a store that pays nothing carries it too, at its own figure", worst.includes("paypalPressExcess(allowances.integration)") && nonPayingWorst() > paypalPressExcess(NON_PAYING_ALLOWANCES.trial.integration), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
