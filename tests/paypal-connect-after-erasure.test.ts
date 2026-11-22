/**
 * Codex L-20261120-0310 (MEDIUM, money and erasure): starting PayPal's onboarding (app/api/store/paypal/connect)
 * asked PayPal for a Partner Referral and only then wrote the store's connect mark with a plain SET. A store whose
 * erasure began while PayPal answered got its mark back (nl:ppsell:start:<statsId>, a day) and the creator was sent to
 * a live PayPal page to grant payment and refund rights for a store that no longer exists.
 *
 * Now the store is read live before PayPal is asked (lib/inbox.ts contactStoreLive, without writing), and the mark is
 * written once PayPal answered, only while the store is still live, in the same step (lib/live-fence.ts's rule: its
 * erasing mark absent, its id key still its own). A store already being erased asks PayPal nothing; one whose erasure
 * began meanwhile, by the real closeStoreRecord, gets no page and no mark back (the erasure does not delete this mark:
 * its family runs out within a day, lib/data-families.ts). A reconnect that fails leaves an earlier attempt, still
 * open in another tab, as it was (Claude 1 coord's audit of #5119). Synthetic store, session and PayPal only.
 */
import { NextRequest } from "next/server";
import { POST as connect } from "@/app/api/store/paypal/connect/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { markOnboarding, onboardingStarted } from "@/lib/paypal-sales";
import { ERASING_KEY, claimHandle, closeStoreRecord, ensureStatsId, ensureStoreId, erasingField, storeForEmail, storeRef } from "@/lib/store";
import { creatorFrom } from "@/lib/studio-route";
import { TAKE_COMMANDS } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.PAYPAL_PARTNER_CLIENT_ID = "partner-client-erasure";
process.env.PAYPAL_PARTNER_SECRET = "partner-secret-erasure";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH02";
process.env.PAYPAL_BN_CODE = "BN_ERASURE";
let referrals = 0;
/** When set, PayPal's Partner Referral answers with an error (a reconnect that fails). */
let referralFails = false;
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
    if (referralFails) return json({ name: "INTERNAL_SERVER_ERROR" }, 500);
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
  return { store, press, erasing, cookie };
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
    // The erasure as it runs: the store's erasing mark (lib/store.ts prepareStore), then its record and id key closed
    // (closeStoreRecord). Nothing deletes the connect mark by hand: its family is not erased, it runs out.
    duringReferral = async () => {
      await erasing();
      if (!(await closeStoreRecord(store))) throw new Error("synthetic close did not complete");
    };
    referrals = 0;
    const response = await press();
    is("PayPal was asked once", referrals, 1);
    is("not sent to PayPal's page for a store being erased", sentToPayPal(response), false);
    is("the connect mark is not written back", await onboardingStarted(store.statsId!), false);
  }
  part("A reconnect that fails leaves the attempt still open in another tab as it was");
  {
    const { store, press } = await setup("paypal-tabs@example.com", "paypaltabs");
    is("tab A sent to PayPal", sentToPayPal(await press()), true);
    const first = await onboardingStarted(store.statsId!);
    is("tab A's attempt is the store's", typeof first, "string");
    referralFails = true;
    try {
      is("tab B's reconnect fails and is not sent to PayPal", sentToPayPal(await press()), false);
    } finally {
      referralFails = false;
    }
    is("tab A's attempt is still the store's, so its way back still connects", await onboardingStarted(store.statsId!), first);
    is("control: a later connect that PayPal answered is the store's own", typeof (await markOnboarding(store)), "string");
  }

  part("A connect stays inside the integration unit it takes (tests/plan-cost-registry.ts UNIT_COST.integration: 10 + TAKE_COMMANDS)");
  {
    // Billed as Upstash bills: one a command, and a script one plus each call it runs. Every script the route sends
    // is named here with the calls it runs, so a new one fails this check until it is priced.
    const SCRIPT_CALLS: Record<string, number> = {
      // lib/inbox.ts INBOX_STORE_LIVE: GET (or GETRANGE) and HEXISTS (the store read live before PayPal is asked).
      "-- marktmorgen:inbox-store-live:v1": 2,
      // lib/live-fence.ts SET_IF_STORE_LIVE: HGET, GET and SET at the most (the mark, written once PayPal answered).
      "-- marktmorgen:store-cache-live:v3": 3,
    };
    const real = redis.pipeline.bind(redis);
    let billed = 0;
    let bytes = 0;
    const unknown: string[] = [];
    redis.pipeline = (async (batch: (string | number)[][]) => {
      for (const command of batch) {
        billed += 1;
        for (const part of command) bytes += Buffer.byteLength(String(part));
        if (command[0] !== "EVAL") continue;
        const name = String(command[1]).split("\n")[0];
        if (name in SCRIPT_CALLS) billed += SCRIPT_CALLS[name];
        else unknown.push(name);
      }
      return real(batch);
    }) as typeof redis.pipeline;
    const unit = 10 + TAKE_COMMANDS;
    try {
      const { store, press, cookie } = await setup("paypal-cost@example.com", "paypalcost");
      const studio = () => new NextRequest("https://marktmorgen.com/api/store/paypal/connect", { method: "POST", headers: { cookie, origin: "https://marktmorgen.com", host: "marktmorgen.com" } });
      // The studio access is the studio request's own (lib/studio-route.ts countStudio): measured alone, warm, and taken off.
      await creatorFrom(studio(), "payments");
      billed = 0;
      await creatorFrom(studio(), "payments");
      const access = billed;
      billed = 0;
      bytes = 0;
      is("sent to PayPal", sentToPayPal(await press()), true);
      const sent = billed - access;
      is(`a connect sent to PayPal bills ${sent} commands past the studio access, inside the unit's ${unit}`, sent <= unit, true);
      is(`and sends ${bytes} bytes to the database with the studio access, inside the unit's 21,024`, bytes <= 21_024, true);
      // The longest path: the store's erasure begins while PayPal answers, so the fenced mark finds it gone.
      duringReferral = async () => { await real([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]); };
      billed = 0;
      bytes = 0;
      is("not sent to PayPal", sentToPayPal(await press()), false);
      const ended = billed - access;
      is(`a connect whose store began erasing while PayPal answered bills ${ended} commands past the studio access, inside the unit's ${unit}`, ended <= unit, true);
      is(`and sends ${bytes} bytes to the database with the studio access, inside the unit's 21,024`, bytes <= 21_024, true);
      is("every script the route sends is priced here", unknown, []);
    } finally {
      redis.pipeline = real;
    }
  }
}

main().then(done, (error) => { console.error(error); process.exit(1); });
