/** Codex M focal #2900 edge, derived from Claude6 canonical def324e527ba4627af90b4d5cafef09264e78a89.
 * Keeps the actual page, MemoryRedis, trial boundary and transport; only pre-aligns the token platforms.
 * Four independent control assertions; no product changes or provider network calls. */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { isValidElement } from "react";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setAdsServer, setAssistantPlan, setPixels, setSubscription, storeForEmail } from "@/lib/store";
import { NO_PIXELS } from "@/lib/pixels";
import StudioPage from "@/app/studio/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const hex = (value: string) => createHash("sha256").update(value).digest("hex");
async function words(node: unknown, found: string[] = [], seen = new Set<unknown>()): Promise<string[]> {
  if (typeof node === "string") {
    found.push(node);
    return found;
  }
  if (!node || typeof node !== "object" || seen.has(node)) return found;
  seen.add(node);
  if (typeof (node as PromiseLike<unknown>).then === "function") return words(await node, found, seen);
  if (Array.isArray(node)) {
    for (const child of node) await words(child, found, seen);
    return found;
  }
  if (isValidElement(node)) await words((node.props as { children?: unknown }).children, found, seen);
  return found;
}

async function main(): Promise<void> {
  redis.clear();
  part("Today's store writes, when the billing month is read again during the visit");
  const FOURTH = "today-write-aligned@example.com";
  await claimHandle(FOURTH, "todaywritealigned", "Today write order", "");
  const statsId = (await ensureStatsId(FOURTH))?.statsId;
  if (!statsId) throw new Error("setup: statsId");
  // A first page of free products, so the two paid ones are read from their records (lib/cart-link-products.ts):
  // only then is the count taken.
  for (let i = 0; i < 24; i += 1) await addProduct(FOURTH, `Free ${i}`, "", "0", null);
  await addProduct(FOURTH, "Paid one", "", "19", null);
  await addProduct(FOURTH, "Paid two", "", "29", null);
  await setPixels(FOURTH, { ...NO_PIXELS, meta: "123456789012345" });
  // Only difference in this control: the platform list is already aligned.
  await setAdsServer(FOURTH, ["meta"]);
  await redis.pipeline([["SET", `nl:adsrv:${statsId}`, JSON.stringify({ meta: "synthetic-sealed-token" })]]);
  const realNow = Date.now;
  const startS = Math.floor(realNow() / 1000);
  await setSubscription(FOURTH, { customerId: "cus_TodayOrder01", subscriptionId: "sub_TodayOrder01", active: true, tier: "creator", trialEnds: startS + 60 });
  await setAssistantPlan(FOURTH, { subscriptionId: "sub_TodayAssist01", active: true, period: { start: startS - 40 * 86_400, end: startS - 10 * 86_400, renews: true }, cancelsAtEnd: false, disputedAt: "" });
  const fourthSession = await openSession(FOURTH);
  const ownerKey = `nl:store:owner:${hex(`nimbus-store:${FOURTH}`).slice(0, 40)}`;
  const groups: Record<string, string[]> = { plan: ["subscriptionActive", "trialEnds", "period"], ads: ["adsServer"], assistant: ["assistantPlan"] };
  const fieldsOf = (raw: unknown) => {
    const record = JSON.parse(String(raw)) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(groups).map(([name, keys]) => [name, JSON.stringify(keys.map((k) => record[k] ?? null))]));
  };
  const keptPipeline = redis.pipeline;
  let seen = fieldsOf((await keptPipeline.call(redis, [["GET", ownerKey]]))[0]);
  const writes: string[] = [];
  let shifted = false;
  let offset = 0;
  Date.now = () => realNow() + offset;
  redis.pipeline = async (commands) => {
    // The cart link's first read (lib/cart-link-products.ts weigh): from here on the trial has ended.
    if (!shifted && commands.some((c) => c[0] === "HMGET" && String(c[2] ?? "").startsWith("p:"))) {
      shifted = true;
      offset = 120_000;
    }
    // Each trip takes a while, as over a real network: a part with fewer trips before its write reaches the lock first.
    await new Promise((wait) => setTimeout(wait, 5));
    const reply = await keptPipeline.call(redis, commands);
    if (commands.some((c) => c[0] !== "GET" && c[0] !== "MGET" && c[0] !== "HMGET" && c[0] !== "HGETALL" && c[0] !== "STRLEN")) {
      const now = fieldsOf((await keptPipeline.call(redis, [["GET", ownerKey]]))[0]);
      // Counted from the cart link's first read: what the page's own loading wrote before it is not a part's write.
      for (const name of Object.keys(groups)) if (shifted && now[name] !== seen[name]) writes.push(name);
      seen = now;
    }
    return reply;
  };
  const stripePeriod = { current_period_start: startS + 60, current_period_end: startS + 60 + 30 * 86_400 };
  const keptFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.stripe.com") throw new Error("Unexpected external request: " + url.hostname);
    const method = init?.method ?? "GET";
    // Still in its trial when the page loads (so the page's own sync writes no billing month), paid once it ended.
    if (method === "GET" && url.pathname === "/v1/subscriptions/sub_TodayOrder01")
      return Response.json(
        shifted
          ? { id: "sub_TodayOrder01", status: "active", cancel_at_period_end: false, items: { data: [stripePeriod] } }
          : { id: "sub_TodayOrder01", status: "trialing", trial_end: startS + 60, cancel_at_period_end: false, items: { data: [{ current_period_start: startS - 86_400, current_period_end: startS + 60 }] } },
      );
    if (method === "GET" && url.pathname === "/v1/subscriptions/sub_TodayAssist01") return Response.json({ id: "sub_TodayAssist01", status: "active", cancel_at_period_end: false, items: { data: [stripePeriod] } });
    if (method === "GET") return Response.json({ object: "list", data: [], has_more: false });
    throw new Error("Unexpected provider operation: " + method + " " + url.pathname);
  }) as typeof fetch;
  const keptKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_today_write_order_only";
  answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${fourthSession}` } }));
  try {
    await words(await StudioPage({ searchParams: Promise.resolve({}) }));
  } finally {
    redis.pipeline = keptPipeline;
    globalThis.fetch = keptFetch;
    Date.now = realNow;
    if (keptKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = keptKey;
    answering(null);
  }
  is("the trial ended during the visit, at the cart link's first read", shifted, true);
  is("the billing month and add-on month are each written once; aligned platforms are untouched", [...writes].sort(), ["assistant", "plan"]);
  is("in the order Today wrote them one section after another", writes, ["plan", "assistant"]);
  const after = await storeForEmail(FOURTH);
  is("and each is in the store", [after?.trialEnds, after?.adsServer, after?.assistantPlan?.period?.end], [0, ["meta"], stripePeriod.current_period_end]);
  done();
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
