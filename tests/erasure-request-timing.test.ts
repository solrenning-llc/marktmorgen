/**
 * The public deletion form answers in the same time for every address
 * (review of #2101, inbox C4-15 (3)(a)). Whether a store knows the address,
 * and the email to it, used to run before the answer, and only for an address
 * a store knows: with a slow email provider, a known address waited and a
 * stranger's did not, and a failed send gave "error" to a known address only.
 * Now both happen after the answer (lib/erasure-request.ts, afterAnswer), with
 * one store chosen and with every store, and a failure goes to the log.
 */
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { rememberBuyers } from "@/lib/buyer-library";
import { askErasureLink } from "@/lib/erasure-request";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { afterRuns } from "./erasure-timing-after-world";
import { done, is, part } from "./check";

// The email provider holds every send at a gate the test opens, instead of
// answering after a fixed delay: whether the answer waits for the email is read
// from the order of events, never from a clock, so a slow or busy machine
// gives the same result (tests/aliases/erasure-request-timing.test.ts.json
// keeps the tasks after() is handed, so the test can wait for them to end).
let sends = 0;
let fails = false;
let gate: Promise<void> = Promise.resolve();
let openGate: () => void = () => {};
let arrived: () => void = () => {};
let arrival: Promise<void> = new Promise((resolve) => (arrived = resolve));
function closeGate(): void {
  gate = new Promise((resolve) => (openGate = resolve));
  arrival = new Promise((resolve) => (arrived = resolve));
}
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    sends += 1;
    arrived();
    await gate;
    return fails ? new Response(JSON.stringify({ message: "down" }), { status: 500 }) : new Response(JSON.stringify({ id: `email_${sends}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

async function paidStore(handle: string): Promise<Store> {
  const owner = `owner@${handle}.example`;
  await claimHandle(owner, handle, handle, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, `acct_1${handle.replace(/[^a-z]/g, "").padEnd(14, "x").slice(0, 14)}`, true);
  await setSubscription(owner, { customerId: `cus_${handle.replace(/[^a-z0-9]/g, "")}`, subscriptionId: `sub_${handle.replace(/[^a-z0-9]/g, "")}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

/** Lets every pending promise callback run: what is still waiting after it waits on something outside. */
const drained = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Only a request that never answers and never reaches the email gets here; it is not a speed limit. */
const BLOCKED_MS = 30_000;

type Asked = {
  answer: unknown;
  /** Sends started when the answer came. */
  sendsAtAnswer: number;
  /** "answered": the answer came with every email held; "held": an email was held and the answer waited for it. */
  first: "answered" | "held" | "blocked";
  /** After the answer, an email for this address reached the provider and was still held there. */
  emailHeld: boolean;
  /** Sends once every task the answer left behind has ended. */
  emailed: number;
};

let ip = 0;
async function ask(email: string, handle?: string): Promise<Asked> {
  ip += 1;
  const before = sends;
  const runsBefore = afterRuns.length;
  closeGate();
  let answered = false;
  let sendsAtAnswer = -1;
  const answer = askErasureLink({ email, ip: `198.51.100.${ip}`, origin: "https://marktmorgen.com", ...(handle ? { handle } : {}) }).then((value) => {
    answered = true;
    sendsAtAnswer = sends - before;
    return value;
  });
  let guard: ReturnType<typeof setTimeout> | undefined;
  const blocked = new Promise<"blocked">((resolve) => (guard = setTimeout(() => resolve("blocked"), BLOCKED_MS)));
  // An email reached the held provider: once every callback has run, the answer has come unless it waits for that email.
  const held = arrival.then(drained).then((): "answered" | "held" => (answered ? "answered" : "held"));
  const first = await Promise.race([answer.then(() => "answered" as const), held, blocked]);
  clearTimeout(guard);
  const runs = Promise.all(afterRuns.slice(runsBefore));
  const emailHeld = first === "answered" && (await Promise.race([arrival.then(() => true), runs.then(() => false)])) && answered;
  openGate();
  gate = Promise.resolve();
  if (first === "blocked") return { answer: "blocked", sendsAtAnswer, first, emailHeld, emailed: sends - before };
  const value = await answer;
  await runs;
  return { answer: value, sendsAtAnswer, first, emailHeld, emailed: sends - before };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_erasure_timing_only_a_stand_in";
  const shop = await paidStore("erase-timing-shop");
  const known = (n: number) => `buyer-${n}-at-timing@example.com`;
  const stranger = (n: number) => `nobody-${n}-at-timing@example.com`;
  await rememberBuyers(shop.sid, [1, 2, 3, 4].map(known));

  let n = 0;
  for (const [what, handle] of [["one store chosen", shop.handle], ["every store", undefined]] as const) {
    part(`Asked for ${what}`);
    n += 1;
    const a = await ask(known(n), handle);
    const b = await ask(stranger(n), handle);
    is("the same answer for a known address and a stranger's", a.answer, b.answer);
    is("and that answer is 'sent'", a.answer, { status: "sent" });
    is("nothing is emailed before the answer, for either", [a.sendsAtAnswer, b.sendsAtAnswer], [0, 0]);
    is("neither waits for the email: both answer while the email provider holds every send", [a.first, b.first], ["answered", "answered"]);
    is("the known address's email reaches the provider after the answer and is still held there; the stranger's never starts", [a.emailHeld, b.emailHeld], [true, false]);
    is("the known address is emailed after the answer, the stranger's never", [a.emailed, b.emailed], [1, 0]);

    n += 1;
    fails = true;
    const aDown = await ask(known(n), handle);
    const bDown = await ask(stranger(n), handle);
    fails = false;
    is("with the email provider down, still the same answer for both", [aDown.answer, bDown.answer], [{ status: "sent" }, { status: "sent" }]);
    is("and neither waits for the failing email", [aDown.first, bDown.first], ["answered", "answered"]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
