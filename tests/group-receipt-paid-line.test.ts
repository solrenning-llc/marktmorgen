/**
 * #4705, the group part (Codex X8): a receipt for several places written from a checkout whose total did not come
 * printed the catalog price times the places as "Paid", and one whose currency did not come printed the amount in the
 * store's currency. The receipt and its link to hand out the places still go; the "Paid" line is written only from the
 * amount and currency Stripe returned. Synthetic Stripe, Resend and Redis.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { settleGroup, startGroup } from "@/lib/group-buy";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { to: string[]; subject: string; text: string };
const emails: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: `email_${emails.length}` }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/refunds") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

const BASE = "https://marktmorgen.com/@harbor";
const FROM = '"Harbor Kitchen" <hello@marktmorgen.com>';
const lastTo = (to: string) => emails.filter((e) => e.to[0] === to).at(-1);
const paidLine = (to: string) => lastTo(to)?.text.match(/^Paid: .*$/m)?.[0] ?? "(no Paid line)";

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_group_receipt_paid_line";
  process.env.RESEND_API_KEY = "re_test_gifts_only"; // a synthetic key already listed in tests/resend-fixture-credentials.ts
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "Pantry Checklist", "", "9", null); // the catalog price is $9
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@example.com", made.product.id, "https://example.com/pantry");
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;

  const group = async (n: number, over: Record<string, unknown>) => {
    const started = await startGroup(store, product, "2");
    if (!started.ok) throw new Error("no group");
    const session = {
      id: `cs_test_${String(n).repeat(24)}`,
      created: 1_900_000_000,
      amount_total: 1600,
      currency: "usd",
      payment_intent: `pi_GroupPaid000${n}`,
      status: "complete",
      payment_status: "paid",
      metadata: { store: "harbor", product: product.id, group: started.group.id, people: "2" },
      customer_details: { email: `buyer${n}@example.com` },
      ...over,
    };
    await settleGroup({ store, session: session as never, product, base: BASE, from: FROM });
    return `buyer${n}@example.com`;
  };

  part("A group of two: the buyer paid $16 for two places (the catalog says $9 each)");
  let to = await group(1, {});
  is("(control) the total came: it is the Paid line", paidLine(to), "Paid: $16");
  to = await group(2, { amount_total: undefined });
  is("no total: the line is not the catalog price times two", paidLine(to), "(no Paid line)");
  is("no total: the receipt with the link to hand out the places still goes", lastTo(to)?.text.includes(`${BASE}/`) ?? false, true);
  to = await group(3, { currency: undefined });
  is("no currency: the line is not written in the store's currency", paidLine(to), "(no Paid line)");
  to = await group(4, { amount_total: 1600.5 });
  is("a total that is not a whole number of cents: no Paid line", paidLine(to), "(no Paid line)");
  to = await group(5, { currency: "US Dollar" });
  is("a currency that is not a code: no Paid line", paidLine(to), "(no Paid line)");
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
