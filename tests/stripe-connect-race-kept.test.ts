// #5285 row #4335 (Claude 2's money review of #4335, LEVE): when two tabs connect at once, each opens an account at
// Stripe (app/api/stripe/connect), and only the first one written stays the store's (setStripeAccount with
// `expected: null`). The late tab, whose write answered "moved", told the creator "stripe=error": a dead end, though
// the store already had an account waiting to be onboarded. Now the late tab reads the store again and sends the
// creator to onboard the account the store keeps, never its own unwritten one, and does not tell the creator again
// that an account was connected (the first tab did). With no account on the store at that read, or a read that cannot
// be told, and for every other refused write ("shape", "none"), the answer stays "stripe=error" and no onboarding link
// is asked for. The late tab's own account stays an orphan at Stripe, as before.
// Synthetic store and session; Stripe mocked (no network); MemoryRedis (tests/redis-stub.ts); `after` held
// (tests/next-server-after-world.ts, aliased in tests/aliases/stripe-connect-race-kept.test.ts.json).
import { NextRequest } from "next/server";
import { POST as connectPOST } from "@/app/api/stripe/connect/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, clearStripeAccount, ownerKey, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as memory } from "./redis-stub";
import { afterTasks } from "./next-server-after-world";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_stripe_connect_race_kept_only";
const KEPT = "acct_1RaceKeptFirst";
const LATE = "acct_1RaceKeptLate";

/** Runs once, while Stripe is opening the late tab's account: what the other tab did meanwhile. */
let meanwhile: (() => Promise<void>) | null = null;
/** The id Stripe answers the late tab's account opening with. */
let opens = LATE;
/** Every account an onboarding link was asked for, in order. */
const linked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com") throw new Error(`Unexpected synthetic provider request: ${url}`);
  const step = meanwhile;
  meanwhile = null;
  if (step) await step();
  if (url.pathname === "/v2/core/accounts" && init?.method === "POST") return Response.json({ id: opens });
  if (url.pathname === "/v2/core/account_links" && init?.method === "POST") {
    const account = String((JSON.parse(String(init.body)) as { account?: unknown }).account);
    linked.push(account);
    return Response.json({ url: `https://connect.stripe.com/setup/synthetic/${account}` });
  }
  throw new Error(`Unexpected synthetic provider request: ${url}`);
}) as typeof fetch;

/**
 * Before the `nth` read of the store record alone (a pipeline of one GET of its owner key) from now on, runs `step`;
 * when `step` gives an answer, that answer stands in for the read's reply. Disarmed once it has run.
 */
let watch: { owner: string; nth: number; step: () => Promise<unknown[] | void> } | null = null;
const pipeline = memory.pipeline.bind(memory);
memory.pipeline = (async (commands: (string | number)[][]) => {
  const armed = watch;
  if (armed && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === armed.owner) {
    armed.nth -= 1;
    if (armed.nth === 0) {
      watch = null;
      const reply = await armed.step();
      if (reply) return reply;
    }
  }
  return pipeline(commands);
}) as typeof memory.pipeline;

async function main() {
  const email = "stripe-race-kept@example.com";
  is("synthetic store", (await claimHandle(email, "stripracekept", "A store", "")).ok, true);
  const owner = await ownerKey(email);
  const session = await openSession(email);
  const posted = { cookie: `${SESSION_COOKIE}=${session}`, origin: "https://marktmorgen.com", host: "marktmorgen.com" };
  const connect = () => {
    const body = new FormData();
    body.set("country", "US");
    return connectPOST(new NextRequest("https://marktmorgen.com/api/stripe/connect", { method: "POST", headers: posted, body }));
  };
  const said = (response: Response) => new URL(response.headers.get("location") ?? "", "https://marktmorgen.com").searchParams.get("stripe");
  /** The other tab's connect opened its account first and wrote it down. */
  const otherTabWrites = async () => {
    is("the other tab's account written", (await setStripeAccount(email, KEPT, false, { expected: null })).ok, true);
  };
  const reset = async () => {
    await clearStripeAccount(email);
    linked.length = 0;
    opens = LATE;
    watch = null;
  };

  part("a late tab that lost the race onboards the account the store keeps");
  await reset();
  let notices = afterTasks.length;
  meanwhile = otherTabWrites;
  const late = await connect();
  is("the first account stays the store's", (await storeForEmail(email))?.stripeAccountId, KEPT);
  is("answered with a redirect", late.status, 303);
  is("sent to onboard the account the store keeps", late.headers.get("location"), `https://connect.stripe.com/setup/synthetic/${KEPT}`);
  is("an onboarding link asked only for the kept account, never the late tab's own", linked, [KEPT]);
  is("the creator is not told again that an account was connected", afterTasks.length, notices);

  part("the store has no account when read again: stripe=error, no link");
  await reset();
  meanwhile = async () => {
    await otherTabWrites();
    // The late tab's write reads the store first (it finds the other account and refuses); before the next read of the
    // store, the creator lets that account go in a third tab.
    watch = { owner, nth: 2, step: async () => { await clearStripeAccount(email); } };
  };
  const gone = await connect();
  is("the store is read again after the refused write", watch, null);
  watch = null;
  is("the account let go meanwhile stays let go", (await storeForEmail(email))?.stripeAccountId ?? null, null);
  is("the creator is told it failed", said(gone), "error");
  is("no onboarding link asked for", linked, []);

  part("the store read again cannot be told: stripe=error, no link");
  await reset();
  meanwhile = async () => {
    await otherTabWrites();
    watch = { owner, nth: 2, step: async () => ["{not a store record"] };
  };
  const unread = await connect();
  is("the store is read again after the refused write", watch, null);
  watch = null; // a read that never came does not catch the checks below
  is("the creator is told it failed", said(unread), "error");
  is("no onboarding link asked for", linked, []);
  is("the kept account stays", (await storeForEmail(email))?.stripeAccountId, KEPT);

  part("a refused write of another kind (shape): stripe=error, no link");
  await reset();
  opens = "not-an-account-id";
  const shape = await connect();
  is("the creator is told it failed", said(shape), "error");
  is("no onboarding link asked for", linked, []);
  is("nothing written", (await storeForEmail(email))?.stripeAccountId ?? null, null);

  part("healthy control: the tab that writes first onboards its own account and tells the creator");
  await reset();
  notices = afterTasks.length;
  const first = await connect();
  is("written", (await storeForEmail(email))?.stripeAccountId, LATE);
  is("sent to onboard it", [first.status, first.headers.get("location")], [303, `https://connect.stripe.com/setup/synthetic/${LATE}`]);
  is("the creator is told once", afterTasks.length, notices + 1);

  part("a refused write of another kind (none: the store is gone meanwhile): stripe=error, no link");
  await reset();
  meanwhile = async () => {
    await memory.pipeline([["DEL", owner]]);
  };
  const none = await connect();
  is("the creator is told it failed", said(none), "error");
  is("no onboarding link asked for", linked, []);
  done();
}

void main();
