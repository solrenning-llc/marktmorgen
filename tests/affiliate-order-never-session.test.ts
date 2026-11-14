/**
 * An order id never opens an affiliate session, not even for the affiliate it makes (the security audit of 14
 * November 2026; the residue MM-SA-34 records). The order id travels in the purchase email, the thanks page's address
 * and the ad pixels' events, so whoever holds a leaked one could press "Get my link" before the buyer did: the press
 * made the buyer's affiliate record and signed the holder's browser in as it, who could then set their own PayPal
 * before the buyer ever earned anything. Now the press makes or approves the record as before, and always emails the
 * ordinary one-off sign-in link to the address that paid, the page saying "check your inbox" (the same answer whether
 * the address was new or known, so the answer tells nothing either). Synthetic data, Redis, Stripe and email stand-ins.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { affiliateByEmail } from "@/lib/affiliates";
import { NextRequest } from "next/server";
import { POST as joinRoute } from "@/app/api/store/affiliates/join/route";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sessions = new Map<string, Record<string, unknown>>();
const emailed: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    emailed.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to), text: String(body.text) });
    return new Response(JSON.stringify({ id: "email-stand-in" }));
  }
  const m = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/);
  const found = m ? sessions.get(m[1]) : undefined;
  if (!m) return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response(JSON.stringify(found ?? { error: { message: "No such checkout.session" } }), { status: found ? 200 : 404 });
}) as typeof fetch;

const paid = (id: string, email: string) =>
  sessions.set(id, {
    id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 2700, currency: "usd",
    created: Math.floor(Date.now() / 1000) - 60, customer_details: { email }, metadata: { store: "harbor", product: "p8w2m4q9zz" },
  });

const press = async (order: string) => {
  const response = await joinRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates/join", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle: "harbor", order }).toString() }));
  return { location: response.headers.get("location"), cookie: response.headers.get("set-cookie") };
};
const sessionKeys = async () => redis.keys().filter((key) => key.startsWith("nl:aff:session:")).length;

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

  part("A leaked order id, pressed before its buyer ever joined");
  paid("cs_test_leakedorder001", "erin@example.com");
  const leaked = await press("cs_test_leakedorder001");
  is("no affiliate cookie is set", leaked.cookie, null);
  is("the page says to check the inbox", leaked.location, "https://marktmorgen.com/@harbor/affiliates?status=sent");
  is("no affiliate session exists anywhere", await sessionKeys(), 0);
  is("the buyer is made an affiliate, as the creator allows", (await affiliateByEmail(store, "erin@example.com"))?.status, "approved");
  is("and the sign-in link goes only to the address that paid", emailed.map((m) => m.to), ["erin@example.com"]);
  is("carrying a one-off link", /\/@harbor\/affiliates\?token=[0-9a-f]{64}/.test(emailed[0]?.text ?? ""), true);

  part("The same answer for a new address and a known one");
  const again = await press("cs_test_leakedorder001");
  is("pressed again: the same page, no cookie", [again.location, again.cookie], [leaked.location, null]);
  is("still no session", await sessionKeys(), 0);

  part("An address that waits for the creator waits, and hears the same");
  paid("cs_test_erintag000001", "erin+shop@example.com");
  const tagged = await press("cs_test_erintag000001");
  is("no cookie, check the inbox", [tagged.location, tagged.cookie], [leaked.location, null]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
