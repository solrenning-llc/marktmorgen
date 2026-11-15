import { windowId } from "@/lib/allowance-window";
/**
 * Posts drafted for an affiliate (lib/affiliate-kit.ts, added 11 October
 * 2026). What is checked:
 *
 *   - every post ends with the affiliate's own link to the product and the
 *     line saying they earn from it, in the store's language, whatever the
 *     model wrote, and an address the model wrote is taken out;
 *   - the model is told the product's page, the affiliate's note, and never
 *     to claim they used it without that note;
 *   - only an approved affiliate, on a product they earn on, while the
 *     creator allows it;
 *   - three a day each, and a quarter of the store's month for its
 *     affiliates together, each draft one of the store's own writing jobs;
 *     started attempts stay counted even when they fail.
 */
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setLanguage, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { draftKit, productAffiliateLink } from "@/lib/affiliate-kit";
import { DISCLOSURE, DISCLOSURE_SHORT, KIT_PER_DAY, finishPost, isDisclosed, kitMonthly } from "@/lib/affiliate-kit-rules";
import { aiAllowance, aiLeft } from "@/lib/ai";
import type { Affiliate } from "@/lib/affiliates";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let asked: { system: string; prompt: string }[] = [];
let answerWith: string | null = JSON.stringify({ x: "A week of dinners, planned. See https://evil.example/x", instagram: "Busy weeknights?\nThis helps.\n#dinner", linkedin: "Planning dinners for a family is work." });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.anthropic.com") {
    const body = JSON.parse(String(init?.body)) as { system: string; messages: { content: string }[] };
    asked.push({ system: body.system, prompt: body.messages[0].content });
    if (answerWith === null) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ content: [{ type: "text", text: answerWith }] }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
}) as typeof fetch;

const OWNER = "chef@example.com";
const affiliate = (over: Partial<Affiliate> = {}): Affiliate => ({ id: "aaaaaaaaaaaa", email: "fan@example.com", code: "fanlink", status: "approved", appliedAt: 1, decidedAt: 1, note: "", rate: null, paypal: "", share: null, cleared: null, by: null, ...over });

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_kit_only_a_stand_in";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-kit-only-a-stand-in-0000";

  part("Every post says it is an affiliate link, whatever was written");
  const finished = finishPost("Great for weeknights https://other.example/a\n\n\n\nTry it.", "https://marktmorgen.com/@chef/p/x?via=fan", DISCLOSURE.en);
  is("the model's address out, then the link, then the line", finished, "Great for weeknights \n\nTry it.\n\nhttps://marktmorgen.com/@chef/p/x?via=fan\nAffiliate link: I earn a commission if you buy through it.".replace("weeknights \n", "weeknights\n"));
  is("and it is checked for both", [isDisclosed(finished, "https://marktmorgen.com/@chef/p/x?via=fan", DISCLOSURE.en), isDisclosed("no link", "https://x", DISCLOSURE.en)], [true, false]);
  is("in every language a store speaks, the French with its space before the colon", [Object.keys(DISCLOSURE).length, DISCLOSURE.fr.includes(" :"), Object.keys(DISCLOSURE_SHORT).length], [7, true, 7]);

  part("Drafted for an approved affiliate");
  await claimHandle(OWNER, "chef", "Chef Ana", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestChef000001", true);
  await setSubscription(OWNER, { customerId: "cus_Chef00001", subscriptionId: "sub_Chef00001", active: true, tier: "pro", period: paidPeriod() });
  await setLanguage(OWNER, "es");
  const plan = await addProduct(OWNER, "Weeknight Plan", "Thirty dinners in thirty minutes.", "29", null);
  const out = await addProduct(OWNER, "Left Out", "", "10", null);
  if (!plan.ok || !out.ok) throw new Error("no product");
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ enabled: true, percent: 30, days: 30, rates: { [out.product.id]: 0 } }));
  let store = (await storeForEmail(OWNER))!;
  const before = await aiLeft(store);
  const result = await draftKit(store, affiliate(), plan.product.id, "My followers are busy parents; I have cooked from it for a month.");
  const link = productAffiliateLink(store, plan.product, "fanlink");
  const urls = result.ok ? Object.values(result.posts).map(post => new URL(post.match(/https:\/\/\S+/)?.[0] ?? "")) : [];
  is("each drafted post identifies its channel and affiliate", urls.map(url => [url.searchParams.get("utm_source"),url.searchParams.get("via")]), [["x","fanlink"],["instagram","fanlink"],["linkedin","fanlink"]]);
  is("one kit identifies its post variants without buyer identifiers", urls.length === 3 && new Set(urls.map(url => url.searchParams.get("utm_content"))).size === 1 && urls.every(url => /^kit-[a-f0-9]{32}$/.test(url.searchParams.get("utm_content") ?? "")), true);
  is("three posts, each with the link to the product and the line in the store's language", [
    result.ok,
    result.ok && link.includes("/p/") && link.endsWith("?via=fanlink"),
    result.ok && isDisclosed(result.posts.x, link, DISCLOSURE_SHORT.es),
    result.ok && isDisclosed(result.posts.instagram, link, DISCLOSURE.es),
    result.ok && isDisclosed(result.posts.linkedin, link, DISCLOSURE.es),
    result.ok && !result.posts.x.includes("evil.example"),
  ], [true, true, true, true, true, true]);
  is("the model was given the page, the note, and the rules", [
    asked[0].prompt.includes("Weeknight Plan"),
    asked[0].prompt.includes("I have cooked from it for a month"),
    asked[0].system.includes("Never say or suggest the affiliate bought, used or tried the product"),
    asked[0].system.includes("Spanish"),
  ], [true, true, true, true]);
  is("one of the store's writing jobs for the month", (await aiLeft(store)) , before - 1);
  asked = [];
  const secondKit = await draftKit(store, affiliate(), plan.product.id, "");
  is("a different kit has a different post identifier", secondKit.ok && !secondKit.posts.x.includes(urls[0].searchParams.get("utm_content") ?? "no-variant"), true);
  is("with no note, it is told to say nothing about having used it", asked[0]?.prompt.includes("say nothing about having used it"), true);

  part("Only where it should");
  is("not a product left out of the program", (await draftKit(store, affiliate(), out.product.id, "")).ok ? "drafted" : "refused", "refused");
  is("not a product that is not the store's", (await draftKit(store, affiliate(), "nosuchproduct", "")).ok ? "drafted" : "refused", "refused");
  is("not an affiliate still waiting", (await draftKit(store, affiliate({ status: "pending" }), plan.product.id, "")).ok ? "drafted" : "refused", "refused");
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ enabled: true, percent: 30, days: 30, rates: { [out.product.id]: 0 }, kit: false }));
  store = (await storeForEmail(OWNER))!;
  is("not when the creator switched it off", (await draftKit(store, affiliate(), plan.product.id, "")).ok ? "drafted" : "refused", "refused");
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ enabled: true, percent: 30, days: 30, rates: { [out.product.id]: 0 } }));
  store = (await storeForEmail(OWNER))!;
  is("on unless switched off, on programs saved before it existed too", parseAffiliateSetting({ enabled: true }).kit, true);

  answerWith = null;
  const beforeFail = await aiLeft(store);
  const failed = await draftKit(store, affiliate({ id: "cccccccccccc", code: "failer" }), plan.product.id, "");
  is("a failed attempt stays reserved against the store month", [failed.ok ? "drafted" : failed.reason, await aiLeft(store)], ["failed", beforeFail - 1]);
  answerWith = JSON.stringify({ x: "A week of dinners, planned.", instagram: "Busy weeknights?", linkedin: "Planning dinners is work." });

  part("Within limits");
  const third = await draftKit(store, affiliate(), plan.product.id, "");
  const fourth = await draftKit(store, affiliate(), plan.product.id, "");
  is(`${KIT_PER_DAY} a day for one affiliate`, [third.ok, fourth.ok ? "drafted" : fourth.reason], [true, "day"]);
  const quarter = kitMonthly(aiAllowance(store));
  let other = 0;
  let last = "";
  for (let i = 0; i < 40; i += 1) {
    const r = await draftKit(store, affiliate({ id: `b${String(i).padStart(11, "0")}`, code: `other${i}` }), plan.product.id, "");
    if (r.ok) other += 1;
    else {
      last = r.reason;
      if (r.reason === "month") break;
    }
  }
  is("a quarter of the store's month for its affiliates together, then no more", [4 + other, last], [quarter, "month"]);
  is("a quarter is at least a few drafts on the smallest allowance", kitMonthly(20) >= 5, true);

  part("New affiliate drafts use the funded resource boundary before consuming writing jobs");
  await setSubscription(OWNER, { customerId: "cus_Chef00001", subscriptionId: "sub_Chef00001", active: true, tier: "pro", period: { ...paidPeriod(), funded: true } });
  const fundedKitStore = (await storeForEmail(OWNER))!;
  const beforeFundedKitJobs = await aiLeft(fundedKitStore);
  const beforeFundedKitCalls = asked.length;
  // The keys and the draft read one moment, so a run across 00:00 UTC cannot read yesterday's counter while the draft writes today's.
  const kitNow = new Date();
  const kitCounterKeys = [`nl:affkit:${fundedKitStore.statsId}:dddddddddddd:${kitNow.toISOString().slice(0, 10)}`, `nl:affkit:${fundedKitStore.statsId}:${windowId(fundedKitStore, kitNow.getTime())}`];
  const beforeKitCounters = await redis.pipeline(kitCounterKeys.map((key) => ["GET", key]));
  const deniedKit = await draftKit(fundedKitStore, affiliate({ id: "dddddddddddd", code: "funded" }), plan.product.id, "Synthetic note only", kitNow);
  is("missing resource funding refuses before model calls or kit and writing counters",
    [deniedKit.ok ? "" : deniedKit.reason, asked.length, await aiLeft(fundedKitStore), await redis.pipeline(kitCounterKeys.map((key) => ["GET", key]))],
    ["unavailable", beforeFundedKitCalls, beforeFundedKitJobs, beforeKitCounters]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
