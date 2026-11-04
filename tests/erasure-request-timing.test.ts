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
import { done, is, part } from "./check";

const SLOW_MS = 400;
let sends = 0;
let fails = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    sends += 1;
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
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

const settled = () => new Promise((resolve) => setTimeout(resolve, SLOW_MS * 3));
let ip = 0;
async function timed(email: string, handle?: string): Promise<{ answer: unknown; ms: number; sendsBefore: number }> {
  ip += 1;
  const before = sends;
  const start = performance.now();
  const answer = await askErasureLink({ email, ip: `198.51.100.${ip}`, origin: "https://marktmorgen.com", ...(handle ? { handle } : {}) });
  return { answer, ms: performance.now() - start, sendsBefore: sends - before };
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
    const sentAtStart = sends;
    const a = await timed(known(n), handle);
    await settled();
    const emailed = sends - sentAtStart;
    const b = await timed(stranger(n), handle);
    await settled();
    is("the same answer for a known address and a stranger's", a.answer, b.answer);
    is("and that answer is 'sent'", a.answer, { status: "sent" });
    is("nothing is emailed before the answer, for either", [a.sendsBefore, b.sendsBefore], [0, 0]);
    is(`neither waits for the slow email (${SLOW_MS} ms)`, [a.ms < SLOW_MS / 2, b.ms < SLOW_MS / 2], [true, true]);
    is("the known address is emailed after the answer, the stranger's never", [emailed, sends - sentAtStart], [1, 1]);

    n += 1;
    fails = true;
    const aDown = await timed(known(n), handle);
    await settled();
    const bDown = await timed(stranger(n), handle);
    await settled();
    fails = false;
    is("with the email provider down, still the same answer for both", [aDown.answer, bDown.answer], [{ status: "sent" }, { status: "sent" }]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
