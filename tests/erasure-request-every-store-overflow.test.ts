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

/** Every command the ask sends while `run` runs, in order, with the deferred part after the answer waited for. */
async function commandsWhile(run: () => Promise<unknown>): Promise<string[]> {
  const sent: string[] = [];
  const original = redis.pipeline;
  const error = console.error;
  const warn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  redis.pipeline = async (commands: (string | number)[][]) => {
    for (const command of commands) sent.push(String(command[0]));
    return original.call(redis, commands);
  };
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    redis.pipeline = original;
    console.error = error;
    console.warn = warn;
  }
  return sent;
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

test("the route's worst case is unchanged and the refused ask stops at the union (rule 964c, the whole route measured)", async () => {
  // The coordinator's rule 964c: a fix measures its route in the worst case against what it costs. This one adds no
  // command: the same SUNION, cut one store later. The most the ask reads is still MAX_ERASE_STORES stores, at the
  // same reads per store, and an address past it now stops right after the union, before any store read or grant.
  const known = async (count: number) => {
    redis.clear();
    const email = `measured-${count}@example.com`;
    for (let n = 1; n <= count; n += 1) await rememberBuyers((await paidStore(n)).sid, [email]);
    return commandsWhile(() => ask(email));
  };
  const one = await known(1);
  const two = await known(2);
  const most = await known(MAX_ERASE_STORES);
  const over = await known(MAX_ERASE_STORES + 1);
  const perStore = two.length - one.length;
  assert.ok(perStore > 0, "each store known costs its reads");
  assert.equal(most.length, one.length + (MAX_ERASE_STORES - 1) * perStore, "every store past the first costs the same reads, and nothing else is sent");
  assert.equal(over.lastIndexOf("SUNION"), over.length - 1, "past the most, nothing is sent after the union");
  assert.equal(over.filter((name) => name === "SUNION").length, 1, "the stores are read once");
  assert.ok(over.length < most.length, "the refused ask costs less than the most an ask can cost");
  console.log(`every-store ask: ${one.length} commands for 1 store, +${perStore} a store, ${most.length} at ${MAX_ERASE_STORES} stores (the worst), ${over.length} refused past it`);
});

test("a store past the library's cut, asked for itself, still sends its own link (Claude 5 ia5d on #5226)", async () => {
  redis.clear();
  const email = "one-at-a-time@example.com";
  const stores: Store[] = [];
  for (let n = 1; n <= MAX_ERASE_STORES + 1; n += 1) stores.push(await paidStore(n));
  for (const store of stores) await rememberBuyers(store.sid, [email]);
  const seen = new Set(await storesKnownFor(email));
  const past = stores.filter((s) => !seen.has(s.sid));
  assert.ok(past.length > 0, "the library's cut leaves a store out");
  const asked = await grantsWhile(() => askErasureLink({ email, ip: `198.51.100.${++ip}`, origin: "https://marktmorgen.com", handle: past[0].handle }));
  assert.deepEqual(asked.grants, [[past[0].sid]], "its own ask sends a link to it, never nothing");
});
