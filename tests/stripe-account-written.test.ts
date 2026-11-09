// CX-123 rule 24, at the two studio routes that ask Stripe what a connected
// account can do and write it down (app/api/stripe/return, app/api/stripe/check):
// the creator is told "ready" or "pending" only when the store record took the
// answer. setStripeAccount says { ok: false } when the record read under its lock
// is gone or in a shape that is not a store; the routes answered as if written,
// so a creator was told Stripe is ready while the record that opens the store's
// checkout (lib/store-checkout.ts) still said it was not. Synthetic store,
// synthetic session, Stripe mocked; MemoryRedis (tests/redis-stub.ts).
import { NextRequest } from "next/server";
import { GET as returnGET } from "@/app/api/stripe/return/route";
import { POST as checkPOST } from "@/app/api/stripe/check/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_stripe_account_written_only";
const ACCOUNT = "acct_1Written";
let status = "active";
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || !url.pathname.startsWith(`/v2/core/accounts/${ACCOUNT}`)) {
    throw new Error(`Unexpected synthetic provider request: ${url}`);
  }
  stripeCalls++;
  return Response.json({ id: ACCOUNT, configuration: { merchant: { capabilities: { card_payments: { status } } } }, requirements: { summary: {} } });
}) as typeof fetch;

const pipeline = redis.pipeline;
/** The store record read under the write's lock, and only that read, answers `reply`. */
function underLock(reply: unknown) {
  let armed = false;
  redis.pipeline = async (commands) => {
    if (commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith("nl:store:lock:") && commands[0].includes("NX")) armed = true;
    if (armed && commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:store:owner:")) {
      armed = false;
      return [reply];
    }
    return pipeline(commands);
  };
}

async function main() {
  const email = "stripe-written@example.com";
  is("synthetic store", (await claimHandle(email, "stripewritten", "A store", "")).ok, true);
  const session = await openSession(email);
  const cookie = `${SESSION_COOKIE}=${session}`;
  const routes = [
    ["return", () => returnGET(new NextRequest("https://marktmorgen.com/api/stripe/return", { headers: { cookie } }))],
    ["check", () => checkPOST(new NextRequest("https://marktmorgen.com/api/stripe/check", { method: "POST", headers: { cookie, origin: "https://marktmorgen.com", host: "marktmorgen.com" } }))],
  ] as const;
  const said = (response: Response) => new URL(response.headers.get("location") ?? "", "https://marktmorgen.com").searchParams.get("stripe");
  const seed = async (charges: boolean) => {
    redis.pipeline = pipeline;
    is("seeded", (await setStripeAccount(email, ACCOUNT, charges)).ok, true);
  };

  for (const [name, call] of routes) {
    part(`${name}: healthy answers are written and said`);
    for (const [answer, charges, word] of [["active", true, "ready"], ["restricted", false, "pending"]] as const) {
      await seed(!charges);
      status = answer;
      stripeCalls = 0;
      const response = await call();
      is(`${name} ${answer}: said`, said(response), word);
      is(`${name} ${answer}: written`, (await storeForEmail(email))?.stripeChargesEnabled, charges);
      is(`${name} ${answer}: Stripe asked once`, stripeCalls, 1);
    }

    part(`${name}: a record not written is never said ready or pending`);
    for (const [label, reply] of [["gone (null)", null], ["number", 42], ["not JSON", "{broken"], ["array", ["x"]], ["object", { a: 1 }]] as const) {
      for (const [answer, charges] of [["active", true], ["restricted", false]] as const) {
        await seed(!charges);
        status = answer;
        underLock(reply);
        let response: Response;
        try {
          response = await call();
        } finally {
          redis.pipeline = pipeline;
        }
        is(`${name} ${label} ${answer}: told the check failed`, said(response), "error");
        is(`${name} ${label} ${answer}: record unchanged`, (await storeForEmail(email))?.stripeChargesEnabled, !charges);
      }
    }
  }
  done();
}

void main();
