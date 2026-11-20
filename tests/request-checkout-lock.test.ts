/**
 * Rule 24 (an unknown answer fails closed) on a payment request's checkout
 * lock (lib/payment-request-store.ts holdForCheckout/letGo, used by
 * openRequestCheckout and markPaidOutside in lib/payment-requests.ts).
 *
 * The lock is what keeps two presses at once from opening two payments for
 * one request side by side. So:
 *   - it is held only on Redis's exact "OK" to SET NX: a reply cut short or of
 *     another shape is not a lock, and no checkout opens and nothing is marked;
 *   - it is let go only by the press that took it: a press that ran past the
 *     lock's expiry never deletes the lock the next press took since, which
 *     would let a third press in beside the second.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readDraft } from "@/lib/payment-request-rules";
import { createRequest, requestOf } from "@/lib/payment-request-store";
import { markPaidOutside, openRequestCheckout } from "@/lib/payment-requests";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_request_checkout_lock_only";

let creates = 0;
let stall: Promise<void> | null = null;
let entered: () => void = () => undefined;
const sessions = new Map<string, Record<string, unknown>>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    creates += 1;
    const id = `cs_test_${String(creates).padStart(24, "k")}`;
    const session = { id, status: "open", payment_status: "unpaid", url: `https://checkout.stripe.com/c/pay/${id}`, created: Math.floor(Date.now() / 1000) };
    sessions.set(id, session);
    if (stall) {
      entered();
      await stall;
    }
    return answer(session);
  }
  if (path.startsWith("/checkout/sessions/") && method === "GET") {
    const found = sessions.get(decodeURIComponent(path.slice("/checkout/sessions/".length)));
    return found ? answer(found) : answer({ error: { code: "resource_missing", message: "No such checkout" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const lockKey = (id: string) => `nl:payreq:lock:${id}`;
const ORIGIN = "https://marktmorgen.com";

/** Answers the SET on a request's lock key with `reply` instead of Redis's own answer; everything else as it is. */
function offShapeLock(reply: unknown[]): () => void {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith("nl:payreq:lock:")) return reply;
    return real(commands);
  }) as typeof redis.pipeline;
  return () => {
    redis.pipeline = real;
  };
}

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Lock Test Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1Lock${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();
  const store = await paidStore("lock@example.com", "lockcoach");
  let n = 0;
  const make = async (): Promise<string> => {
    n += 1;
    const draft = readDraft({ email: `client${n}@example.com`, name: "Client", lines: [{ text: "Coaching, November", quantity: 1, amount: "120" }], note: "", dueDate: "", autoReminders: 0, consent: true }, store.currency);
    if (!draft.ok) throw new Error(`draft ${draft.problem}`);
    const made = await createRequest(store, draft.draft);
    if (!made.ok) throw new Error(made.reason);
    return made.request.id;
  };
  const exists = async (key: string) => (await redis.pipeline([["EXISTS", key]]))[0];

  part("An off-shape answer to the lock's SET NX is no lock");
  for (const [label, reply] of [
    ["undefined", [undefined]],
    ["a number", [1]],
    ["no item at all", []],
    ["a wrapped OK", [{ result: "OK" }]],
  ] as [string, unknown[]][]) {
    const id = await make();
    const before = creates;
    const restore = offShapeLock(reply);
    let answer: unknown;
    try {
      answer = await openRequestCheckout(store, id, ORIGIN);
    } catch (error) {
      answer = { threw: String(error) };
    } finally {
      restore();
    }
    is(`${label}: no checkout is opened at Stripe`, creates - before, 0);
    is(`${label}: the buyer is told it is busy, never sent to a page`, answer, { ok: false, reason: "busy" });
    is(`${label}: the request keeps no checkout`, (await requestOf(store, id))?.session ?? "", "");

    const marked = await make();
    const restoreMark = offShapeLock(reply);
    let markAnswer: unknown;
    try {
      markAnswer = await markPaidOutside(store, marked, { method: "cash", note: "", paidAt: Date.now() });
    } catch (error) {
      markAnswer = { threw: String(error) };
    } finally {
      restoreMark();
    }
    is(`${label}: marking it paid outside is refused as busy`, markAnswer, { ok: false, reason: "busy" });
    is(`${label}: and it stays open`, (await requestOf(store, marked))?.state, "open");
  }

  part("Two presses at once: one checkout");
  const twice = await make();
  const before = creates;
  const both = await Promise.all([openRequestCheckout(store, twice, ORIGIN), openRequestCheckout(store, twice, ORIGIN)]);
  is("exactly one checkout is created at Stripe", creates - before, 1);
  is("one press is sent to it, the other is told it is busy", both.map((a) => (a.ok ? "url" : a.reason)).sort(), ["busy", "url"]);
  is("and the lock is let go after", await exists(lockKey(twice)), 0);

  part("A press that ran past its lock never lets go of the next press's lock");
  const slow = await make();
  let release: () => void = () => undefined;
  stall = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inStripe = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = openRequestCheckout(store, slow, ORIGIN);
  await inStripe;
  // The first press's lock ran out while Stripe was slow, and a second press took it.
  redis.run(["SET", lockKey(slow), "second-press-token", "EX", 60]);
  stall = null;
  release();
  await first;
  is("the second press's lock is still there after the first press lets go", (await redis.pipeline([["GET", lockKey(slow)]]))[0], "second-press-token");
  const third = creates;
  const thirdAnswer = await openRequestCheckout(store, slow, ORIGIN);
  is("so a third press is told it is busy", thirdAnswer.ok ? "url" : thirdAnswer.reason, "busy");
  is("and opens nothing at Stripe", creates - third, 0);
  redis.run(["DEL", lockKey(slow)]);

  const slowMark = await make();
  await openRequestCheckout(store, slowMark, ORIGIN);
  const session = (await requestOf(store, slowMark))!.session;
  const realFetch = globalThis.fetch;
  let markRelease: () => void = () => undefined;
  const markStall = new Promise<void>((resolve) => {
    markRelease = resolve;
  });
  let markEntered: () => void = () => undefined;
  const markIn = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input instanceof Request ? input.url : input).includes(`/checkout/sessions/${session}`) && (init?.method ?? "GET") === "GET") {
      markEntered();
      await markStall;
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const marking = markPaidOutside(store, slowMark, { method: "cash", note: "", paidAt: Date.now() });
  await markIn;
  redis.run(["SET", lockKey(slowMark), "second-press-token", "EX", 60]);
  markRelease();
  await marking;
  globalThis.fetch = realFetch;
  is("marking paid outside lets go only of its own lock too", (await redis.pipeline([["GET", lockKey(slowMark)]]))[0], "second-press-token");
  redis.run(["DEL", lockKey(slowMark)]);

  part("One press: one checkout, the lock let go after");
  const single = await make();
  const one = creates;
  const opened = await openRequestCheckout(store, single, ORIGIN);
  is("sent to Stripe's page", opened.ok ? opened.url.startsWith("https://checkout.stripe.com/") : opened.reason, true);
  is("one checkout created", creates - one, 1);
  is("the checkout is kept on the request", (await requestOf(store, single))?.session.startsWith("cs_test_"), true);
  is("the lock is let go after", await exists(lockKey(single)), 0);
  const marked = await make();
  is("marking paid outside still works", (await markPaidOutside(store, marked, { method: "cash", note: "", paidAt: Date.now() })).ok, true);
  is("and lets go of its lock", await exists(lockKey(marked)), 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
