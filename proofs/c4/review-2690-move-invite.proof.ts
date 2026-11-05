import { TEST_CONSENT } from "~t/digital-consent-fixture";
import { addOption, addProduct, claimHandle, ensureStatsId, setOptionOnSale, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { inviteMembers, openMove, pendingInvitesOnOptions, readInvite, linkKey } from "@/lib/move-members";
import { store as redis } from "~t/redis-stub";
import { done, is, part } from "~t/check";
import { paidPeriod } from "~t/billing-period-fixture";

const OWNER = "proof-rv@example.com";
const nowS = Math.floor(Date.now() / 1000);
const checkouts: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && (init?.method ?? "GET") === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"m".repeat(20)}${checkouts.length}`, url: "https://checkout.stripe.com/c/pay/test" }));
  }
  if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_proof_only";
  redis.clear();
  const made = await claimHandle(OWNER, "proofrv", "Proof Store", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestProofRv1", true);
  await setSubscription(OWNER, { customerId: "cus_PrfRv01x", subscriptionId: "sub_PrfRv01x", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "Club", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  const id = club.product.id;
  await addOption(OWNER, id, "Basic", "19");
  await addOption(OWNER, id, "Plus", "39");
  let store = (await storeForEmail(OWNER))!;
  const [basic, plus] = (await readProduct(store, id))!.options.map((o) => o.id);
  await setProductLink(OWNER, basic, "https://example.com/basic");
  await setProductLink(OWNER, plus, "https://example.com/plus");
  store = (await storeForEmail(OWNER))!;
  const [adaField, benField] = await inviteMembers(store, "job_rv", [
    { email: "ada@example.com", productId: id, option: basic, renews: nowS + 20 * 86_400 },
    { email: "ben@example.com", productId: id, option: basic, renews: nowS + 20 * 86_400 },
  ]);
  const ada = (await readInvite(store.statsId!, adaField!))!;
  const ben = (await readInvite(store.statsId!, benField!))!;
  const off = await setOptionOnSale(OWNER, basic, false);
  is("Basic taken off sale by the real route function", off.ok, true);
  store = (await storeForEmail(OWNER))!;

  part("A1: the same invitation opens two payable checkouts at the off-sale price");
  const before = checkouts.length;
  const [one, two] = await Promise.all([
    openMove(store, id, ada.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT),
    openMove(store, id, ada.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT),
  ]);
  // Expected by the PR's promise ("convite usado = recusado"): at most one. Observed: two.
  is("at most one checkout from one invitation (EXPECTED TO FAIL)", [one.ok, two.ok, checkouts.length - before], [true, false, 1]);
  // Simulates: the member paid in the first checkout but never reached the thanks page (noteKept never ran).
  const third = await openMove(store, id, ada.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  is("after a paid checkout without the thanks page the link is refused (EXPECTED TO FAIL)", third.ok ? "opened" : third.reason, "unavailable");

  part("A2: an invitation whose link expired is counted as one that 'keeps this price'");
  redis.run(["DEL", linkKey(ben.t)]);
  const benOpen = await openMove(store, id, ben.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  const pending = await pendingInvitesOnOptions(store, id, [basic, plus]);
  is("Ben's link no longer opens anything", benOpen.ok ? "opened" : benOpen.reason, "expired");
  is("so Ben should not be counted as someone who still keeps the price (EXPECTED TO FAIL)", pending[basic], 1);
  done();
}
void main();
