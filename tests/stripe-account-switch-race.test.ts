// Money-defect hunt on the creator's connected Stripe account (Claude 7, 13/11/2026).
//
// app/api/stripe/check and app/api/stripe/return read the store, ask Stripe about the
// account it names, and then wrote what Stripe said with setStripeAccount, which writes
// the account id it is given whatever the store now names. Stripe can take seconds to
// answer. If the creator meanwhile pressed "Disconnect" (clearStripeAccount), or
// disconnected and connected another account, the late answer put the OLD account back
// on the store with card payments "on": the store's checkout opened again over an
// account the creator had just removed, and buyers' money went to it instead of to the
// account the creator chose. Data read about one account must never be written over
// another, nor over a store that no longer has one.
//
// Synthetic store, synthetic session, Stripe mocked; MemoryRedis (tests/redis-stub.ts).
import { NextRequest } from "next/server";
import { GET as returnGET } from "@/app/api/stripe/return/route";
import { POST as checkPOST } from "@/app/api/stripe/check/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, clearStripeAccount, setStripeAccount, storeForEmail } from "@/lib/store";
import "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_connect_switch_race_only";
const OLD = "acct_1OldAccountRace";
const NEW = "acct_1NewAccountRace";
const email = "connect-switch-race@example.com";

/** What happens on the creator's side while Stripe is still answering about OLD. */
let meanwhile: () => Promise<void> = async () => {};
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || !url.pathname.startsWith(`/v2/core/accounts/${OLD}`)) {
    throw new Error(`Unexpected synthetic provider request: ${url}`);
  }
  stripeCalls++;
  await meanwhile();
  const body = { id: OLD, configuration: { merchant: { capabilities: { card_payments: { status: "active" } } } }, requirements: { summary: {} } };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

async function main() {
  is("synthetic store", (await claimHandle(email, "connectrace", "A store", "")).ok, true);
  const cookie = `${SESSION_COOKIE}=${await openSession(email)}`;
  const routes = [
    ["return", () => returnGET(new NextRequest("https://marktmorgen.com/api/stripe/return", { headers: { cookie } }))],
    ["check", () => checkPOST(new NextRequest("https://marktmorgen.com/api/stripe/check", { method: "POST", headers: { cookie, origin: "https://marktmorgen.com", host: "marktmorgen.com" } }))],
  ] as const;
  const said = (response: Response) => new URL(response.headers.get("location") ?? "", "https://marktmorgen.com").searchParams.get("stripe");

  for (const [name, call] of routes) {
    part(`${name}: the creator disconnects while Stripe answers about the old account`);
    is("seeded old account, not yet selling", (await setStripeAccount(email, OLD, false)).ok, true);
    meanwhile = async () => { await clearStripeAccount(email); };
    stripeCalls = 0;
    let response = await call();
    meanwhile = async () => {};
    let store = await storeForEmail(email);
    is(`${name} disconnect: Stripe asked once`, stripeCalls, 1);
    is(`${name} disconnect: the old account is not put back`, store?.stripeAccountId ?? null, null);
    is(`${name} disconnect: card payments stay off`, store?.stripeChargesEnabled, false);
    is(`${name} disconnect: never told ready`, said(response) === "ready", false);

    part(`${name}: the creator switches to another account while Stripe answers about the old one`);
    is("seeded old account, not yet selling", (await setStripeAccount(email, OLD, false)).ok, true);
    meanwhile = async () => { await clearStripeAccount(email); await setStripeAccount(email, NEW, false); };
    response = await call();
    meanwhile = async () => {};
    store = await storeForEmail(email);
    is(`${name} switch: the new account is kept`, store?.stripeAccountId, NEW);
    is(`${name} switch: the old account's state is not written on the new one`, store?.stripeChargesEnabled, false);
    is(`${name} switch: never told ready`, said(response) === "ready", false);

    part(`${name}: control, nothing changes meanwhile`);
    is("seeded old account, not yet selling", (await setStripeAccount(email, OLD, false)).ok, true);
    response = await call();
    store = await storeForEmail(email);
    is(`${name} control: said ready`, said(response), "ready");
    is(`${name} control: same account`, store?.stripeAccountId, OLD);
    is(`${name} control: written on`, store?.stripeChargesEnabled, true);
  }
  done();
}

void main();
