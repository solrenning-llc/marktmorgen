/**
 * 422 [PT2], unit 1: benefits a creator hands over by hand on each
 * membership (a signed print once, a call every month), who is still waiting
 * for each one and until when, and marking them given in bulk
 * (lib/tier-benefit-rules.ts, lib/tier-benefits.ts), with Stripe faked through
 * fetch and the database in memory.
 *
 * What must hold: a benefit is owed only from what the member's membership
 * on the creator's own Stripe says right now (paid, not in a free trial, not
 * paused); an answer that cannot be read is said as unknown, never as
 * "nobody waiting" and never as given; marking is idempotent, exact about
 * what it did, refuses what is not owed, and never writes for a person whose
 * marks could not be read; a retired benefit stays owed for what was owed
 * before it was retired; a deleted person's marks go with them.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import {
  MAX_BENEFITS_PER_TIER,
  MAX_BENEFIT_TEXT,
  MAX_GIVE_AT_ONCE,
  benefitText,
  monthWindow,
  owedNow,
} from "@/lib/tier-benefit-rules";
import { addBenefit, benefitsDue, forgetBenefitPerson, giveBenefit, readBenefits, retireBenefit, undoGiven } from "@/lib/tier-benefits";
import { personKey } from "@/lib/person-key";
import { ERASERS } from "@/lib/person-erasure";
import { PERSON_DATA } from "@/lib/person-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_tier_benefits_only";

const DAY = 86_400;
// 15 March 2027, noon UTC.
const NOW = Date.UTC(2027, 2, 15, 12) / 1000;
const ANCHOR = Date.UTC(2027, 0, 31, 9) / 1000;

let products = { basic: "", pro: "", book: "" };
let mode: "ok" | "error" | "garbled" | "endless" = "ok";
let stripeCalls = 0;

const sub = (id: string, email: string, product: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "active",
  start_date: ANCHOR,
  billing_cycle_anchor: ANCHOR,
  metadata: { store: "benefitstore", product },
  customer: { id: `cus_${id.slice(4)}`, email },
  items: { data: [{ price: { unit_amount: 1000, currency: "usd", metadata: {}, recurring: { interval: "month", interval_count: 1 } }, current_period_end: NOW + 10 * DAY }] },
  ...extra,
});

const subs = () => [
  sub("sub_active00001", "Ann@Example.com", products.basic),
  sub("sub_trial000001", "bea@example.com", products.basic, { status: "trialing", billing_cycle_anchor: NOW + 5 * DAY }),
  sub("sub_pastdue0001", "cal@example.com", products.basic, { status: "past_due" }),
  sub("sub_paused00001", "dee@example.com", products.basic, { pause_collection: { behavior: "void", resumes_at: NOW + 20 * DAY }, metadata: { store: "benefitstore", product: products.basic, pause_from: String(NOW - DAY) } }),
  sub("sub_otherst0001", "eve@example.com", products.basic, { metadata: { store: "another", product: products.basic } }),
  sub("sub_planpay0001", "fay@example.com", products.basic, { metadata: { store: "benefitstore", product: products.basic, kind: "plan" } }),
  sub("sub_proplan0001", "gus@example.com", products.pro),
  sub("sub_ended000001", "hal@example.com", products.basic, { status: "canceled" }),
];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/subscriptions") {
    stripeCalls += 1;
    if (mode === "error") return answer({ error: { message: "down" } }, 500);
    if (mode === "garbled") return answer({ object: "list", data: "nothing", has_more: false });
    if (mode === "endless") {
      const after = url.searchParams.get("starting_after") ?? "";
      const n = after ? Number(after.slice(-4)) + 1 : 0;
      return answer({ object: "list", data: [sub(`sub_endless${String(n).padStart(4, "0")}`, `p${n}@example.com`, products.basic)], has_more: true });
    }
    return answer({ object: "list", data: subs(), has_more: false });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  part("The rules, by themselves");
  is("a benefit's words are trimmed and bounded", [benefitText("  A signed   print "), benefitText(""), benefitText("x".repeat(MAX_BENEFIT_TEXT)), benefitText("x".repeat(MAX_BENEFIT_TEXT + 1)), benefitText("bad\u0000word"), benefitText(42)], ["A signed print", null, "x".repeat(MAX_BENEFIT_TEXT), null, null, null]);
  is("bounds stated in the code", [MAX_BENEFITS_PER_TIER, MAX_BENEFIT_TEXT, MAX_GIVE_AT_ONCE], [5, 120, 200]);
  const win = monthWindow(ANCHOR, NOW);
  is("a month counted from the billing anchor, the 31st kept as the month's last day", win ? [new Date(win.from * 1000).toISOString(), new Date(win.until * 1000).toISOString()] : null, ["2027-02-28T09:00:00.000Z", "2027-03-31T09:00:00.000Z"]);
  is("before the anchor there is no month yet", monthWindow(NOW + DAY, NOW), null);
  const once = { id: "b000000000001", product: "p1", text: "A signed print", cadence: "once" as const, since: ANCHOR - DAY, retired: 0 };
  const monthly = { ...once, id: "b000000000002", text: "A monthly call", cadence: "monthly" as const };
  const member = { sub: "sub_x", status: "active", product: "p1", anchor: ANCHOR, start: ANCHOR, trialEnd: 0, paused: false };
  is("once, paid: owed, with no date promised", owedNow(once, member, NOW), { owed: true, period: "once", from: ANCHOR, until: null });
  is("monthly, paid: owed for this month, until it ends", owedNow(monthly, member, NOW), { owed: true, period: `m${win?.from}`, from: win?.from, until: win?.until });
  is("in a free trial: not owed yet", [owedNow(once, { ...member, status: "trialing" }, NOW), owedNow(monthly, { ...member, status: "trialing" }, NOW)], [{ owed: false, why: "trial" }, { owed: false, why: "trial" }]);
  is("a payment being retried: the one-time benefit was paid for, this month is not yet", [owedNow(once, { ...member, status: "past_due" }, NOW).owed, owedNow(monthly, { ...member, status: "past_due" }, NOW)], [true, { owed: false, why: "unpaid" }]);
  is("paused: no monthly benefit while paused", owedNow(monthly, { ...member, paused: true }, NOW), { owed: false, why: "paused" });
  is("another membership's benefit is not this member's", owedNow(once, { ...member, product: "p2" }, NOW), { owed: false, why: "none" });
  is("retired before the member joined: not owed", owedNow({ ...once, retired: ANCHOR - 1 }, member, NOW), { owed: false, why: "retired" });
  is("retired after they joined: still owed", owedNow({ ...once, retired: ANCHOR + 1 }, member, NOW).owed, true);
  is("monthly, retired before this month began: not owed", owedNow({ ...monthly, retired: (win?.from ?? 0) - 1 }, member, NOW), { owed: false, why: "retired" });
  is("monthly, retired: a member still in a free trial will never be owed it, so is not counted as waiting", owedNow({ ...monthly, retired: NOW - DAY }, { ...member, status: "trialing", anchor: NOW + 5 * DAY }, NOW), { owed: false, why: "retired" });
  is("monthly, added after this month ended cannot be owed for it", owedNow({ ...monthly, since: NOW + DAY }, member, NOW), { owed: false, why: "before" });

  part("Defining benefits on a membership");
  redis.clear();
  const owner = "benefits@example.com";
  await claimHandle(owner, "benefitstore", "Benefit Store", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1Benefitxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const monthlyPlan = { interval: "month" as const, trialDays: 0, payments: 0 };
  const basic = await addProduct(owner, "Basic", "", "10", monthlyPlan);
  const pro = await addProduct(owner, "Pro", "", "20", monthlyPlan);
  const book = await addProduct(owner, "A book", "", "15", null);
  if (!basic.ok || !pro.ok || !book.ok) throw new Error("no products");
  products = { basic: basic.product.id, pro: pro.product.id, book: book.product.id };
  let store = (await storeForEmail(owner))!;
  is("none yet: an empty list, read", await readBenefits(store), []);
  is("only on a membership", await addBenefit(store, { product: products.book, text: "A print", cadence: "once" }, NOW * 1000), { ok: false, reason: "product" });
  is("words too long are refused, never cut", await addBenefit(store, { product: products.basic, text: "x".repeat(MAX_BENEFIT_TEXT + 1), cadence: "once" }, NOW * 1000), { ok: false, reason: "text" });
  is("once or monthly only", await addBenefit(store, { product: products.basic, text: "A print", cadence: "weekly" }, NOW * 1000), { ok: false, reason: "cadence" });
  const print = await addBenefit(store, { product: products.basic, text: "A signed print", cadence: "once" }, (ANCHOR - DAY) * 1000);
  const call = await addBenefit(store, { product: products.basic, text: "A monthly call", cadence: "monthly" }, (ANCHOR - DAY + 1) * 1000);
  if (!print.ok || !call.ok) throw new Error("benefits not added");
  for (let i = 0; i < MAX_BENEFITS_PER_TIER - 2; i += 1) await addBenefit(store, { product: products.pro, text: `Extra ${i}`, cadence: "once" }, NOW * 1000);
  await addBenefit(store, { product: products.pro, text: "Extra 3", cadence: "once" }, NOW * 1000);
  await addBenefit(store, { product: products.pro, text: "Extra 4", cadence: "once" }, NOW * 1000);
  is(`at most ${MAX_BENEFITS_PER_TIER} running on one membership`, await addBenefit(store, { product: products.pro, text: "One too many", cadence: "once" }, NOW * 1000), { ok: false, reason: "full_tier" });
  const kept = await readBenefits(store);
  is("each kept with its membership, its words, how often and since when", kept?.filter((b) => b.product === products.basic).map((b) => [b.text, b.cadence, b.since, b.retired]), [["A signed print", "once", ANCHOR - DAY, 0], ["A monthly call", "monthly", ANCHOR - DAY + 1, 0]]);

  part("Who is still waiting");
  store = (await storeForEmail(owner))!;
  stripeCalls = 0;
  const due = await benefitsDue(store, NOW * 1000);
  if (due.state !== "ok") throw new Error(`not read: ${due.state}`);
  const rowsOf = (id: string) => due.rows.filter((r) => r.benefit === id).map((r) => [r.sub, r.email, r.period, r.until, r.given]);
  is("the signed print: the paid member, and the one whose renewal is being retried; never the trial, another store's, a payment plan or an ended one", rowsOf(print.benefit.id), [
    ["sub_active00001", "ann@example.com", "once", null, null],
    ["sub_pastdue0001", "cal@example.com", "once", null, null],
    ["sub_paused00001", "dee@example.com", "once", null, null],
  ]);
  is("the monthly call: only the paid member this month, until the month ends", rowsOf(call.benefit.id), [["sub_active00001", "ann@example.com", `m${win?.from}`, win?.until, null]]);
  is("who is not owed it yet, counted and said", due.waiting[call.benefit.id], { trial: 1, unpaid: 1, paused: 1 });
  is("read to its end", [due.complete, due.unreadable], [true, 0]);
  is("Stripe read in one page", stripeCalls, 1);

  part("Marking given, in bulk");
  const by = "team@example.com";
  const first = await giveBenefit(store, by, print.benefit.id, [{ sub: "sub_active00001", period: "once" }, { sub: "sub_pastdue0001", period: "once" }, { sub: "sub_trial000001", period: "once" }, { sub: "sub_nobody00001", period: "once" }], NOW * 1000);
  is("exactly what was done: two given, two not owed", first, { ok: true, given: 2, already: 0, notOwed: 2, unknown: 0 });
  const again = await giveBenefit(store, by, print.benefit.id, [{ sub: "sub_active00001", period: "once" }, { sub: "sub_pastdue0001", period: "once" }], NOW * 1000 + 5000);
  is("pressed again: nothing given twice, said as already given", again, { ok: true, given: 0, already: 2, notOwed: 0, unknown: 0 });
  is("a period that is not this month's is not owed", await giveBenefit(store, by, call.benefit.id, [{ sub: "sub_active00001", period: "m1700000000" }], NOW * 1000), { ok: true, given: 0, already: 0, notOwed: 1, unknown: 0 });
  is(`more than ${MAX_GIVE_AT_ONCE} at once is refused whole`, await giveBenefit(store, by, print.benefit.id, Array.from({ length: MAX_GIVE_AT_ONCE + 1 }, () => ({ sub: "sub_active00001", period: "once" })), NOW * 1000), { ok: false, reason: "too_many" });
  is("an unknown benefit is refused", await giveBenefit(store, by, "b999999999999", [{ sub: "sub_active00001", period: "once" }], NOW * 1000), { ok: false, reason: "missing" });
  const after = await benefitsDue(store, NOW * 1000);
  const ann = after.state === "ok" ? after.rows.find((r) => r.benefit === print.benefit.id && r.sub === "sub_active00001") : null;
  is("given, with when and by whom (the first press)", ann?.given, { at: NOW, by });

  part("Taking a mark back");
  is("undone", await undoGiven(store, print.benefit.id, "sub_active00001", "once", NOW * 1000), { ok: true, undone: true });
  is("undone again: nothing to take back, said so", await undoGiven(store, print.benefit.id, "sub_active00001", "once", NOW * 1000), { ok: true, undone: false });
  const undone = await benefitsDue(store, NOW * 1000);
  is("waiting again", undone.state === "ok" ? undone.rows.find((r) => r.benefit === print.benefit.id && r.sub === "sub_active00001")?.given : "x", null);

  part("What cannot be read is unknown, never nobody waiting and never given");
  mode = "error";
  is("Stripe down: unknown", (await benefitsDue(store, NOW * 1000)).state, "unknown");
  is("and nothing is marked", await giveBenefit(store, by, print.benefit.id, [{ sub: "sub_active00001", period: "once" }], NOW * 1000), { ok: false, reason: "stripe" });
  mode = "garbled";
  is("a list in another shape: unknown, not an empty list", (await benefitsDue(store, NOW * 1000)).state, "unknown");
  mode = "endless";
  stripeCalls = 0;
  const endless = await benefitsDue(store, NOW * 1000);
  is("more memberships than one reading takes: bounded, and said as incomplete", [endless.state, endless.state === "ok" ? endless.complete : null, stripeCalls], ["ok", false, 10]);
  mode = "ok";
  const real = redis.pipeline.bind(redis);
  const annKey = personKey(store.statsId!, "ann@example.com");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return commands.map((c, i) => (c[0] === "HGETALL" && String(c[1]).endsWith(annKey) ? { not: "a list" } : replies[i]));
  }) as typeof redis.pipeline;
  const blind = await benefitsDue(store, NOW * 1000);
  is("a person's marks unreadable: their rows say unknown", blind.state === "ok" ? blind.rows.filter((r) => r.sub === "sub_active00001").map((r) => r.given) : null, ["unknown", "unknown"]);
  is("and nothing is written for them", await giveBenefit(store, by, print.benefit.id, [{ sub: "sub_active00001", period: "once" }], NOW * 1000), { ok: true, given: 0, already: 0, notOwed: 0, unknown: 1 });
  redis.pipeline = real;
  await redis.pipeline([["HSET", `nl:tben:${store.statsId}`, "b123456789abc", "{not json"]]);
  is("a benefit that cannot be read: the list is unknown", [await readBenefits(store), (await benefitsDue(store, NOW * 1000)).state], [null, "unknown"]);
  await redis.pipeline([["HDEL", `nl:tben:${store.statsId}`, "b123456789abc"]]);

  part("Retiring a benefit keeps what was owed before");
  is("retired", await retireBenefit(store, call.benefit.id, NOW * 1000), { ok: true });
  const retired = await benefitsDue(store, NOW * 1000);
  is("this month began before it was retired: still owed", retired.state === "ok" ? retired.rows.filter((r) => r.benefit === call.benefit.id).length : -1, 1);
  const nextMonth = await benefitsDue(store, (NOW + 20 * DAY) * 1000);
  is("next month: no longer owed", nextMonth.state === "ok" ? nextMonth.rows.filter((r) => r.benefit === call.benefit.id).length : -1, 0);
  is("an unknown one is refused", await retireBenefit(store, "b999999999999", NOW * 1000), { ok: false, reason: "missing" });

  part("A deleted person's marks go with them");
  await giveBenefit(store, by, print.benefit.id, [{ sub: "sub_active00001", period: "once" }], NOW * 1000);
  is("forgotten", (await forgetBenefitPerson(store, annKey)) > 0, true);
  const gone = await benefitsDue(store, NOW * 1000);
  is("no mark left", gone.state === "ok" ? gone.rows.find((r) => r.benefit === print.benefit.id && r.sub === "sub_active00001")?.given : "x", null);
  is("the erasure runs it", ERASERS.some((e) => e.module === "lib/tier-benefits.ts"), true);
  is("and the creator is told", PERSON_DATA.some((p) => p.file === "lib/tier-benefits.ts" && p.how === "erased"), true);

  part("The studio and its door");
  const route = readFileSync("app/api/store/tier-benefits/route.ts", "utf8");
  is("defining needs the settings permission, marking the orders permission", [route.includes('"settings"'), route.includes('"orders"')], [true, true]);
  const lib = readFileSync("lib/tier-benefits.ts", "utf8");
  is("room taken before a mark is written", lib.indexOf("takeData(") > 0 && lib.indexOf("takeData(") < lib.indexOf('"HSETNX"'), true);
  is("Stripe read in its exact shape", lib.includes("readStripePage("), true);
  const page = readFileSync("app/studio/memberships/page.tsx", "utf8");
  is("the memberships page shows it", page.includes("<TierBenefits"), true);
  const component = readFileSync("components/tier-benefits.tsx", "utf8");
  is("a count and a confirmation before marking", [component.includes("Confirm"), component.includes('aria-live="polite"')], [true, true]);
  is("unknown said as unknown, never as all given", component.includes("could not be read"), true);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
