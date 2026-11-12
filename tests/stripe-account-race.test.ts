// The studio routes that ask Stripe about a connected account and write the answer down (app/api/stripe/return,
// app/api/stripe/check), and the one that opens the account (app/api/stripe/connect), wrote the store record with
// the account they had read before asking Stripe. A creator who forgot the account (app/api/stripe/disconnect) while
// Stripe was being asked had it written back, with card payments on: the store's checkout (lib/store-checkout.ts)
// took sales into an account its creator had just let go. Two connects at once each opened an account, and the
// second wrote over the first while the first tab was onboarding it. Now each write is made only while the store
// still points at the account the route started from (none, for connect); otherwise nothing is written and the
// creator is told the check failed. Synthetic store and session; Stripe mocked; MemoryRedis (tests/redis-stub.ts).
import { NextRequest } from "next/server";
import { GET as returnGET } from "@/app/api/stripe/return/route";
import { POST as checkPOST } from "@/app/api/stripe/check/route";
import { POST as connectPOST } from "@/app/api/stripe/connect/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, clearStripeAccount, setStripeAccount, storeForEmail } from "@/lib/store";
import "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_stripe_account_race_only";
const FIRST = "acct_1RaceFirst";
const SECOND = "acct_1RaceSecond";
/** Runs once, while Stripe is being asked: what the creator did meanwhile in another tab. */
let meanwhile: (() => Promise<void>) | null = null;
let opened = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com") throw new Error(`Unexpected synthetic provider request: ${url}`);
  const step = meanwhile;
  meanwhile = null;
  if (step) await step();
  if (url.pathname === "/v2/core/accounts" && init?.method === "POST") {
    opened += 1;
    return Response.json({ id: opened === 1 ? FIRST : SECOND });
  }
  if (url.pathname === "/v2/core/account_links") return Response.json({ url: "https://connect.stripe.com/setup/synthetic" });
  if (url.pathname.startsWith("/v2/core/accounts/")) {
    return Response.json({ id: decodeURIComponent(url.pathname.split("/")[4]), configuration: { merchant: { capabilities: { card_payments: { status: "active" } } } }, requirements: { summary: {} } });
  }
  throw new Error(`Unexpected synthetic provider request: ${url}`);
}) as typeof fetch;

async function main() {
  const email = "stripe-race@example.com";
  is("synthetic store", (await claimHandle(email, "striperace", "A store", "")).ok, true);
  const session = await openSession(email);
  const cookie = `${SESSION_COOKIE}=${session}`;
  const posted = { cookie, origin: "https://marktmorgen.com", host: "marktmorgen.com" };
  const said = (response: Response) => new URL(response.headers.get("location") ?? "", "https://marktmorgen.com").searchParams.get("stripe");
  const routes = [
    ["return", () => returnGET(new NextRequest("https://marktmorgen.com/api/stripe/return", { headers: { cookie } }))],
    ["check", () => checkPOST(new NextRequest("https://marktmorgen.com/api/stripe/check", { method: "POST", headers: posted }))],
  ] as const;

  for (const [name, call] of routes) {
    part(`${name}: the account forgotten while Stripe is asked stays forgotten`);
    is("seeded", (await setStripeAccount(email, FIRST, false)).ok, true);
    meanwhile = async () => {
      await clearStripeAccount(email);
    };
    const response = await call();
    const after = await storeForEmail(email);
    is(`${name}: the forgotten account is not written back`, [after?.stripeAccountId, after?.stripeChargesEnabled], [null, false]);
    is(`${name}: the creator is not told it is ready`, said(response), "error");

    part(`${name}: another account connected while Stripe is asked is not written over`);
    is("seeded", (await setStripeAccount(email, FIRST, false)).ok, true);
    meanwhile = async () => {
      await setStripeAccount(email, SECOND, false);
    };
    const other = await call();
    const kept = await storeForEmail(email);
    is(`${name}: the account connected meanwhile stays`, [kept?.stripeAccountId, kept?.stripeChargesEnabled], [SECOND, false]);
    is(`${name}: the creator is not told it is ready`, said(other), "error");

    part(`${name}: healthy control`);
    is("seeded", (await setStripeAccount(email, FIRST, false)).ok, true);
    const healthy = await call();
    const fine = await storeForEmail(email);
    is(`${name}: written and said`, [fine?.stripeAccountId, fine?.stripeChargesEnabled, said(healthy)], [FIRST, true, "ready"]);
  }

  part("connect: an account opened by another tab meanwhile is not written over");
  await clearStripeAccount(email);
  opened = 0;
  const form = () => {
    const body = new FormData();
    body.set("country", "US");
    return body;
  };
  meanwhile = async () => {
    // The other tab's connect opened its account first and wrote it down.
    opened += 1;
    await setStripeAccount(email, FIRST, false);
  };
  const late = await connectPOST(new NextRequest("https://marktmorgen.com/api/stripe/connect", { method: "POST", headers: posted, body: form() }));
  is("connect: the first account stays the store's", (await storeForEmail(email))?.stripeAccountId, FIRST);
  is("connect: the late tab is not sent to onboard an account the store does not keep", said(late), "error");

  part("the write itself: made only while the store points at the account expected");
  await clearStripeAccount(email);
  is("none expected, none kept: written", (await setStripeAccount(email, FIRST, false, { expected: null })).ok, true);
  is("none expected, one kept: refused", await setStripeAccount(email, SECOND, false, { expected: null }), { ok: false, reason: "moved" });
  is("the one kept stays", (await storeForEmail(email))?.stripeAccountId, FIRST);
  is("that one expected: written", (await setStripeAccount(email, FIRST, true, { expected: FIRST })).ok, true);
  is("another expected: refused", await setStripeAccount(email, FIRST, false, { expected: SECOND }), { ok: false, reason: "moved" });
  is("its card payments as last written", (await storeForEmail(email))?.stripeChargesEnabled, true);
  done();
}

void main();
