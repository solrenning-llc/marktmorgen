/**
 * 312 [HQ1] unit 1: an early fraud warning on a payment a creator made to us
 * for their plan or an add-on is refunded before it becomes a dispute, and the
 * subscription that charged the card is ended, with Stripe simulated.
 *
 *   - only actionable warnings are refunded, in full or what is left, once,
 *     with reason "fraudulent" and one idempotency key per warning;
 *   - the subscription is ended at once; an ending that fails is tried again
 *     on later runs even after the warning stops being actionable;
 *   - a payment that is not a plan or add-on invoice is never touched;
 *   - a run refunds at most MAX_REFUNDS payments, reads at most MAX_PAGES
 *     pages and stops at its deadline; a refund receipt that does not match
 *     ends nothing;
 *   - the daily plans job runs it before the subscriptions are read.
 */
import { readFileSync } from "node:fs";
import { MAX_PAGES, MAX_REFUNDS, SEEN_KEY, refundKeyOf, syncPlanFraudWarnings } from "@/lib/plan-fraud-warnings";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_fraud_only";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

type Charge = { id: string; amount: number; amount_refunded: number; disputed: boolean; invoice: Record<string, unknown> | null };
type Warning = { id: string; object: "radar.early_fraud_warning"; actionable: boolean; created: number; fraud_type: string; charge: string };

let warnings: Warning[] = [];
let charges: Record<string, Charge> = {};
let subscriptions: Record<string, Record<string, unknown>> = {};
/** Receipts by idempotency key, as Stripe replays a key's first answer. */
let receipts: Record<string, Record<string, unknown>> = {};
let deleteFails: Set<string> = new Set();
let receiptAmountOff = 0;
let listBroken = false;
const asked: string[] = [];
const refundBodies: { key: string | null; body: string }[] = [];

function header(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name] ?? null;
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname !== "api.stripe.com") return new Response("{}", { status: 404 });
  asked.push(`${method} ${url.pathname}${url.search}`);
  if (method === "GET" && url.pathname === "/v1/radar/early_fraud_warnings") {
    if (listBroken) return Response.json({ data: "not a list", has_more: false });
    const since = Number(url.searchParams.get("created[gte]"));
    const listed = warnings.filter((warning) => warning.created >= since).sort((a, b) => b.created - a.created);
    const after = url.searchParams.get("starting_after");
    const start = after ? listed.findIndex((warning) => warning.id === after) + 1 : 0;
    const page = listed.slice(start, start + 100).map((warning) => {
      const charge = charges[warning.charge];
      // Stripe's own rule: actionable until disputed or fully refunded.
      const actionable = warning.actionable && !charge.disputed && charge.amount_refunded < charge.amount;
      return { ...warning, actionable, charge: url.searchParams.getAll("expand[]").includes("data.charge.invoice") ? { object: "charge", ...charge } : charge.id };
    });
    return Response.json({ object: "list", data: page, has_more: start + 100 < listed.length });
  }
  if (url.pathname.startsWith("/v1/subscriptions/")) {
    const id = decodeURIComponent(url.pathname.slice("/v1/subscriptions/".length));
    const subscription = subscriptions[id];
    if (!subscription) return Response.json({ error: { message: "No such subscription" } }, { status: 404 });
    if (method === "GET") return Response.json(subscription);
    if (method === "DELETE") {
      if (deleteFails.has(id)) return Response.json({ error: { message: "boom" } }, { status: 500 });
      subscription.status = "canceled";
      return Response.json(subscription);
    }
  }
  if (method === "POST" && url.pathname === "/v1/refunds") {
    const key = header(init, "Idempotency-Key");
    const body = new URLSearchParams(String(init?.body ?? ""));
    refundBodies.push({ key, body: String(init?.body ?? "") });
    if (key && receipts[key]) return Response.json(receipts[key]);
    const charge = charges[body.get("charge") ?? ""];
    const amount = Number(body.get("amount"));
    if (!charge || charge.amount_refunded + amount > charge.amount) return Response.json({ error: { code: "charge_already_refunded" } }, { status: 400 });
    charge.amount_refunded += amount;
    const receipt = { id: `re_${Object.keys(receipts).length + 1}x`, object: "refund", charge: charge.id, amount: amount - receiptAmountOff, status: "succeeded", reason: body.get("reason") };
    if (key) receipts[key] = receipt;
    return Response.json(receipt);
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

function reset(): void {
  redis.clear();
  warnings = [];
  charges = {};
  subscriptions = {};
  receipts = {};
  deleteFails = new Set();
  receiptAmountOff = 0;
  listBroken = false;
  asked.length = 0;
  refundBodies.length = 0;
}

/** A warning on a charge of `amount` cents billed by `subscription` (null: a charge with no invoice). */
function warn(n: number, subscription: Record<string, unknown> | null, amount = 6_900, opts: { actionable?: boolean; refunded?: number; ageDays?: number } = {}): string {
  const id = `issfr_W${n}`;
  const charge = `ch_C${n}`;
  charges[charge] = { id: charge, amount, amount_refunded: opts.refunded ?? 0, disputed: false, invoice: subscription ? { id: `in_I${n}`, subscription: subscription.id } : null };
  if (subscription) subscriptions[String(subscription.id)] = subscription;
  warnings.push({ id, object: "radar.early_fraud_warning", actionable: opts.actionable ?? true, created: NOW - (opts.ageDays ?? 1) * DAY - n, fraud_type: "made_with_stolen_card", charge });
  return id;
}
const plan = (n: number) => ({ id: `sub_P${n}`, status: "active", metadata: { store: `shop-${n}` }, customer: `cus_${n}` });
const addOn = (n: number) => ({ id: `sub_A${n}`, status: "active", metadata: { addon: "assistant", assistant_for: `shop-${n}` }, customer: `cus_${n}` });
const foreign = (n: number) => ({ id: `sub_F${n}`, status: "active", metadata: {}, customer: `cus_${n}` });
const posts = () => asked.filter((line) => line.startsWith("POST "));
const deletes = () => asked.filter((line) => line.startsWith("DELETE "));
const run = (now = NOW) => syncPlanFraudWarnings(Date.now() + 10_000, now);

async function main(): Promise<void> {
  part("The daily plans job runs it, before the subscriptions are read");
  {
    const route = readFileSync("app/api/cron/plans/route.ts", "utf8");
    const at = route.indexOf("syncPlanFraudWarnings(");
    is("the job calls it", at > 0, true);
    is("before syncSubscriptions, so an ended subscription is seen the same day", at < route.indexOf("syncSubscriptions(deadline)"), true);
  }

  part("A plan payment and an add-on payment with a warning are refunded in full and their subscriptions end");
  {
    reset();
    const p = warn(1, plan(1));
    const a = warn(2, addOn(2), 6_900);
    const counts = await run();
    is("counts", counts, { seen: 2, refunded: 2, ended: 0, unmatched: 0, skipped: 0, failed: 0, complete: true });
    is("two refunds asked", refundBodies.length, 2);
    const bodies = refundBodies.map((sent) => Object.fromEntries(new URLSearchParams(sent.body)));
    is("each of what was charged, with reason fraudulent", bodies.map((body) => [body.charge, body.amount, body.reason]).sort(), [["ch_C1", "6900", "fraudulent"], ["ch_C2", "6900", "fraudulent"]]);
    is("one idempotency key per warning", refundBodies.map((sent) => sent.key).sort(), [refundKeyOf(p), refundKeyOf(a)].sort());
    is("both subscriptions ended at once", [subscriptions.sub_P1.status, subscriptions.sub_A2.status], ["canceled", "canceled"]);
    is("the list looks back 120 days and expands the charge's invoice", asked.some((line) => line.startsWith("GET /v1/radar/early_fraud_warnings?") && line.includes(`created%5Bgte%5D=${NOW - 120 * DAY}`) && line.includes("expand%5B%5D=data.charge.invoice")), true);
    asked.length = 0;
    const again = await run();
    is("the next run refunds and ends nothing again", [posts().length, deletes().length, again.refunded], [0, 0, 0]);
    is("and reads no subscription", asked.filter((line) => line.startsWith("GET /v1/subscriptions/")).length, 0);
  }

  part("Only what is left of a partly refunded payment is refunded");
  {
    reset();
    warn(3, plan(3), 6_900, { refunded: 1_000 });
    await run();
    is("5,900 cents", new URLSearchParams(refundBodies[0]?.body ?? "").get("amount"), "5900");
  }

  part("A warning that is not actionable, or a payment that is not ours, is never touched");
  {
    reset();
    warn(4, plan(4), 6_900, { actionable: false });
    warn(5, foreign(5));
    warn(6, null);
    const counts = await run();
    is("counts", [counts.skipped, counts.unmatched, counts.refunded, counts.complete], [1, 2, 0, true]);
    is("no refund, no ending", [posts().length, deletes().length], [0, 0]);
    is("their subscriptions still active", [subscriptions.sub_P4.status, subscriptions.sub_F5.status], ["active", "active"]);
    asked.length = 0;
    await run();
    is("and the unmatched one costs no subscription read again", asked.filter((line) => line.startsWith("GET /v1/subscriptions/")).length, 0);
  }

  part("An ending that fails after the refund is tried again, though the warning is no longer actionable");
  {
    reset();
    const id = warn(7, plan(7));
    deleteFails.add("sub_P7");
    const first = await run();
    is("refunded, not complete", [first.refunded, first.complete], [1, false]);
    is("written down as still to end", await redis.pipeline([["HGET", SEEN_KEY, id]]), ["end:sub_P7"]);
    is("still active", subscriptions.sub_P7.status, "active");
    deleteFails.clear();
    asked.length = 0;
    const second = await run();
    is("the next run ends it", subscriptions.sub_P7.status, "canceled");
    is("without refunding again", [refundBodies.length, posts().length], [1, 0]);
    is("counts", [second.ended, second.complete], [1, true]);
  }

  part("A refunded payment whose warning is no longer listed has its subscription ended by id");
  {
    reset();
    const id = warn(8, plan(8));
    deleteFails.add("sub_P8");
    await run();
    deleteFails.clear();
    warnings = [];
    const later = await run();
    is("ended by id", [subscriptions.sub_P8.status, later.ended], ["canceled", 1]);
    is("then final", await redis.pipeline([["HGET", SEEN_KEY, id]]), ["final"]);
  }

  part("A refund receipt that does not match ends nothing and is asked again, with the same key");
  {
    reset();
    const id = warn(9, plan(9));
    receiptAmountOff = 100;
    const first = await run();
    is("failed, not refunded, not complete", [first.failed, first.refunded, first.complete], [1, 0, false]);
    is("the subscription is not ended on an unconfirmed refund", subscriptions.sub_P9.status, "active");
    is("nothing written down", await redis.pipeline([["HGET", SEEN_KEY, id]]), [null]);
  }

  part("A run refunds at most MAX_REFUNDS payments; the rest wait, still actionable");
  {
    reset();
    for (let n = 100; n < 100 + MAX_REFUNDS + 5; n += 1) warn(n, plan(n));
    const first = await run();
    is("MAX_REFUNDS refunds", [refundBodies.length, first.refunded, first.complete], [MAX_REFUNDS, MAX_REFUNDS, false]);
    const second = await run();
    is("the rest on the next run", [refundBodies.length, second.refunded, second.complete], [MAX_REFUNDS + 5, 5, true]);
  }

  part("At most MAX_PAGES pages a run; an unreadable page is not complete; a passed deadline does nothing");
  {
    reset();
    for (let n = 1_000; n < 1_000 + 100 * (MAX_PAGES + 1); n += 1) warn(n, plan(n), 6_900, { actionable: false });
    const counts = await run();
    is("pages read", asked.filter((line) => line.startsWith("GET /v1/radar/")).length, MAX_PAGES);
    is("not complete", counts.complete, false);
    reset();
    listBroken = true;
    const broken = await run();
    is("unreadable list", [broken.failed, broken.complete], [1, false]);
    reset();
    warn(2_000, plan(2_000));
    const late = await syncPlanFraudWarnings(Date.now() - 1, NOW);
    is("nothing asked after the deadline", [asked.length, late.complete], [0, false]);
  }

  part("A warning older than 120 days is not listed");
  {
    reset();
    warn(3_000, plan(3_000), 6_900, { ageDays: 121 });
    await run();
    is("no refund", refundBodies.length, 0);
  }

  done();
}

void main();
