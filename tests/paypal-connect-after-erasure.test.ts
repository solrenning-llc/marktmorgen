/**
 * Codex L-20261120-0310 (MEDIUM, money and erasure): starting PayPal's onboarding (app/api/store/paypal/connect)
 * asked PayPal for a Partner Referral and only then wrote the store's connect mark with a plain SET. A store whose
 * erasure began while PayPal answered got its mark back (nl:ppsell:start:<statsId>, a day) and the creator was sent to
 * a live PayPal page to grant payment and refund rights for a store that no longer exists.
 *
 * Now the mark is written before PayPal is asked, and only while the store is live (lib/live-fence.ts's rule: its
 * erasing mark absent, its id key still its own); the PayPal page is handed over only while that same attempt is still
 * the store's. A store already being erased asks PayPal nothing; one whose erasure began meanwhile gets no page and no
 * mark back. Synthetic store, session and PayPal only.
 */
import { NextRequest } from "next/server";
import { POST as connect } from "@/app/api/store/paypal/connect/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { onboardingStarted } from "@/lib/paypal-sales";
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.PAYPAL_PARTNER_CLIENT_ID = "partner-client-erasure";
process.env.PAYPAL_PARTNER_SECRET = "partner-secret-erasure";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH02";
process.env.PAYPAL_BN_CODE = "BN_ERASURE";
let referrals = 0;
/** Runs while PayPal's Partner Referral is pending, once: the store's erasure beginning meanwhile. */
let duringReferral: (() => Promise<void>) | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "api-m.paypal.com") throw new Error(`Unexpected synthetic provider request: ${url}`);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAerasure", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/customer/partner-referrals" && init?.method === "POST") {
    referrals += 1;
    const meanwhile = duringReferral;
    duringReferral = null;
    if (meanwhile) await meanwhile();
    return json({ links: [{ href: "https://www.paypal.com/bizsignup/partner/entry?referralToken=erasure", rel: "action_url", method: "GET" }] }, 201);
  }
  throw new Error(`Unexpected synthetic provider request: ${url}`);
}) as typeof fetch;

async function setup(email: string, handle: string) {
  is(`synthetic store ${handle}`, (await claimHandle(email, handle, "A store", "")).ok, true);
  await ensureStatsId(email);
  await ensureStoreId(email);
  const store = (await storeForEmail(email))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(email)}`;
  const press = () => connect(new NextRequest("https://marktmorgen.com/api/store/paypal/connect", { method: "POST", headers: { cookie, origin: "https://marktmorgen.com", host: "marktmorgen.com" } }));
  const erasing = async () => { await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]); };
  return { store, press, erasing };
}

const sentToPayPal = (response: Response) => (response.headers.get("location") ?? "").startsWith("https://www.paypal.com/");

async function main() {
  part("A live store is sent to PayPal, with its connect mark");
  {
    const { store, press } = await setup("paypal-live@example.com", "paypallive");
    referrals = 0;
    const response = await press();
    is("sent to PayPal's page", [response.status, sentToPayPal(response)], [303, true]);
    is("PayPal was asked once", referrals, 1);
    is("the connect mark is kept", typeof (await onboardingStarted(store.statsId!)), "string");
  }

  part("A store already being erased asks PayPal nothing");
  {
    const { store, press, erasing } = await setup("paypal-erasing@example.com", "paypalerasing");
    await erasing();
    referrals = 0;
    const response = await press();
    is("not sent to PayPal", sentToPayPal(response), false);
    is("no Partner Referral is asked for", referrals, 0);
    is("no connect mark", await onboardingStarted(store.statsId!), false);
  }

  part("A store whose erasure begins while PayPal answers gets no page and no mark back");
  {
    const { store, press, erasing } = await setup("paypal-meanwhile@example.com", "paypalmeanwhile");
    // The erasure marks the store, then deletes its keys, the connect mark among them (lib/data-families.ts).
    duringReferral = async () => { await erasing(); await redis.pipeline([["DEL", `nl:ppsell:start:${store.statsId}`]]); };
    referrals = 0;
    const response = await press();
    is("PayPal was asked once", referrals, 1);
    is("not sent to PayPal's page for a store being erased", sentToPayPal(response), false);
    is("the connect mark is not written back", await onboardingStarted(store.statsId!), false);
  }
}

main().then(done, (error) => { console.error(error); process.exit(1); });
