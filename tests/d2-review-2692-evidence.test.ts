import { partsOutcome, refundAndEndPlan, finishPlanRefunds } from "@/lib/plan-refund-flow";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { DAY, NOW, paidShop, world } from "./plan-refund-stripe-world";

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_d2_review_only";
  const fetchBefore = globalThis.fetch;
  const sid = "synthetic-d2-refund-store";
  const charges = ["ch_D2Evidence001", "ch_D2Evidence002"];
  const refund = { id: "re_D2Evidence001", amount: 123, currency: "usd", status: "succeeded", metadata: { plan_refund: sid } };
  let unique = true;
  let reads = 0;
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if ((init?.method ?? "GET") !== "GET") { writes++; throw Error("No provider writes in the direct reader proof"); }
    reads++;
    const index = charges.indexOf(url.searchParams.get("charge") ?? "");
    const row = { ...refund, charge: charges[index], id: unique && index === 1 ? "re_D2Evidence002" : refund.id };
    return new Response(JSON.stringify({ data: [row], has_more: false }), { status: 200 });
  };
  try {
    part("Distinct refunds can cover distinct noted charges");
    const good = await partsOutcome(sid, charges.map(c => ({ c, a: 123 })));
    is("two unique refunds are settled", good.kind === "found" && [good.refund.amount, good.settled], [246, true]);
    unique = false;
    part("One refund id cannot be evidence for two different charges");
    const duplicate = await partsOutcome(sid, charges.map(c => ({ c, a: 123 })));
    is("duplicate refund across charge pages is unknown", duplicate.kind, "unknown");
    is("bounded reader calls and no writes", [reads, writes], [4, 0]);
  } finally { globalThis.fetch = fetchBefore; }

  part("The real daily settlement must retain a partially refunded plan");
  const half = await paidShop({ at: NOW - 20 * DAY });
  half.addPayment(NOW - 2 * DAY);
  world.refundsLeft = 1;
  try { await refundAndEndPlan(await half.store(), NOW); }
  finally { world.refundsLeft = null; }
  is("setup: only one of two payments refunded, plan still active", [half.allRefunds().length, half.sub().status, typeof await half.note()], [1, "active", "string"]);
  await finishPlanRefunds(Date.now() + 10_000, NOW + 3_600);
  is("honest charge pages preserve the partial plan and note", [half.sub().status, typeof await half.note()], ["active", "string"]);
  const only = half.allRefunds()[0];
  let replayedReads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if ((init?.method ?? "GET") === "GET" && url.pathname === "/v1/refunds" && url.searchParams.has("charge")) {
      replayedReads++;
      return new Response(JSON.stringify({ data: [{ ...only, charge: url.searchParams.get("charge") }], has_more: false }), { status: 200 });
    }
    return fetchBefore(input, init);
  };
  try {
    await finishPlanRefunds(Date.now() + 10_000, NOW + 3_601);
    is("replayed refund id does not end the real subscription", half.sub().status, "active");
    is("the undecidable note remains", typeof await half.note(), "string");
    is("no additional refund was made", half.allRefunds().length, 1);
    is("exactly two charge pages were read", replayedReads, 2);
  } finally { globalThis.fetch = fetchBefore; }
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
