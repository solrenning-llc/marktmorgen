/** Main store-erasure race: a give press paused at its EVAL must not restore a member mark or its index. Synthetic only. */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, storeIdCommand, storeRef, erasingField, ERASING_KEY } from "@/lib/store";
import { addBenefit, giveBenefit, BENEFIT_MARK } from "@/lib/tier-benefits";
import { personKey } from "@/lib/person-key";
import { store as redis } from "./redis-stub";
import { benefitMarkUnits } from "@/lib/tier-benefit-rules";
import { dataKey } from "@/lib/store-data";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_tier_benefits_only";

const DAY = 86_400;
const NOW = Date.UTC(2027, 2, 15, 12) / 1000;
const ANCHOR = Date.UTC(2027, 0, 31, 9) / 1000;
const owner = "benefits@example.com";
const ANN = "ann@example.com";
let product = "";
let duringRead: (() => Promise<void>) | null = null;
let samePerson = false;

const sub = (id: string, email: string) => ({
  id,
  status: "active",
  start_date: ANCHOR,
  billing_cycle_anchor: ANCHOR,
  trial_end: null,
  metadata: { store: "benefitstore", product },
  customer: { id: `cus_${id.slice(4)}`, email },
  items: { data: [{ price: { unit_amount: 1000, currency: "usd", metadata: {}, recurring: { interval: "month", interval_count: 1 } }, current_period_end: NOW + 10 * DAY }] },
});

globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  if (path === "/subscriptions") {
    // The erasure runs while giveBenefit waits on Stripe: after the read of who is owed, before the marks are written.
    const run = duringRead;
    duringRead = null;
    if (run) await run();
    return new Response(JSON.stringify({ object: "list", data: [sub("sub_active00001", ANN), sub("sub_other000001", samePerson ? ANN : "bo@example.com")], has_more: false }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

async function setUp(withList: boolean): Promise<string> {
  redis.clear();
  await claimHandle(owner, "benefitstore", "Benefit Store", "");
  await ensureStatsId(owner);
  if (withList) await ensureListId(owner);
  await setStripeAccount(owner, "acct_1Benefitxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: { ...paidPeriod() } });
  const basic = await addProduct(owner, "Basic", "", "10", { interval: "month", trialDays: 0, payments: 0 });
  if (!basic.ok) throw new Error("no product");
  product = basic.product.id;
  const store = (await storeForEmail(owner))!;
  const print = await addBenefit(store, { product, text: "A signed print", cadence: "once" }, (ANCHOR - DAY) * 1000);
  if (!print.ok) throw new Error("no benefit");
  return print.benefit.id;
}

async function main(): Promise<void> {
  for (const mode of ["live", "erasing", "gone"] as const) {
    part(`Store ${mode} at the exact benefit-mark operation`);
    const benefit = await setUp(true);
    const store = (await storeForEmail(owner))!;
    const person = personKey(store.statsId!, ANN);
    const marks = `nl:tben:given:${store.statsId}:${person}`;
    const who = `nl:tben:who:${store.statsId}`;
    const real = redis.pipeline.bind(redis);
    let intercepted = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!intercepted && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:benefit-mark:"))) {
        intercepted = true;
        if (mode === "erasing") await real([["HSET", ERASING_KEY, await erasingField(storeRef(store)), Date.now()]]);
        if (mode === "gone") await real([["DEL", storeIdCommand(store.sid)[1]], ["DEL", marks, who, `nl:tben:${store.statsId}`, dataKey(store)!]]);
      }
      return real(commands);
    }) as typeof redis.pipeline;
    let answer;
    try { answer = await giveBenefit(store, "teammate@example.com", benefit, [{ sub: "sub_active00001", period: "once" }], NOW * 1000, async () => ({ ok: true })); }
    finally { redis.pipeline = real; }
    is("the mark operation was reached", intercepted, true);
    is("success only for a live store", answer?.ok, mode === "live");
    is("no member mark resurrected after store erasure", Number((await real([["HLEN", marks]]))[0]), mode === "live" ? 1 : 0);
    is("no person index resurrected after store erasure", Number((await real([["SISMEMBER", who, person]]))[0]), mode === "live" ? 1 : 0);
    if (mode === "gone") is("no late room refund recreates the erased counter", (await real([["HGETALL", dataKey(store)!]]))[0], []);
  }
  part("Mark work refused before the room or any mark is written");
  const benefit = await setUp(true);
  const store = (await storeForEmail(owner))!;
  const room = dataKey(store)!;
  const before = await redis.pipeline([["HGETALL", room]]);
  const charged: number[] = [];
  const answer = await giveBenefit(store, "teammate@example.com", benefit, [{ sub: "sub_active00001", period: "once" }], NOW * 1000, async (units) => {
    charged.push(units);
    return units === benefitMarkUnits(1) ? { ok: false, message: "synthetic spent" } : { ok: true };
  });
  is("write work was charged after the membership page", charged, [6, benefitMarkUnits(1)]);
  is("spent work refuses the press", answer, { ok: false, reason: "used", message: "synthetic spent" });
  is("refusal changes no data room", await redis.pipeline([["HGETALL", room]]), before);
  is("no mark after work refusal", (await redis.pipeline([["HLEN", `nl:tben:given:${store.statsId}:${personKey(store.statsId!, ANN)}`]]))[0], 0);
  is("literal script fits its one KB in the four KB per-person ceiling", Buffer.byteLength(BENEFIT_MARK) <= 1_000, true);
  const commands: (string | number)[] = ["EVAL", BENEFIT_MARK, 5, "x4:marks", "x4:who", "x4:prints", storeIdCommand(store.sid)[1], ERASING_KEY, "p".repeat(40), "a".repeat(32), await erasingField(storeRef(store)), "f".repeat(94), JSON.stringify({ at: Number.MAX_SAFE_INTEGER, by: "\u0001".repeat(320) })];
  is("worst escaped mark and all EVAL arguments fit four KB", Buffer.byteLength(JSON.stringify(commands)) < 4_096, true);
  const calls = redis.scriptCalls;
  const reply = await redis.pipeline([commands]);
  is("literal memory protocol answers one new mark and index", reply, [[1, 1]]);
  is("all five inner Redis operations are billed alongside EVAL", redis.scriptCalls - calls, 5);
  part("Two rows of one person still fund two rows before writing");
  const two = await setUp(true);
  const current = (await storeForEmail(owner))!;
  samePerson = true;
  const takes: number[] = [];
  const twoAnswer = await giveBenefit(current, "teammate@example.com", two, [{ sub: "sub_active00001", period: "once" }, { sub: "sub_other000001", period: "once" }], NOW * 1000, async (units) => { takes.push(units); return { ok: true }; });
  samePerson = false;
  is("two same-person marks succeed", twoAnswer, { ok: true, given: 2, already: 0, notOwed: 0, unknown: 0 });
  is("the write admission counts rows rather than distinct people", takes, [6, benefitMarkUnits(2)]);
  done();
}
void main();
