// Fixture reused from immutable CX1 proof 711c03e0; separate state-consistency assertions.
import { readPlanRefund } from "@/lib/plan-refund";
import { refundPlanPayment } from "@/lib/plan-refund-write";
import { REFUND_DAYS } from "@/lib/plan";
import { store as redis } from "./redis-stub";
import { NOW, DAY, paidShop, world } from "./plan-refund-stripe-world";
import { is, done } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cx1_synthetic_fixture_only";
const transport = globalThis.fetch;

function reset() {
  redis.clear();
  world.customers.clear(); world.subs.clear(); world.replies.clear();
  world.invoices = []; world.charges = []; world.refunds = []; world.calls = [];
}

async function main() {
  let index = 0;
  for (const side of ["same-customer", "same-email-customer"]) {
    for (const evidence of [
      { label: "succeeded-but-unpaid", status: "succeeded", paid: false, invalid: true },
      { label: "succeeded-control", status: "succeeded", paid: true, invalid: false },
      { label: "failed-control", status: "failed", paid: false, invalid: false },
    ]) {
      reset(); index++;
      const shop = await paidShop();
      const store = await shop.store();
      const current = world.charges[0];
      const other = `cus_prior${index}0001`;
      const customer = side === "same-customer" ? store.stripeCustomerId! : other;
      const { status, paid, invalid, label } = evidence;
      // Except the failed control, the ledger has a prior successful payment. Only returned paid is false in the contradictory case.
      const prior = { ...current, id: `ch_prior${index}0001`, invoice: `in_prior${index}0001`, payment_intent: `pi_prior${index}0001`, customer,
        created: NOW - (REFUND_DAYS + 10) * DAY, status: label === "failed-control" ? "failed" : "succeeded", paid: label !== "failed-control" };
      world.charges.push(prior);
      if (side === "same-email-customer") world.customers.set(other, store.email);
      let hit = 0;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        const path = url.pathname.replace(/^\/v1/, "");
        if ((init?.method ?? "GET") === "GET" && path === "/customers/search" && side === "same-email-customer") {
          return Response.json({ object: "search_result", has_more: false, data: [
            { id: store.stripeCustomerId, email: store.email }, { id: other, email: store.email },
          ] });
        }
        if ((init?.method ?? "GET") === "GET" && path === "/charges" && url.searchParams.get("customer") === customer) {
          hit++;
          const records = world.charges.filter(c => c.customer === customer).map(c => c.id === prior.id ? { ...c, status, paid } : c);
          return Response.json({ object: "list", has_more: false, data: records });
        }
        return transport(input, init);
      }) as typeof fetch;
      const reading = await readPlanRefund(store, NOW);
      const written = await refundPlanPayment(store, NOW);
      globalThis.fetch = transport;
      if (hit !== 2) throw new Error(`Expected the history injection in both reader calls, got ${hit}`);
      const expected = invalid ? ["unknown", false, 0] : status === "succeeded" ? ["none", false, 0] : ["guarantee", true, 1];
      is(`${side}/${label}: contradictory history cannot authorize a refund`,
        [reading.refund.kind, written.ok, shop.allRefunds().length], expected);
    }
  }
  done();
}
main().catch(error => { globalThis.fetch = transport; console.error(error); process.exitCode = 1; });
