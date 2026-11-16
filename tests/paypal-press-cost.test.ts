/**
 * What one press of "Pay with PayPal" (lib/paypal-payouts.ts, payWithPayPal) sends to Redis, held against the line
 * that pays for it (Claude 7 on #4488 @ddbc2cec8b, MÉDIO). A press is taken as one integration unit
 * (app/api/store/affiliates/paypal/route.ts, withinServiceWhy "paypal-pay"), priced at ten commands, and payday's
 * auto-pay (lib/affiliate-payday.ts) takes none; a press really sends the link read, the lock taken (up to its tries),
 * the whole book, who is on their way twice, the token's link, the lock held again (EVAL), the batch written down, its
 * settling and the lock let go (EVAL): 18 or more commands with two affiliates. Here each is counted, through the
 * Redis stand-in, on the paths that send the most, and held under PAYPAL_PRESS_COMMANDS (the press's own) and
 * bookWork (its book read at its size; PAYPAL_PRESS_BOOK_COMMANDS at the caps). A studio press takes the integration
 * units that cover it at the program's size, counted first (paypalPressUnits); payday's auto-pay, which takes none, is
 * priced once a month in the integrations line at PAYPAL_PRESS. Synthetic: stand-ins for PayPal, Stripe and Redis.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PAYPAL_PRESS_BASE_UNITS, PAYPAL_PRESS_UNIT_COMMANDS, connectPayPal, payWithPayPal, paypalPressUnits } from "@/lib/paypal-payouts";
import { bookSizes, readBook, BOOK_STRIPE_PAGES } from "@/lib/affiliates";
import { bookWork } from "@/lib/api-read-rules";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import {
  COST_LINES, PAYPAL_PRESS, PAYPAL_PRESS_BOOK_COMMANDS, PAYPAL_PRESS_COMMANDS, PAYPAL_PRESS_LOCK_TRIES, PAYPAL_PRESS_SECONDS,
  PAYPAL_PRESSES_UNTAKEN, COMMAND, TAKE_COMMANDS, UNIT_COST, figureCost, paypalPressCost, request, lockTriesAtMost,
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
    catalog: { items: [] },
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
  await readBook(store, undefined, { titles: false });
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
    is(`${people} affiliates: its book read (${book.length}) is within what bookWork counts at its size`, book.length <= bookWork({ ...sizes!, products: 0 }, BOOK_STRIPE_PAGES).commands, true);
    is(`${people} affiliates: the units it takes (${paypalPressUnits(sizes!)}) cover what it sent`, paypalPressUnits(sizes!) * UNIT_COST.integration >= paypalPressCost(book.length + 8) && own + book.length + 8 <= PAYPAL_PRESS_COMMANDS + bookWork({ ...sizes!, products: 0 }, BOOK_STRIPE_PAGES).commands, true);
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
  // The press reads the book with no product titles (a batch names none), so its products are never read.
  is("the press reads no product for its title", paySource.includes("const book = await readBook(store, undefined, { titles: false });"), true);
  is("the book read at the caps, priced", PAYPAL_PRESS_BOOK_COMMANDS >= bookWork({ kept: true, entries: 1, people: 1, leads: Number.MAX_SAFE_INTEGER, paypalRefunds: Number.MAX_SAFE_INTEGER, stripe: true, products: 0 }, BOOK_STRIPE_PAGES).commands, true);
  const route = readFileSync(join(process.cwd(), "app/api/store/affiliates/paypal/route.ts"), "utf8");
  const cron = readFileSync(join(process.cwd(), "app/api/cron/affiliates/route.ts"), "utf8");
  is("the studio's press and payday's run stop by PAYPAL_PRESS_SECONDS", [route, cron].every((s) => new RegExp(`export const maxDuration = (\\d+);`).test(s) && Number(/export const maxDuration = (\d+);/.exec(s)![1]) <= PAYPAL_PRESS_SECONDS), true);
  const sizesAt = route.indexOf("const sizes = await bookSizes(store);");
  const takeAt = route.indexOf('withinServiceWhy("paypal-pay", store.handle, 6, 3600, store, paypalPressUnits(sizes))');
  is("the studio's press counts the program, then takes its units, before it reads or sends", sizesAt > 0 && sizesAt < takeAt && takeAt < route.indexOf("payWithPayPal(store)"), true);
  is("a program not counted is never taken as small", route.includes("if (!sizes) return fail(\"error\", 502);"), true);

  part("The units a press takes cover it at every size; payday's auto-pay is in the integrations line");
  is("a press at the most", PAYPAL_PRESS >= request("wait", PAYPAL_PRESS_COMMANDS + PAYPAL_PRESS_BOOK_COMMANDS + TAKE_COMMANDS, 20_000), true);
  is("held for the whole of its seconds, not a call's ten", PAYPAL_PRESS > UNIT_COST.integration, true);
  is("each unit past the base pays for at least its commands", PAYPAL_PRESS_UNIT_COMMANDS * COMMAND <= UNIT_COST.integration, true);
  is("the base pays for the press with an empty book", PAYPAL_PRESS_BASE_UNITS * UNIT_COST.integration >= paypalPressCost(0), true);
  let sizesChecked = 0;
  for (const entries of [0, 1, 3, 1_000, 200_000]) for (const people of [0, 1, 40, 1_000]) for (const leads of [0, 1, 99, 100, 101, 200, 5_000]) {
    for (const paypalRefunds of [0, 1, 39, 40, 41, 499, 500, 501, 20_000]) for (const stripe of [false, true]) for (const products of [0, 50, 5_000]) {
      const sizes = { kept: true, entries, people: Math.min(people, entries), leads: Math.min(leads, entries), paypalRefunds, stripe, products };
      const commands = bookWork({ ...sizes, products: 0 }, BOOK_STRIPE_PAGES).commands;
      assert.ok(paypalPressUnits(sizes) * UNIT_COST.integration >= paypalPressCost(commands), `${JSON.stringify(sizes)}: ${paypalPressUnits(sizes)} units < ${paypalPressCost(commands)}`);
      sizesChecked += 1;
    }
  }
  is(`the units cover the press at ${sizesChecked} sizes`, sizesChecked > 1_000, true);
  is("a book not kept costs the base", paypalPressUnits({ kept: false, entries: 0, people: 0, leads: 0, paypalRefunds: 0, stripe: true, products: 9 }), PAYPAL_PRESS_BASE_UNITS);
  const line = COST_LINES.find((l) => l.id === "integrations")!;
  for (const tier of ["creator", "pro", "scale"] as const) {
    is(`${tier}: the integrations line pays the figure and payday's auto-pay at its most`, Math.abs(line.monthlyUsd(tier) - (figureCost(STORE_ALLOWANCES[tier], "integration") + PAYPAL_PRESSES_UNTAKEN * PAYPAL_PRESS)) < 1e-12, true);
  }
  is("payday's auto-pay: one a store a month (claimMonth)", PAYPAL_PRESSES_UNTAKEN, 1);
  const payday = readFileSync(join(process.cwd(), "lib/affiliate-payday.ts"), "utf8");
  is("payday claims the month before it pays by itself", payday.indexOf("claimMonth(store.statsId, month)") > 0 && payday.indexOf("claimMonth(store.statsId, month)") < payday.indexOf("await payWithPayPal(store)"), true);
  // Kept for good before the press, not after the email (Claude 6 on #4488): a refused email or a run stopped mid-press
  // never lets the next day's run press again (tests/affiliate-payday-catch-up.test.ts holds it by behavior).
  const kept = payday.indexOf("if (!(await keepMonth(store.statsId, month))) throw");
  is("payday keeps the month, confirmed, before it pays by itself", kept > payday.indexOf("claimMonth(store.statsId, month)") && kept < payday.indexOf("await payWithPayPal(store)"), true);
  const registry = readFileSync(join(process.cwd(), "tests/plan-cost-registry.ts"), "utf8");
  const worst = registry.slice(registry.indexOf("export function nonPayingWorst"), registry.indexOf("\n}\n", registry.indexOf("export function nonPayingWorst")));
  is("a store that pays nothing carries its payday's auto-pay too", worst.includes("PAYPAL_PRESSES_UNTAKEN * PAYPAL_PRESS"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
