/**
 * Proof, Claude 4 (rule 24 sweep, marks-exact-small): welcomeFor
 * (lib/welcome-offer-send.ts) starts a person's welcome offer once with
 * SET NX and raises the store's "offered" counter (nl:wo:n:<statsId>, shown in
 * the studio) when that SET was new. It read "new" as `made !== null`, so a
 * reply of any other shape (a missing envelope, "QUEUED", a number, a
 * lower-case "ok") raised the counter as if a new person had been offered it.
 * Expected: only an exact "OK" raises it; nil (already begun) does not; any
 * other answer does not either and is reported, and no offer is shown on it
 * (its start is unknown too: tests/welcome-offer-start-exact.test.ts).
 */
import { welcomeFor } from "@/lib/welcome-offer-send";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWelcomeOffer, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_welcome_count_only_a_stand_in";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

const OWNER = "count-owner@example.com";
const HOUR = 3600;

const real = redis.pipeline.bind(redis);
let odd: unknown = undefined;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (odd !== undefined && commands[0]?.[0] === "SET" && String(commands[0]?.[1] ?? "").startsWith("nl:wo:start:")) return odd as unknown[];
  return real(commands);
}) as typeof redis.pipeline;

const reported: string[] = [];
const error = console.error;
console.error = (...args: unknown[]) => {
  reported.push(args.map(String).join(" "));
};

async function counted(statsId: string): Promise<number> {
  const [n] = await real([["GET", `nl:wo:n:${statsId}`]]);
  return Number(n ?? 0);
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "countkitchen", "Count Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_WelcomeCnt1", true);
  await setSubscription(OWNER, { customerId: "cus_WelcomeCnt01", subscriptionId: "sub_WelcomeCnt01", active: true, period: paidPeriod() });
  const free = await addProduct(OWNER, "Pantry Guide", "", "0", null);
  const paid = await addProduct(OWNER, "Knife Skills", "", "49", null);
  if (!free.ok || !paid.ok) throw new Error("no products");
  for (const p of [free, paid]) await setProductLink(OWNER, p.product.id, "https://example.com/file");
  await setWelcomeOffer(OWNER, { product: paid.product.id, percent: 25, hours: 48, coupon: "c_welcome25", remind: true, address: "1 Main St, Springfield, IL 62701" });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const asked = Math.floor(Date.now() / 1000) - 60;
  const at = new Date(asked * 1000).toISOString();
  const claimFor = (e: string) => ({ e, p: free.product.id, at });

  part("Controls: a new person is counted once, a returning one is not");
  const first = await welcomeFor(store, claimFor("new@example.com"), asked + 60);
  is("a new person: the offer, and the counter raised to one", [first?.until, await counted(statsId)], [asked + 48 * HOUR, 1]);
  const again = await welcomeFor(store, claimFor("new@example.com"), asked + 2 * HOUR);
  is("the same person again (nil): the same end, the counter unchanged", [again?.until, await counted(statsId)], [asked + 48 * HOUR, 1]);
  is("nothing reported for the exact answers", reported.length, 0);

  part("An answer in no known shape never raises the counter, and is reported");
  const BAD: [string, unknown][] = [
    ["no envelope", []],
    ["one reply for two commands", ["OK"]],
    ["QUEUED", ["QUEUED", String(asked)]],
    ["lower-case ok", ["ok", String(asked)]],
    ["a number", [1, String(asked)]],
    ["true", [true, String(asked)]],
    ["an extra reply", ["OK", String(asked), "OK"]],
    ["not a list", { result: "OK" }],
  ];
  let i = 0;
  for (const [label, reply] of BAD) {
    i += 1;
    const before = reported.length;
    odd = reply;
    const offer = await welcomeFor(store, claimFor(`odd${i}@example.com`), asked + 60).catch(() => null);
    odd = undefined;
    is(`${label}: the counter stays at one`, await counted(statsId), 1);
    is(`${label}: reported`, reported.length > before, true);
    // The start is unknown too (review of #3298, rule 24): no offer is shown on it (tests/welcome-offer-start-exact.test.ts).
    is(`${label}: no offer is shown`, offer, null);
  }

  part("An exact OK still counts");
  await welcomeFor(store, claimFor("second@example.com"), asked + 60);
  is("a second new person: the counter is two", await counted(statsId), 2);

  console.error = error;
  done();
}

void main();
