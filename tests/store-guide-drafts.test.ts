/**
 * The store page's guide (app/api/store/guide/route.ts) is given the store's
 * first GUIDE_PRODUCTS published products. It took the first
 * GUIDE_PRODUCTS * 2 ids of the whole catalog, drafts included, and only then
 * left the drafts out, so a store whose first products are drafts handed the
 * model fewer published products than it lists, or none: a visitor asking
 * what fits was told nothing fit while the store sells it (claude7/catalog-hunt,
 * 13 November 2026). The model is a stand-in for `fetch`; synthetic store.
 */
import { NextRequest } from "next/server";
import { POST as guide } from "@/app/api/store/guide/route";
import { GUIDE_PRODUCTS } from "@/lib/store-guide";
import { addProduct, claimHandle, ensureStatsId, setAnswers, setProductHidden, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { canSell } from "@/lib/store-checkout";
import { answersOn } from "@/lib/answers";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const told: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.anthropic.com") {
    const body = JSON.parse(String(init?.body)) as { system: string; messages: { content: string }[] };
    told.push(`${body.system}\n${body.messages.map((m) => m.content).join("\n")}`);
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ picks: [{ n: 1, why: "It fits." }] }) }] }));
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  process.env.STRIPE_SECRET_KEY = "sk_test_guide_drafts_stand_in";
  const owner = "guide-drafts@example.com";
  await claimHandle(owner, "guidedrafts", "Guide Drafts", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_GuideDraft01", subscriptionId: "sub_GuideDraft01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await setStripeAccount(owner, "acct_1GuideDrafts01", true);
  await setAnswers(owner, { on: true, facts: "" });
  // The creator's first products are drafts, as many as the route read; the published ones come after them.
  for (let n = 1; n <= GUIDE_PRODUCTS * 2; n++) {
    const made = await addProduct(owner, `Draft ${n}`, "Not out yet.", "9", null);
    if (!made.ok) throw new Error("draft fixture");
    await setProductHidden(owner, made.product.id, true);
  }
  for (const title of ["Sourdough Basics", "Pastry Lab"]) {
    if (!(await addProduct(owner, title, "A published course.", "29", null)).ok) throw new Error("product fixture");
  }

  part("Drafts first in the catalog");
  const store = (await storeForEmail(owner))!;
  is("control: the store sells and its answers are on", [canSell(store), answersOn(store)], [true, true]);
  const answer = await guide(new NextRequest("https://marktmorgen.com/api/store/guide", {
    method: "POST",
    headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json" },
    body: JSON.stringify({ handle: "guidedrafts", goal: "learn to bake bread" }),
  }));
  const body = (await answer.json()) as { ok: boolean; error?: string; picks?: { title: string }[] };
  is("the model is told the published products, and never a draft", [told.length, told.some((t) => t.includes("Sourdough Basics") && t.includes("Pastry Lab")), told.some((t) => t.includes("Draft 1"))], [1, true, false]);
  is("and a published product is picked", [body.ok, body.picks?.map((p) => p.title)], [true, ["Sourdough Basics"]]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
