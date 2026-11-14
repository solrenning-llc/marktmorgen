/**
 * Buyer area hunt (Claude 7, 14 November 2026): the license-key revocation job (lib/licence-keys.ts, revokeRefunded) reads a /refunds reply that is not
 * a list as an empty, complete page, and moved its place past refunds it never read when a lost dispute was read in
 * the same run, so the refund in that window never revoked its key. Now such a reply leaves the run unsure and the
 * place where it was. Synthetic Stripe stand-in, Redis stub.
 */
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { checkKey, keyForSale, revokeRefunded } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_probe_c_keys";
const OWNER = "potter@example.com";
const ACCOUNT = "acct_1TestProbeC0001";
const NOW = Math.floor(Date.now() / 1000);

let refundsReply: unknown = { error: "x" };
let refundRows: Record<string, unknown>[] = [];
const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
let closings: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  const gte = Number(url.searchParams.get("created[gte]") ?? 0);
  if (path === "/checkout/sessions") return list(sessionsByPayment[url.searchParams.get("payment_intent") ?? ""] ?? []);
  if (path === "/events") return list(closings.filter((e) => (e.created as number) >= gte));
  if (path === "/refunds") return refundsReply === "list" ? list(refundRows.filter((r) => (r.created as number) >= gte)) : answer(refundsReply);
  return list([]);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kilnworks", "Kiln Works", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00003", subscriptionId: "sub_Owner00003", active: true, period: paidPeriod() });
  const tool = await addProduct(OWNER, "Firing App", "", "29", null);
  if (!tool.ok) throw new Error("no product");
  await setProductLink(OWNER, tool.product.id, "https://example.com/firing-app");
  await setProductKeys(OWNER, tool.product.id, { source: "generated", prefix: "FIRE", groups: 4, groupLength: 4, lowAt: 0 });
  const store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, tool.product.id))!;
  const given = await keyForSale(store, app, "cs_test_probecrefund01", "buyer@example.com");
  if (given?.state !== "issued") throw new Error("no key");
  sessionsByPayment.pi_TestProbeC00001 = [{ id: "cs_test_probecrefund01", metadata: { store: "kilnworks", product: tool.product.id } }];
  // An anchor from an earlier run, two hours back.
  await redis.pipeline([["SET", `nl:keys:${store.statsId}:refunds:since`, String(NOW - 7200)]]);
  // Refunded in full an hour ago.
  refundRows = [{ id: "re_TestProbeC00001", object: "refund", created: NOW - 3600, status: "succeeded", payment_intent: "pi_TestProbeC00001", charge: { object: "charge", amount: 2900, amount_refunded: 2900, refunded: true } }];
  // Another sale of the store lost to a dispute a minute ago (no key for it).
  closings = [{ id: "evt_TestProbeC0001", object: "event", type: "charge.dispute.closed", created: NOW - 60, data: { object: { id: "du_TestProbeC0001", object: "dispute", status: "lost", amount: 1000, charge: "ch_TestProbeC9999", payment_intent: "pi_TestProbeC99999" } } }];

  part("Run 1: /refunds answers 200 with a body that is not a list");
  refundsReply = { object: "error_page" };
  await revokeRefunded(store, Date.now() + 10_000);
  const [anchor] = await redis.pipeline([["GET", `nl:keys:${store.statsId}:refunds:since`]]);
  console.log("anchor after run 1:", Number(anchor) - NOW, "s from now (refund was at -3600)");
  is("the place does not move past refunds never read", Number(anchor) <= NOW - 3600, true);

  part("Run 2: /refunds answers properly");
  refundsReply = "list";
  await revokeRefunded(store, Date.now() + 10_000);
  const state = await checkKey(store, app, given.key);
  console.log("key state after run 2:", state);
  is("the key of the sale refunded in full is revoked", state, "revoked");
  done();
}
void main();
