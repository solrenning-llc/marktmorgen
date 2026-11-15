/**
 * 219 [OP5], unit 7: after the creator keeps the AI's first draft of the store,
 * the studio says what is still missing before anything can sell, each with a
 * link to its step (lib/store-setup-rules.ts, setupSteps; lib/store-setup.ts,
 * keepStoreSetupWithSteps). Nothing goes live by itself: every kept product is
 * a hidden draft until the creator adds what it hands over and chooses Publish.
 * Synthetic only: the in-memory Redis double, no Stripe or model call.
 */
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { keepStoreSetupWithSteps } from "@/lib/store-setup";
import { SETUP_STRIPE_STEP, setupSteps } from "@/lib/store-setup-rules";
import { KIND } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

async function main(): Promise<void> {
  part("The steps, worked out from the drafts and the Stripe connection");
  is("nothing kept: nothing to do", setupSteps({ stripeReady: false, drafts: [] }), []);
  const two = setupSteps({ stripeReady: false, drafts: [{ id: "p1", title: "Sunday Meal Planner", priceCents: 1200 }, { id: "p2", title: "Free checklist", priceCents: 0 }] });
  is("a paid draft and no Stripe: Stripe first, then each draft by name, in order", two.map((step) => step.id), ["stripe", "product:p1", "product:p2"]);
  is("Stripe's step goes to the studio's Stripe section", [two[0].href, two[0].label], [SETUP_STRIPE_STEP.href, SETUP_STRIPE_STEP.label]);
  is("a draft's step names it and goes to it in the studio's products", [two[1].label, two[1].href], ['Add what "Sunday Meal Planner" hands over, then choose Publish', "/studio?q=Sunday%20Meal%20Planner#products"]);
  is("only free drafts: no Stripe step, a free product needs no payments", setupSteps({ stripeReady: false, drafts: [{ id: "p2", title: "Free checklist", priceCents: 0 }] }).map((step) => step.id), ["product:p2"]);
  is("Stripe ready: no Stripe step", setupSteps({ stripeReady: true, drafts: [{ id: "p1", title: "Planner", priceCents: 1200 }] }).map((step) => step.id), ["product:p1"]);
  const long = "A".repeat(200);
  is("a long title is searched by its first 80 characters", setupSteps({ stripeReady: true, drafts: [{ id: "p9", title: long, priceCents: 0 }] })[0].href, `/studio?q=${"A".repeat(80)}#products`);

  part("Keeping the draft answers the steps with what was kept");
  redis.clear();
  const owner = "setup-steps@example.com";
  await claimHandle(owner, "setupsteps", "Setup Steps", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_setupsteps", subscriptionId: "sub_setupsteps", active: true, tier: "pro", period: paidPeriod() });
  const kept = await keepStoreSetupWithSteps(owner, (await storeForEmail(owner))!, {
    products: [
      { title: "Sunday Meal Planner", summary: "A week of dinners.", kind: "download", price: "12" },
      { title: "Free?", summary: "", kind: "download", price: "abc" },
    ],
  });
  const store = (await storeForEmail(owner))!;
  const planner = store.catalog.items[0];
  is("the kept count is the same as before", [kept.done.products, kept.done.refused], [1, ["Free?"]]);
  is("no Stripe yet: connect it, then the kept product, never the refused one", kept.steps.map((step) => step.id), ["stripe", `product:${planner.id}`]);
  is("and the product is still a hidden draft: nothing went live", (planner.kind & KIND.hidden) !== 0, true);

  await setStripeAccount(owner, "acct_TestSetupStep1", true);
  const again = await keepStoreSetupWithSteps(owner, (await storeForEmail(owner))!, { products: [{ title: "Menu Club", summary: "", kind: "membership", price: "7" }] });
  is("a Stripe account that takes payments: only the product's step", again.steps.map((step) => step.id.split(":")[0]), ["product"]);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
