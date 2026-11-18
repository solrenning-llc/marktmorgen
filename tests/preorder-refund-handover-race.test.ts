/**
 * A pre-order refunded while it is being handed over is taken back, never kept with the refund.
 *
 * handOverPreorder reads the entry, grants the product, emails the way in and then writes the entry back with
 * `given`, from what it read. The refund pass (revokeRefundedPreorders) read the same entry, wrote it back with
 * `revoked` and marked the refund handled, without the hand-over's giving mark. Interleaved, the hand-over's
 * write landed last: `revoked` was gone, the grant stood, and the refund, already marked handled, was never read
 * again. The buyer kept the product and the money (Claude 7, Redis race hunt).
 *
 * Now the refund pass takes the same giving mark the hand-over holds: while a hand-over runs, the refund is left
 * unread and the next run takes back what the hand-over gave.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { importedFor } from "@/lib/imported-purchases";
import { confirmPreorder, readPreorder, revokeRefundedPreorders } from "@/lib/preorders";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000);
const PI = "pi_racepre00000001";
let refunds: Record<string, unknown>[] = [];
/** When set, the way-in email's link waits for it: the hand-over is held between its grant and its "given" write. */
let gate: Promise<void> | null = null;
let reached: () => void = () => {};
const atEmail = new Promise<void>((resolve) => {
  reached = resolve;
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/refunds") return answer({ object: "list", data: refunds, has_more: false });
  if (path === "/events") return answer({ object: "list", data: [], has_more: false });
  if (path.startsWith("/payment_intents/")) {
    return answer({ id: path.split("/")[2], object: "payment_intent", latest_charge: { object: "charge", refunded: false, amount: 2500, amount_refunded: 0 } });
  }
  return answer({ error: { message: `no stand-in for ${init?.method ?? "GET"} ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_race_refunds_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_race_refunds_only";

  await claimHandle("owner@race.example", "raceshop", "Race Shop", "");
  await ensureStatsId("owner@race.example");
  await setStripeAccount("owner@race.example", "acct_1TestRacePre001", true);
  await setSubscription("owner@race.example", { customerId: "cus_RaceOwner01", subscriptionId: "sub_RaceOwner01", active: true, period: paidPeriod() });
  const made = await addProduct("owner@race.example", "Bread Course", "", "25", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@race.example", made.product.id, "https://example.com/course");
  const store = (await storeForEmail("owner@race.example"))!;
  const product = (await readListing(store, made.product.id))!;
  const deps = {
    base: "https://marktmorgen.com/@raceshop",
    from: '"Race Shop" <hello@marktmorgen.com>',
    // Asked for the way-in email's link, after the grant and before the "given" write: the hand-over waits here.
    ordersLink: async () => {
      if (gate) {
        reached();
        await gate;
      }
      return null;
    },
    recordStart: async () => {},
  };
  const email = "buyer@race.example";
  const session = {
    id: "cs_test_racepre00000001",
    created: NOW - 600,
    status: "complete",
    payment_status: "paid",
    amount_total: 2500,
    currency: "usd",
    payment_intent: PI,
    metadata: { store: "raceshop", product: product.id, preorder: "yes" },
    customer_details: { email },
  };
  const holds = async () => (await importedFor((await storeForEmail("owner@race.example")) as Store, email)).length > 0;
  const revoke = () => revokeRefundedPreorders(store, Date.now() + 60_000, async () => {});

  // The hand-over starts and is held at its email, after the grant and before its "given" write.
  let open: () => void = () => {};
  gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const handing = confirmPreorder(store, session as never, product, deps);
  await atEmail;
  is("held at the email: the grant already stands", await holds(), true);

  // The buyer is refunded in full meanwhile, and the refund pass runs to its end.
  refunds = [{ id: "re_racepre000001", object: "refund", created: NOW - 60, status: "succeeded", payment_intent: PI, charge: { object: "charge", refunded: true } }];
  await revoke();

  // The hand-over goes on and finishes.
  gate = null;
  open();
  await handing.catch(() => "threw");

  // Whatever order they ran in, the next refund run settles it: the refund is never left with the product.
  await revoke();
  const entry = await readPreorder(store, product.id, session.id);
  is("the refunded pre-order is marked revoked", Boolean(entry?.revoked), true);
  is("the refunded buyer no longer holds the product", await holds(), false);
  done();
}

void main();
