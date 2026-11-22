/**
 * MM-SA-34 (docs/security-audit-2026-10-28.md): an order id never signs a browser in to an
 * affiliate account that already exists.
 *
 * app/api/store/affiliates/join takes a Stripe checkout session id (`order`) and, through
 * lib/affiliates.ts joinAsBuyer/buyerOfOrder, signs the browser in as the affiliate whose address
 * paid that order, for AFFILIATE_SESSION_SECONDS, whatever the order's age and whether or not that
 * affiliate already existed with earnings. The order id is a bearer key that travels in the purchase
 * email's link (`/affiliates?order=cs_...`), the thanks page address and the ad pixels (MM-SA-25),
 * and the order page itself honors it only for DOWNLOAD_WINDOW_SECONDS (3 days, lib/store-checkout.ts
 * readOrder). Signed in, the holder reads the affiliate's address and earnings and can change where
 * they are paid (app/api/store/affiliates/payto).
 *
 * The order still makes a NEW affiliate at once (the creator's "buyers join"); for one already on the
 * list it hands out no session, and their own link is emailed to the address that paid, as the apply
 * form does. Synthetic data, Redis, Stripe and email stand-ins.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { joinAsBuyer } from "@/lib/affiliates";
import { NextRequest } from "next/server";
import { POST as joinRoute } from "@/app/api/store/affiliates/join/route";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { DOWNLOAD_WINDOW_SECONDS } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const sessions = new Map<string, Record<string, unknown>>();
const emailed: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "api.resend.com") {
    emailed.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: "email-stand-in" }));
  }
  const m = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/);
  const found = m ? sessions.get(m[1]) : undefined;
  if (!m) return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response(JSON.stringify(found ?? { error: { message: "No such checkout.session" } }), { status: found ? 200 : 404 });
}) as typeof fetch;

const paid = (id: string, email: string, created: number) =>
  sessions.set(id, {
    id,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    amount_total: 2700,
    currency: "usd",
    created,
    customer_details: { email },
    metadata: { store: "harbor", product: "p8w2m4q9zz" },
  });

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  redis.clear();
  const made = await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId("owner@example.com");
  await ensureStoreId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Harbor000001", subscriptionId: "sub_Harbor000001", active: true, tier: "creator", period: paidPeriod() });
  await setAffiliateSetting("owner@example.com", { ...NO_AFFILIATES, enabled: true, buyers: true, rates: {} });
  const store = (await storeForEmail("owner@example.com"))!;

  const now = Math.floor(Date.now() / 1000);
  // Dana became an affiliate from a recent order (and may since have earned commissions).
  paid("cs_test_danarecent0001", "dana@example.com", now - 60);
  const dana = await joinAsBuyer(store, "cs_test_danarecent0001");
  if (!dana.ok) throw new Error(`setup: ${dana.reason}`);
  // An order Dana paid more than a year ago: its id sits in her old purchase email and in the ad platform's events.
  paid("cs_test_danaoldorder01", "dana@example.com", now - 400 * 86_400);
  if (now - 400 * 86_400 > now - DOWNLOAD_WINDOW_SECONDS) throw new Error("setup: the order is not old");

  const form = new URLSearchParams({ handle: "harbor", order: "cs_test_danaoldorder01" });
  const response = await joinRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates/join", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded" }, body: form.toString() }));
  const cookie = response.headers.get("set-cookie") ?? "";
  is("an order 400 days old signs nobody in to Dana's existing affiliate account", /^nl_aff_harbor=[0-9a-f]{64};/.test(cookie), false);
  is("the page says to check the inbox", response.headers.get("location"), "https://marktmorgen.com/@harbor/affiliates?status=sent");
  is("and Dana's own link goes to the address that paid, nowhere else", emailed.map((body) => (JSON.parse(body) as { to?: unknown }).to), [["dana@example.com"]]);

  // A recent order is no sign-in either, for an affiliate who was already there.
  const recent = await joinRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates/join", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle: "harbor", order: "cs_test_danarecent0001" }).toString() }));
  is("the order that made Dana an affiliate does not sign anyone in to her account later", /nl_aff_harbor=/.test(recent.headers.get("set-cookie") ?? ""), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
