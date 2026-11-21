// Money-defect hunt on the creator's connected Stripe account (Claude 7, 13/11/2026).
//
// Rule 30 (a Stripe reply decides only when it is the object asked for) at readAccount
// (lib/stripe-connect.ts): the answer about a connected account was read for its card
// payments and requirements without checking that it was the account asked about. A
// reply naming another account, or no account at all, was taken as this store's state:
// "active" from someone else's account opened this store's checkout through
// app/api/stripe/check and app/api/stripe/return, and the checkup said all was fine.
// Now such a reply throws like any other unknown shape, so nothing is written.
//
// Synthetic store, synthetic session, Stripe mocked; MemoryRedis (tests/redis-stub.ts).
import { NextRequest } from "next/server";
import { POST as checkPOST } from "@/app/api/stripe/check/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readAccount } from "@/lib/stripe-connect";
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_connect_read_identity_only";
const ACCOUNT = "acct_1ReadIdentity";
const OTHER = "acct_1SomeoneElse";

let body = "";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || !url.pathname.startsWith(`/v2/core/accounts/${ACCOUNT}`)) {
    throw new Error(`Unexpected synthetic provider request: ${url}`);
  }
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const active = (id: unknown) => JSON.stringify({
  ...(id === undefined ? {} : { id }),
  configuration: { merchant: { capabilities: { card_payments: { status: "active" } } } },
  requirements: { summary: {} },
});

async function read(): Promise<string> {
  try {
    return JSON.stringify(await readAccount(ACCOUNT));
  } catch {
    return "threw";
  }
}

async function main() {
  part("readAccount: a reply that is not the account asked about is unknown");
  for (const [label, id] of [["another account", OTHER], ["no id", undefined], ["id null", null], ["id a number", 7], ["id in other letter case", ACCOUNT.toUpperCase()]] as const) {
    body = active(id);
    is(`${label}: throws`, await read(), "threw");
  }
  body = active(ACCOUNT);
  is("control, its own id: read", await read(), JSON.stringify({ chargesEnabled: true, cardPayments: "active", detailsSubmitted: true }));

  part("check route: another account's 'active' never opens this store's checkout");
  const email = "connect-read-identity@example.com";
  is("synthetic store", (await claimHandle(email, "connectidentity", "A store", "")).ok, true);
  const cookie = `${SESSION_COOKIE}=${await openSession(email)}`;
  is("seeded, not selling", (await setStripeAccount(email, ACCOUNT, false)).ok, true);
  body = active(OTHER);
  const response = await checkPOST(new NextRequest("https://marktmorgen.com/api/stripe/check", { method: "POST", headers: { cookie, origin: "https://marktmorgen.com", host: "marktmorgen.com" } }));
  const said = new URL(response.headers.get("location") ?? "", "https://marktmorgen.com").searchParams.get("stripe");
  is("told the check failed", said, "error");
  is("card payments stay off", (await storeForEmail(email))?.stripeChargesEnabled, false);
  done();
}

void main();
