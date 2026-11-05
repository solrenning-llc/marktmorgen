/**
 * Claude 4, return review of #2690 at d7fd2f0e (stacked on #2685 at 4808934e).
 *
 * B1 and B5 are controls: the safe behavior inside the mark's life, and the count of invitations whose link really ran
 * out. B2, B3 and B4 state what a safe design does and are EXPECTED TO FAIL at d7fd2f0e:
 *   B2  the mark lives 24h + 60s, but a checkout on a store with abandoned-checkout reminders on closes in 1h, so for
 *       ~23h the invitation hands back a dead checkout (lib/move-members.ts:75, :369, :385; lib/store-checkout.ts:671).
 *   B3  an unknown failure after Stripe made the session releases the mark, so one invitation makes two sessions
 *       (lib/move-members.ts:388-389).
 *   B4  after the mark, an invitation paid without the thanks page and missed by the sweep opens a second checkout at
 *       the off-sale price, although Stripe shows a live membership (openMove never asks keptAlready).
 */
import { TEST_CONSENT } from "~t/digital-consent-fixture";
import { addOption, addProduct, claimHandle, ensureStatsId, setOptionOnSale, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { inviteMembers, keptAlready, openMove, pendingInvitesOnOptions, readInvite } from "@/lib/move-members";
import { linkSeconds } from "@/lib/move-rules";
import { store as redis, advance } from "~t/redis-stub";
import { done, is, part } from "~t/check";
import { paidPeriod } from "~t/billing-period-fixture";

const OWNER = "proof-r2@example.com";
const checkouts: URLSearchParams[] = [];
let failNext = false;
/** Set once Cy has paid: Stripe then shows Cy's live membership to this product. */
let cyPaid: string | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    // Stripe made the session, then its answer was lost on the way back.
    if (failNext) {
      failNext = false;
      throw new TypeError("fetch failed: socket hang up");
    }
    const n = checkouts.length;
    return new Response(JSON.stringify({ id: `cs_test_${"m".repeat(20)}${n}`, url: `https://checkout.stripe.com/c/pay/test${n}` }));
  }
  if (cyPaid && method === "GET" && path === "/customers" && url.searchParams.get("email") === "cy@example.com") {
    return new Response(JSON.stringify({ object: "list", data: [{ id: "cus_CyPaid01" }], has_more: false }));
  }
  if (cyPaid && method === "GET" && path === "/subscriptions" && url.searchParams.get("customer") === "cus_CyPaid01") {
    return new Response(JSON.stringify({ object: "list", data: [{ id: "sub_CyPaid01", status: "trialing", metadata: { product: cyPaid, moved: "yes" } }], has_more: false }));
  }
  if (method === "GET") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_proof_only";
  process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_proof";
  redis.clear();
  const nowS = Math.floor(Date.now() / 1000);
  const made = await claimHandle(OWNER, "proofr2", "Proof Store", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestProofR21", true);
  await setSubscription(OWNER, { customerId: "cus_PrfR201x", subscriptionId: "sub_PrfR201x", active: true, period: paidPeriod() });
  await setRecovery(OWNER, { enabled: true, address: "1 Main St, Austin, TX 78701", asks: true });
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
  const [adaF, benF, cyF] = await inviteMembers(store, "job_r2", [
    { email: "ada@example.com", productId: id, option: basic, renews: nowS + 20 * 86_400 },
    { email: "ben@example.com", productId: id, option: basic, renews: nowS + 20 * 86_400 },
    { email: "cy@example.com", productId: id, option: basic, renews: nowS + 20 * 86_400 },
  ]);
  const ada = (await readInvite(store.statsId!, adaF!))!;
  const ben = (await readInvite(store.statsId!, benF!))!;
  const cy = (await readInvite(store.statsId!, cyF!))!;
  is("the store has abandoned-checkout reminders on", store.recovery.enabled, true);
  const off = await setOptionOnSale(OWNER, basic, false);
  is("Basic taken off sale by the real route function", off.ok, true);
  store = (await storeForEmail(OWNER))!;

  part("B1 (control): one invitation pressed three times inside the mark is one checkout, the same URL");
  const n0 = checkouts.length;
  const [a1, a2] = await Promise.all([
    openMove(store, id, ada.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT),
    openMove(store, id, ada.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT),
  ]);
  const a3 = await openMove(store, id, ada.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  is("checkouts made at Stripe", checkouts.length - n0, 1);
  is("the press at the same instant is refused", a2.ok ? "url" : a2.reason, "refused");
  is("a later press gets the same checkout", a3.ok && a1.ok ? a3.url === a1.url : false, true);

  part("B2: the mark outlives the checkout (reminders on: the checkout closes in 1h)");
  const life = Number(checkouts[checkouts.length - 1].get("expires_at")) - Math.floor(Date.now() / 1000);
  const ttl = Number(redis.run(["TTL", `nl:mv:open:${store.statsId}:${adaF}`]));
  console.log(`  checkout closes in ${life}s; the invitation's mark lives ${ttl}s`);
  is("the mark lives no longer than the checkout and a minute (EXPECTED TO FAIL)", ttl <= life + 60, true);
  advance(2 * 3_600 * 1000);
  const a4 = await openMove(store, id, ada.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  is(
    "2h later, its checkout closed and unpaid, the link does not hand back the closed one (EXPECTED TO FAIL)",
    a4.ok && a1.ok ? (a4.url === a1.url ? "the closed checkout" : "a live checkout") : a4.ok ? "a live checkout" : a4.reason,
    "a live checkout",
  );

  part("B3: an unknown failure after Stripe made the session releases the mark");
  const n1 = checkouts.length;
  failNext = true;
  const b1 = await openMove(store, id, ben.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  const b2 = await openMove(store, id, ben.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  is("the first press, its answer lost, is refused", b1.ok ? "url" : b1.reason, "refused");
  console.log(`  second press: ${b2.ok ? "opened" : b2.reason}`);
  is("at most one session at Stripe for one invitation (EXPECTED TO FAIL)", checkouts.length - n1, 1);

  part("B4: paid without the thanks page, missed by the sweep: after the mark a second checkout opens");
  const n2 = checkouts.length;
  const c1 = await openMove(store, id, cy.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  is("Cy's first checkout opens", c1.ok, true);
  // Cy paid in it; Stripe shows the live membership; neither the thanks page nor the sweep ran noteKept.
  cyPaid = id;
  is("Stripe shows Cy's live membership to keptAlready (control)", await keptAlready(store, cy.e, id), true);
  advance((86_400 + 61) * 1000);
  const c2 = await openMove(store, id, cy.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  console.log(`  after the mark: ${c2.ok ? "opened" : c2.reason}, checkouts for Cy ${checkouts.length - n2}`);
  is("no second checkout for a membership Stripe shows live (EXPECTED TO FAIL)", checkouts.length - n2, 1);

  part("B5 (control): an invitation leaves the count when its link really runs out");
  const later = (ada.at + linkSeconds(ada.r, ada.at * 1000) + 5) * 1000;
  const before = await pendingInvitesOnOptions(store, id, [basic, plus], undefined, ada.at * 1000);
  const after = await pendingInvitesOnOptions(store, id, [basic, plus], undefined, later);
  is("Basic counted while the links work, and not after", [before[basic], after[basic]], [3, 0]);
  done();
}
void main();
