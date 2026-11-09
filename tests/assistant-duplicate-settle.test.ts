/**
 * A second Store assistant subscription for one store is settled by the daily job, with no person (synthetic, no real
 * provider or account).
 *
 * Before: when two starts ran at the same moment across a 5-minute key window and both pages were paid, two US$69
 * add-on subscriptions existed for one store. The daily job (lib/billing-sync.ts, applyListedAssistant) kept the one
 * written down and left the other renewing "for a person to settle". The MR rule forbids a manual action as the
 * protection.
 *
 * Now: the job reads the store's written-down add-on again from Stripe in the same run, in its exact shape (rule 24).
 * Only when Stripe confirms it active, renewing, undisputed, on this store's customer and carrying this store's add-on
 * metadata, is the other live add-on re-read the same way and, when it too is an undisputed active add-on of this store,
 * set to stop at the end of the month already paid (cancel_at_period_end=true; never ended at once, never refunded,
 * never prorated), under a stable Idempotency-Key. Any other reply does nothing; an unknown reply to the stop is not
 * "done" and is tried again in the next run. A plan subscription, or one without metadata addon=assistant, is never
 * touched.
 */
import { applyListedAssistant, assistantPlanOf } from "@/lib/assistant-billing";
import { claimHandle, ensureStatsId, setAssistantPlan, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "duplicate-assistant@example.com";
const HANDLE = "dupsettle";
const CUSTOMER = "cus_DupSettle01";
const PLAN = "sub_DupSettlePlan01";
const RECORDED = "sub_DupSettle0001";
const SECOND = "sub_DupSettle0002";
const KEY = `assistant-duplicate-stop:${SECOND}`;

type Sub = Record<string, unknown> & { id: string; status: string; cancel_at_period_end: boolean };
type Write = { method: string; path: string; body: string; key: string | null; version: string | null };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const period = paidPeriod(Date.now());
let subs: Sub[] = [];
let writes: Write[] = [];
/** A reply for GET /subscriptions/<id>, in place of the real one. */
let readAs = new Map<string, (sub: Sub) => Response>();
/** A reply for the stop POST, in place of the real one; `applied` says whether Stripe made the change anyway. */
let stopAs: { reply: (sub: Sub) => Response; applied: boolean } | null = null;
let disputedFor = new Set<string>();
let unreadableInvoicesFor = new Set<string>();

const addOn = (id: string, extra: Partial<Sub> = {}): Sub => ({
  id,
  object: "subscription",
  status: "active",
  customer: CUSTOMER,
  cancel_at_period_end: false,
  cancel_at: null,
  metadata: { addon: "assistant", assistant_for: HANDLE },
  items: { data: [{ current_period_start: period.start, current_period_end: period.end }] },
  ...extra,
});

function install(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v1/, "");
    const headers = new Headers(init?.headers);
    if (method !== "GET") writes.push({ method, path, body: String(init?.body ?? ""), key: headers.get("Idempotency-Key"), version: headers.get("Stripe-Version") });
    if (method === "GET" && path === "/invoices") {
      const id = url.searchParams.get("subscription") ?? "";
      if (unreadableInvoicesFor.has(id)) return json({ object: "list", data: [{ id: `in_${id}` }], has_more: false });
      return json({ object: "list", data: [{ id: `in_${id}`, charge: { id: `ch_${id}`, disputed: disputedFor.has(id) } }], has_more: false });
    }
    const one = path.match(/^\/subscriptions\/([^/]+)$/);
    if (one) {
      const sub = subs.find((s) => s.id === decodeURIComponent(one[1]));
      if (!sub) return json({ error: { type: "invalid_request_error", message: "No such subscription" } }, 404);
      if (method === "GET") return readAs.get(sub.id)?.(sub) ?? json(sub);
      if (method === "POST") {
        const wants = new URLSearchParams(String(init?.body ?? "")).get("cancel_at_period_end") === "true";
        if (stopAs) {
          if (stopAs.applied) sub.cancel_at_period_end = wants;
          return stopAs.reply(sub);
        }
        sub.cancel_at_period_end = wants;
        return json(sub);
      }
      if (method === "DELETE") {
        sub.status = "canceled";
        return json(sub);
      }
    }
    throw new Error(`unexpected ${method} ${path}`);
  }) as typeof fetch;
}

/** A store on a paid plan with its add-on written down, and a second live add-on for it at Stripe. */
async function world(second: Partial<Sub> = {}): Promise<void> {
  redis.clear();
  writes = [];
  readAs = new Map();
  stopAs = null;
  disputedFor = new Set();
  unreadableInvoicesFor = new Set();
  subs = [addOn(RECORDED), addOn(SECOND, second)];
  await claimHandle(OWNER, HANDLE, "Synthetic store", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: CUSTOMER, subscriptionId: PLAN, active: true, tier: "creator", trialEnds: 0, period });
  await setAssistantPlan(OWNER, assistantPlanOf(subs[0]));
}

const renewing = () => subs.filter((s) => s.status === "active" && !s.cancel_at_period_end).map((s) => s.id);
const recordOf = async () => {
  const plan = (await storeForEmail(OWNER))?.assistantPlan;
  return [plan?.subscriptionId, plan?.active, plan?.cancelsAtEnd, Boolean(plan?.disputedAt)];
};
const RECORD_KEPT = [RECORDED, true, false, false];
/** One daily-job pass over the second add-on, as lib/billing-sync.ts hands it over (a listed row). */
const listSecond = () => applyListedAssistant({ ...subs.find((s) => s.id === SECOND)! });

/** Nothing is written at Stripe, both still renew, and the record is untouched. */
async function untouched(what: string): Promise<void> {
  is(`${what}: nothing is written at Stripe`, writes, []);
  is(`${what}: both add-ons still renew (today's behavior, logged)`, renewing(), [RECORDED, SECOND]);
  is(`${what}: the store's record is unchanged`, await recordOf(), RECORD_KEPT);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_duplicate_settle_only";
  install();
  const quiet = console.error;
  console.error = () => {};

  part("Two live add-ons for one store, the written-down one confirmed: the other is set to stop, by the job alone");
  await world();
  is("the job reports the store brought in line", await listSecond(), true);
  is("one add-on renews: the written-down one", renewing(), [RECORDED]);
  const second = subs.find((s) => s.id === SECOND)!;
  is("the other stays active until the end of the month paid (never ended at once)", [second.status, second.cancel_at_period_end], ["active", true]);
  is("exactly one write: cancel_at_period_end=true on the other, nothing else (no refund, no proration)", writes.map((w) => [w.method, w.path, w.body]), [["POST", `/subscriptions/${SECOND}`, "cancel_at_period_end=true"]]);
  is("the write carries a stable Idempotency-Key named by that subscription", writes.map((w) => w.key), [KEY]);
  is("the write is sent at the helper's own version (the account's, as every stop is)", writes.map((w) => w.version), [null]);
  is("the store's record is unchanged", await recordOf(), RECORD_KEPT);
  writes = [];
  await listSecond();
  is("the next run writes nothing more (already set to stop)", writes, []);
  await applyListedAssistant({ ...subs[0] });
  is("the written-down add-on, listed, is not stopped", [renewing(), writes.filter((w) => w.path.endsWith(RECORDED))], [[RECORDED], []]);

  part("The written-down add-on cannot be confirmed: nothing is stopped");
  const notConfirmed: [string, (sub: Sub) => Response][] = [
    ["Stripe answers 500", () => json({ error: { type: "api_error", message: "down" } }, 500)],
    ["the reply body is null", () => json(null)],
    ["the reply is another subscription", (sub) => json({ ...sub, id: "sub_DupSettle9999" })],
    ["the reply has no id", (sub) => json({ ...sub, id: undefined })],
    ["it is canceled at Stripe", (sub) => json({ ...sub, status: "canceled" })],
    ["it is past due", (sub) => json({ ...sub, status: "past_due" })],
    ["it is trialing", (sub) => json({ ...sub, status: "trialing" })],
    ["it is set to stop", (sub) => json({ ...sub, cancel_at_period_end: true })],
    ["it has a stop date", (sub) => json({ ...sub, cancel_at: period.end })],
    ["its stop field is missing", (sub) => json({ ...sub, cancel_at_period_end: undefined })],
    ["its stop field is not a boolean", (sub) => json({ ...sub, cancel_at_period_end: "false" })],
    ["it is another store's add-on", (sub) => json({ ...sub, metadata: { addon: "assistant", assistant_for: "otherstore" } })],
    ["it carries no add-on mark", (sub) => json({ ...sub, metadata: { assistant_for: HANDLE } })],
    ["it carries a plan's store mark", (sub) => json({ ...sub, metadata: { addon: "assistant", assistant_for: HANDLE, store: HANDLE } })],
    ["its metadata is not an object", (sub) => json({ ...sub, metadata: "assistant" })],
    ["it is on another customer", (sub) => json({ ...sub, customer: "cus_SomeoneElse1" })],
  ];
  for (const [what, reply] of notConfirmed) {
    await world();
    readAs.set(RECORDED, reply);
    is(`${what}: the job reports nothing done`, await listSecond(), false);
    await untouched(what);
  }
  await world();
  disputedFor.add(RECORDED);
  await listSecond();
  await untouched("the written-down add-on's payment is disputed");
  await world();
  unreadableInvoicesFor.add(RECORDED);
  await listSecond();
  await untouched("the written-down add-on's invoices cannot be read");

  part("The other add-on is not an undisputed active add-on of this store: it is never touched");
  const notMine: [string, (sub: Sub) => Response][] = [
    ["its re-read answers 500", () => json({ error: { type: "api_error", message: "down" } }, 500)],
    ["its re-read body is null", () => json(null)],
    ["its re-read is another subscription", (sub) => json({ ...sub, id: "sub_DupSettle9999" })],
    ["it is past due at Stripe now", (sub) => json({ ...sub, status: "past_due" })],
    ["it carries no add-on mark at Stripe now", (sub) => json({ ...sub, metadata: { assistant_for: HANDLE } })],
    ["it carries a plan's store mark at Stripe now", (sub) => json({ ...sub, metadata: { addon: "assistant", assistant_for: HANDLE, store: HANDLE } })],
    ["it is on another customer at Stripe now", (sub) => json({ ...sub, customer: "cus_SomeoneElse1" })],
    ["its stop field is not a boolean", (sub) => json({ ...sub, cancel_at_period_end: null })],
  ];
  for (const [what, reply] of notMine) {
    await world();
    readAs.set(SECOND, reply);
    await listSecond();
    await untouched(what);
  }
  await world();
  disputedFor.add(SECOND);
  await listSecond();
  await untouched("its payment is disputed (never acted on in dispute)");
  await world();
  unreadableInvoicesFor.add(SECOND);
  await listSecond();
  await untouched("its invoices cannot be read");
  for (const [what, second] of [
    ["listed trialing", { status: "trialing" }],
    ["listed incomplete", { status: "incomplete" }],
    ["listed without the add-on mark", { metadata: { assistant_for: HANDLE } }],
    ["listed with a plan's store mark", { metadata: { addon: "assistant", assistant_for: HANDLE, store: HANDLE } }],
    ["listed on another customer", { customer: "cus_SomeoneElse1" }],
  ] as [string, Partial<Sub>][]) {
    await world(second);
    await listSecond();
    is(`${what}: nothing is written at Stripe`, writes, []);
    is(`${what}: the store's record is unchanged`, await recordOf(), RECORD_KEPT);
  }

  part("An unknown reply to the stop is not done: tried again in the next run, under the same key");
  const unknownStops: [string, (sub: Sub) => Response][] = [
    ["Stripe answers 500", () => json({ error: { type: "api_error", message: "down" } }, 500)],
    ["the reply body is null", () => json(null)],
    ["the reply is another subscription", (sub) => json({ ...sub, id: "sub_DupSettle9999" })],
    ["the reply does not acknowledge the stop", (sub) => json({ ...sub, cancel_at_period_end: false })],
    ["the reply's stop field is missing", (sub) => json({ ...sub, cancel_at_period_end: undefined })],
    ["the reply's status is unknown", (sub) => json({ ...sub, status: "mystery" })],
  ];
  for (const [what, reply] of unknownStops) {
    await world();
    stopAs = { reply, applied: false };
    is(`${what}: the job reports nothing done`, await listSecond(), false);
    is(`${what}: the store's record is unchanged`, await recordOf(), RECORD_KEPT);
    stopAs = null;
    writes = [];
    is(`${what}: the next run settles it`, await listSecond(), true);
    is(`${what}: the next run sends the same key`, writes.map((w) => [w.path, w.body, w.key]), [[`/subscriptions/${SECOND}`, "cancel_at_period_end=true", KEY]]);
    is(`${what}: one add-on renews afterward`, renewing(), [RECORDED]);
  }
  await world();
  stopAs = { reply: () => json({ error: { type: "api_error", message: "lost" } }, 500), applied: true };
  is("the stop was made but its reply was lost: not reported done", await listSecond(), false);
  stopAs = null;
  writes = [];
  await listSecond();
  is("the next run reads it set to stop and writes nothing", writes, []);
  is("one add-on renews afterward", renewing(), [RECORDED]);

  part("Controls: one add-on only, and the existing adoption, unchanged");
  await world();
  subs = [subs[0]];
  is("the written-down add-on, listed alone, is brought in line", await applyListedAssistant({ ...subs[0] }), true);
  is("nothing is written at Stripe for it", writes, []);
  is("it still renews", renewing(), [RECORDED]);
  await world();
  await setAssistantPlan(OWNER, { ...assistantPlanOf(subs[0])!, active: false });
  subs[0].status = "canceled";
  is("a written-down add-on no longer active: the live one is adopted, as before", await listSecond(), true);
  is("nothing is stopped by the adoption", [writes, renewing()], [[], [SECOND]]);
  is("the store now records the live one", (await storeForEmail(OWNER))?.assistantPlan?.subscriptionId, SECOND);
  is("no plan subscription was ever written", writes.some((w) => w.path.includes(PLAN)), false);

  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
