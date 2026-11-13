// Money-defect hunt on the creator's connected Stripe account (Claude 7, 13/11/2026).
//
// app/api/stripe/connect opens the creator's Stripe account the first time and writes it
// on the store. Two first connects at once (a double click, two tabs) each read a store
// with no account, each opened an account at Stripe, and each wrote its own with
// setStripeAccount, the second over the first: the creator finished Stripe's onboarding
// on an account the store no longer named, and the store kept one nobody set up. The
// write now only lands while the store still has no account (setStripeAccount's
// `expected` null), so the second loses: it writes nothing and is told stripe=error,
// never sent into Stripe for an account the store does not name.
//
// Synthetic store, synthetic session, Stripe mocked; MemoryRedis (tests/redis-stub.ts).
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { POST as connectPOST } from "@/app/api/stripe/connect/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, storeForEmail } from "@/lib/store";
import "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_connect_first_race_only";
const email = "connect-first-race@example.com";
const FIRST = "acct_1FirstConnectRace";
const SECOND = "acct_1SecondConnectRace";

/** Each account creation waits until `together` creations are in flight, so both read a store with no account. */
let together = 2;
let waiting: (() => void)[] = [];
let created = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com") throw new Error(`Unexpected synthetic provider request: ${url}`);
  if (url.pathname === "/v2/core/accounts" && init?.method === "POST") {
    const id = created++ === 0 ? FIRST : SECOND;
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length >= together) {
        for (const go of waiting) go();
        waiting = [];
      }
    });
    return new Response(JSON.stringify({ id }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.pathname === "/v2/core/account_links") {
    const account = String((JSON.parse(String(init?.body ?? "{}")) as { account?: string }).account ?? "");
    return new Response(JSON.stringify({ url: `https://connect.stripe.com/setup/${account}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`Unexpected synthetic provider request: ${url}`);
}) as typeof fetch;

async function main() {
  is("synthetic store", (await claimHandle(email, "connectfirst", "A store", "")).ok, true);
  const cookie = `${SESSION_COOKIE}=${await openSession(email)}`;
  const connect = () => {
    const body = new URLSearchParams({ country: "US" });
    return connectPOST(new NextRequest("https://marktmorgen.com/api/stripe/connect", {
      method: "POST",
      body,
      headers: { cookie, origin: "https://marktmorgen.com", host: "marktmorgen.com", "content-type": "application/x-www-form-urlencoded" },
    }));
  };
  const where = (response: Response) => response.headers.get("location") ?? "";

  part("two first connects at the same time");
  const answers = await Promise.all([connect(), connect()]);
  const store = await storeForEmail(email);
  is("Stripe was asked for two accounts", created, 2);
  is("the store names one of them", [FIRST, SECOND].includes(store?.stripeAccountId ?? ""), true);
  const sent = answers.filter((r) => where(r).startsWith("https://connect.stripe.com/"));
  is("only one creator tab is sent into Stripe", sent.length, 1);
  is("and it is sent to finish the account the store names", sent.map(where), [`https://connect.stripe.com/setup/${store?.stripeAccountId}`]);
  is("the creator is told of one connected account, not two", afterTasks.length, 1);
  is("the other is told it did not work", answers.filter((r) => !where(r).startsWith("https://connect.stripe.com/")).map((r) => new URL(where(r), "https://marktmorgen.com").searchParams.get("stripe")), ["error"]);

  part("control: a connect once the account exists opens no other and keeps it");
  const kept = store?.stripeAccountId;
  together = 1;
  const again = await connect();
  is("no new account at Stripe", created, 2);
  is("sent to finish the same account", where(again), `https://connect.stripe.com/setup/${kept}`);
  is("the store still names it", (await storeForEmail(email))?.stripeAccountId, kept);
  done();
}

void main();
