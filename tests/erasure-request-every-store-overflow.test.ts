/**
 * An "every store" deletion request never sends a link to part of the stores that know the address (#5010 row 108,
 * Codex T-20261119-1120). storesKnownFor cut the list at MAX_LIBRARY_STORES (60) and askErasureLink cut it again at
 * MAX_ERASE_STORES (60): for an address known to 61 stores, the link covered the first 60, the person finished the
 * deletion and was told it was done, and the 61st store kept everything about them. Now the request reads one store
 * more than a link can hold: past MAX_ERASE_STORES, no partial link is made, and the failure goes to the server's log;
 * the page, as for every other failure after the answer, gives the published privacy contact. The buyer library keeps
 * its own limit. Synthetic, in-memory Redis only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_LIBRARY_STORES, rememberBuyers, storesKnownFor } from "@/lib/buyer-library";
import { askErasureLink } from "@/lib/erasure-request";
import { MAX_ERASE_STORES } from "@/lib/erasure-rules";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_erasure_overflow_only_a_stand_in";

async function paidStore(n: number): Promise<Store> {
  const handle = `overflow-${n}`;
  const owner = `owner@${handle}.example`;
  await claimHandle(owner, handle, handle, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, `acct_1ovf${String(n).padStart(10, "0")}`, true);
  await setSubscription(owner, { customerId: `cus_ovf${n}`, subscriptionId: `sub_ovf${n}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

/** The deletion grants written while `run` runs (SET nl:erase:link:*), as their store ids, and the errors logged. */
async function grantsWhile(run: () => Promise<unknown>): Promise<{ grants: string[][]; logged: string[] }> {
  const grants: string[][] = [];
  const logged: string[] = [];
  const original = redis.pipeline;
  const error = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  redis.pipeline = async (commands: (string | number)[][]) => {
    const [name, key, value] = commands[0] ?? [];
    if (name === "SET" && typeof key === "string" && key.startsWith("nl:erase:link:")) grants.push((JSON.parse(String(value)) as { s: string[] }).s);
    return original.call(redis, commands);
  };
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    redis.pipeline = original;
    console.error = error;
  }
  return { grants, logged };
}

let ip = 0;
const ask = (email: string) => askErasureLink({ email, ip: `198.51.100.${++ip}`, origin: "https://marktmorgen.com" });

test("an address known to more stores than one link holds gets no partial link", async () => {
  redis.clear();
  const email = "many-stores@example.com";
  const stores: Store[] = [];
  for (let n = 1; n <= MAX_ERASE_STORES + 1; n += 1) stores.push(await paidStore(n));
  for (const store of stores) await rememberBuyers(store.sid, [email]);
  assert.equal((await storesKnownFor(email, MAX_ERASE_STORES + 1)).length, MAX_ERASE_STORES + 1, "the request can see the 61st store");
  const { grants, logged } = await grantsWhile(() => ask(email));
  assert.deepEqual(grants, [], "no link to part of the stores: the 61st would keep everything while the person is told it is done");
  assert.ok(logged.some((line) => /every store|cannot fit/i.test(line)), "the refusal goes to the server's log");
});

test("an address known to a few stores still gets one link for all of them", async () => {
  redis.clear();
  const email = "few-stores@example.com";
  const one = await paidStore(1);
  const two = await paidStore(2);
  await rememberBuyers(one.sid, [email]);
  await rememberBuyers(two.sid, [email]);
  const { grants } = await grantsWhile(() => ask(email));
  assert.deepEqual(grants.map((g) => [...g].sort()), [[one.sid, two.sid].sort()]);
});

test("the buyer library keeps its own limit", async () => {
  redis.clear();
  const email = "library-limit@example.com";
  for (let n = 1; n <= MAX_LIBRARY_STORES + 2; n += 1) await rememberBuyers(n.toString(16).padStart(32, "0"), [email]);
  assert.equal((await storesKnownFor(email)).length, MAX_LIBRARY_STORES);
});
