/**
 * A usage line's record is what stops a second charge (lib/usage-billing.ts
 * settleUsage, Claude 6 on #2944). It may go only once the line is known to be
 * billed, and a line written down for more than is owed now may be dropped
 * only once Stripe says it never got it.
 *
 * 1. Once a line is on the invoice, the month's billed figure is written, and
 *    the record is deleted only after an exact "OK" for that write. Sent in one
 *    request, a refused write (Redis out of memory) with the delete still run
 *    lost the record while the figure stayed where it was: the next run began
 *    the month again under a new time, could not see the line already there,
 *    and charged it a second time.
 * 2. A line written down for more than is owed now (its charge's answer lost,
 *    then the meter owing less) is looked up on Stripe before it is dropped: a
 *    line found there counts as billed; one Stripe cannot be asked about is
 *    kept and tried again on the next run.
 *
 * No meter owes anything today (232 [CA1] unit 3); the meter made here owes a
 * figure set by each case, so the path that would charge is the one tested.
 * Synthetic data only; Stripe is a stand-in here that keeps each line with its
 * time and mark, answers `created[gte]`, and honors an Idempotency-Key for 24
 * hours; Redis is the stub with one command refused on demand.
 */
import { settleUsage, type Meter } from "@/lib/usage-billing";
import { rememberFolderOwner } from "@/lib/delivery";
import { claimHandle, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_usage_billing_close_exact_only";

type Line = { id: string; cents: number; mark: string; created: number; key: string; customer: string; subscription: string };
const lines: Line[] = [];
/** The stand-in's clock, in milliseconds: the time each case runs at. */
let clock = Date.now();
/** "lose": the line is made and its answer lost; "list": a lookup fails. */
let stripeFault: "lose" | "list" | null = null;
/** A 200 answer to a lookup in place of the real list: a body Stripe should never send (Claude 6 on #2944, ce838f4f). */
let listBody: ((page: number) => unknown) | null = null;
let listPage = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname !== "api.stripe.com" || !url.pathname.endsWith("/invoiceitems")) {
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  }
  const now = Math.floor(clock / 1000);
  if (method === "POST") {
    const body = new URLSearchParams(String(init?.body ?? ""));
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    const again = lines.find((l) => l.key === key && now - l.created < 86_400);
    const line = again ?? {
      id: `ii_${lines.length + 1}`,
      cents: Number(body.get("amount")),
      mark: String(body.get("metadata[mark]")),
      created: now,
      key,
      customer: String(body.get("customer")),
      subscription: String(body.get("subscription")),
    };
    if (!again) lines.push(line);
    if (stripeFault === "lose") throw new TypeError("synthetic: the answer was lost on the way back");
    return new Response(JSON.stringify({ id: line.id, object: "invoiceitem" }), { status: 200 });
  }
  if (stripeFault === "list") return new Response(JSON.stringify({ error: { message: "synthetic: unavailable" } }), { status: 503 });
  if (listBody) return new Response(JSON.stringify(listBody(listPage++)), { status: 200 });
  const since = Number(url.searchParams.get("created[gte]") ?? 0);
  // Each line in the shape Stripe lists it at the pinned version (lib/billing.ts findInvoiceLine, #3232).
  const data = lines
    .filter((l) => l.created >= since)
    .map((l) => ({
      id: l.id,
      object: "invoiceitem",
      customer: l.customer,
      parent: { type: "subscription_details", subscription_details: { subscription: l.subscription } },
      amount: l.cents,
      currency: "usd",
      metadata: { mark: l.mark },
    }));
  return new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
}) as typeof fetch;

type Command = (string | number)[];
/** A key whose SET is refused, as Redis does out of memory: the request's other commands still run, then it fails. */
let refuseSetOf: string | null = null;
/** A key whose SET lands with its answer lost. */
let loseSetOf: string | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  const refused = commands.findIndex((c) => c[0] === "SET" && c[1] === refuseSetOf);
  if (refused >= 0) {
    const rest = commands.filter((_, i) => i !== refused);
    if (rest.length) await pipeline(rest);
    throw new Error("Redis error: OOM command not allowed when used memory > 'maxmemory'");
  }
  if (commands.some((c) => c[0] === "SET" && c[1] === loseSetOf)) {
    await pipeline(commands);
    return [];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

let owed = 500;
const meter: Meter = {
  name: "closemeter",
  measured: async () => 10,
  owed: () => owed,
  byPlan: false,
  covered: 0,
  describe: (month) => `Test use in ${month}`,
  folders: async () => [],
};
const DAY = 86_400_000;
const charged = () => lines.reduce((sum, l) => sum + l.cents, 0);

async function main(): Promise<void> {
  redis.clear();
  const email = "close@example.com";
  await claimHandle(email, "close", "Close Shop", "");
  await setSubscription(email, { customerId: "cus_Close00001", subscriptionId: "sub_Close00001", active: true, period: paidPeriod() });
  const store = (await storeForEmail(email))!;
  const folder = await storeFolder(storeRef(store));
  await rememberFolderOwner(folder, email);
  const keys = (month: string) => ({ billed: `nl:closemeter:billed:${folder}:${month}`, adding: `nl:closemeter:adding:${folder}:${month}` });
  const t0 = Date.now();
  /** One run at `at`: its state ("unknown" when it threw). */
  const run = async (month: string, at: number) => {
    clock = at;
    return settleUsage(meter, folder, month, true, at).then((row) => row.state, () => "unknown");
  };
  const fresh = (month: string, figure: number) => {
    lines.length = 0;
    owed = figure;
    refuseSetOf = loseSetOf = null;
    stripeFault = null;
    return keys(month);
  };

  part("The billed figure refused after a new line is charged: the record stays, the line is never charged again");
  {
    const k = fresh("2026-01", 500);
    refuseSetOf = k.billed;
    is("the line reaches Stripe, the figure's write is refused: the run fails", [await run("2026-01", t0), charged()], ["unknown", 500]);
    refuseSetOf = null;
    is("the line's record is still there", (await pipeline([["GET", k.adding]]))[0] !== null, true);
    is("the next day (its Idempotency-Key gone) the line is found, not charged again", [await run("2026-01", t0 + DAY + 3_600_000), charged(), lines.length], ["billed", 500, 1]);
    is("and the figure is written", (await pipeline([["GET", k.billed]]))[0], "500");
  }

  part("The same, then the month grows the same day: only the new part is charged");
  {
    const k = fresh("2026-02", 500);
    refuseSetOf = k.billed;
    is("the first 500 reach Stripe, the figure's write is refused", [await run("2026-02", t0), charged()], ["unknown", 500]);
    refuseSetOf = null;
    owed = 600;
    is("an hour later the month owes 600: 600 charged in all, never 1100", [await run("2026-02", t0 + 3_600_000), charged()], ["billed", 600]);
  }

  part("The billed figure refused after an unfinished line is finished: the record stays");
  {
    const k = fresh("2026-03", 500);
    await pipeline([["SET", k.adding, JSON.stringify({ from: 0, to: 500, at: t0, amount: 10, line: "Test use", customerId: "cus_Close00001", subscriptionId: "sub_Close00001" })]]);
    refuseSetOf = k.billed;
    is("the unfinished line reaches Stripe, the figure's write is refused", [await run("2026-03", t0), charged()], ["unknown", 500]);
    refuseSetOf = null;
    is("the next day the line is found, not charged again", [await run("2026-03", t0 + DAY + 3_600_000), charged(), lines.length], ["billed", 500, 1]);
  }

  part("Control: the figure's write lands with its answer lost: nothing is charged twice");
  {
    const k = fresh("2026-04", 500);
    loseSetOf = k.billed;
    const first = await run("2026-04", t0);
    loseSetOf = null;
    is("the line is charged once", [first === "billed" || first === "unknown", charged()], [true, 500]);
    is("the next day nothing more", [await run("2026-04", t0 + DAY + 3_600_000), charged()], ["nothing", 500]);
  }

  part("A line written for more than is owed now, its charge's answer lost: found on Stripe, never charged again");
  {
    const k = fresh("2026-05", 500);
    stripeFault = "lose";
    is("the 500 reach Stripe, the answer is lost: failed", [await run("2026-05", t0), charged()], ["failed", 500]);
    stripeFault = null;
    owed = 300;
    is("the meter now owes 300: the line is found and counts as billed; 500 in all, never 800", [await run("2026-05", t0 + DAY + 3_600_000), charged(), lines.length], ["billed", 500, 1]);
    is("its figure is written and its record gone", [(await pipeline([["GET", k.billed]]))[0], (await pipeline([["GET", k.adding]]))[0]], ["500", null]);
    is("nothing more after that", [await run("2026-05", t0 + 2 * DAY), charged()], ["nothing", 500]);
  }

  part("Control: a line written for more than is owed now that Stripe never got is dropped, and what is owed is billed");
  {
    const k = fresh("2026-06", 300);
    await pipeline([["SET", k.adding, JSON.stringify({ from: 0, to: 500, at: t0, amount: 10, line: "Test use", customerId: "cus_Close00001", subscriptionId: "sub_Close00001" })]]);
    is("not on Stripe: dropped, 300 billed", [await run("2026-06", t0 + DAY), charged()], ["billed", 300]);
  }

  part("A line written for more than is owed now that Stripe cannot be asked about is kept, nothing charged");
  {
    const k = fresh("2026-07", 300);
    const record = JSON.stringify({ from: 0, to: 500, at: t0, amount: 10, line: "Test use", customerId: "cus_Close00001", subscriptionId: "sub_Close00001" });
    await pipeline([["SET", k.adding, record]]);
    stripeFault = "list";
    is("the lookup fails: failed, nothing charged", [await run("2026-07", t0 + DAY), charged()], ["failed", 0]);
    stripeFault = null;
    is("the record is kept for the next run", (await pipeline([["GET", k.adding]]))[0], record);
  }

  part("A line written for more than is owed now, then a lookup Stripe answers off its shape or past the pages read: kept, never 800");
  {
    // Claude 6's MEDIUM on #2944 at ce838f4f: these read as "not there", the record was dropped and 0..300 charged again.
    // Closed by #3232 (lib/billing.ts findInvoiceLine reads the list in its exact shape and throws on anything else).
    const others = (page: number) =>
      Array.from({ length: 100 }, (_, i) => ({ id: `ii_Other${page}x${i}`, object: "invoiceitem", metadata: { mark: "someone-else" } }));
    const bodies: [string, (page: number) => unknown][] = [
      ["a list with no data", () => ({ object: "list", has_more: false })],
      ["data as an object", () => ({ object: "list", data: {}, has_more: false })],
      ["an empty object", () => ({})],
      ["three full pages of other lines, more still to come", (page) => ({ object: "list", data: others(page), has_more: true })],
    ];
    let month = 9;
    for (const [what, body] of bodies) {
      const m = `2026-${String(month++).padStart(2, "0")}`;
      const k = fresh(m, 500);
      stripeFault = "lose";
      await run(m, t0);
      stripeFault = null;
      owed = 300;
      const record = (await pipeline([["GET", k.adding]]))[0];
      is(`${what}: run 1 charged 500 with its answer lost and kept the line's record`, [charged(), typeof record], [500, "string"]);
      listBody = body;
      listPage = 0;
      is(`${what}: failed, the record kept, 500 in all`, [await run(m, t0 + DAY + 3_600_000), charged(), (await pipeline([["GET", k.adding]]))[0]], ["failed", 500, record]);
      listBody = null;
      is(`${what}, then a readable list: the line is found, 500 in all, never 800`, [await run(m, t0 + 2 * DAY), charged()], ["billed", 500]);
    }
  }

  part("Control: healthy, billed once, then nothing more");
  {
    fresh("2026-08", 500);
    is("billed", [await run("2026-08", t0), charged()], ["billed", 500]);
    is("nothing more", [await run("2026-08", t0 + DAY + 3_600_000), charged()], ["nothing", 500]);
  }

  done();
}

void main();
