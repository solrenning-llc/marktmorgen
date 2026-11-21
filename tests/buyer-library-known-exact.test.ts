/**
 * Rule 24 for the stores that know an address (lib/buyer-library.ts,
 * storesKnownFor): an unreadable reply is unknown, never "no stores".
 *
 * The list feeds the deletion form asked for every store
 * (lib/erasure-request.ts) and the person's copy (lib/person-copy.ts). Read
 * as "no stores", a reply out of shape made the deletion ask end in silence,
 * as if no store knew the address, and the copy say the store was not in the
 * person's library. Now it throws UnknownReplyError: the copy fails whole, and
 * the deletion ask is logged as failed. A confirmed empty set stays empty.
 * Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { forgetLibraryPerson, rememberBuyers, storesBoughtFrom, storesKnownFor } from "@/lib/buyer-library";
import { askErasureLink } from "@/lib/erasure-request";
import { COPIERS } from "@/lib/person-copy";
import type { ErasureScope } from "@/lib/erasure-rules";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`no network in this test: ${String(input instanceof Request ? input.url : input)}`);
}) as typeof fetch;

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_library_exact_only_a_stand_in";

const BUYER = "buyer@library-exact.example";
const STRANGER = "stranger@library-exact.example";

redis.clear();
const fixture = (async () => {
  const owner = "owner@library-exact.example";
  await claimHandle(owner, "libraryexact", "Library Exact", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  const store = (await storeForEmail(owner))!;
  await rememberBuyers(store.sid!, [BUYER]);
  return store.sid!;
})();

/** Every SUNION answers `reply`; every other command is the stub's. */
async function withUnion<T>(reply: () => unknown, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = async (commands: (string | number)[][]) =>
    (commands[0]?.[0] === "SUNION" ? reply() : original.call(redis, commands)) as Awaited<ReturnType<typeof original>>;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const MALFORMED: [string, () => unknown][] = [
  ["no reply at all", () => []],
  ["a null in its slot", () => [null]],
  ["a number in its slot", () => [3]],
  ["an object in its slot", () => [{}]],
  ["a string in its slot", () => ["0123456789abcdef0123456789abcdef"]],
  ["a list with a number in it", () => [[1]]],
  ["a list with a hole", () => [new Array(1)]],
  ["two replies for one command", () => [[], []]],
];

for (const [label, reply] of MALFORMED) {
  test(`the stores that know an address: ${label} is unknown, never no stores`, async () => {
    await fixture;
    await withUnion(reply, () => assert.rejects(() => storesKnownFor(BUYER), UnknownReplyError));
  });
}

test("the stores an address bought from: a slot out of shape is unknown too", async () => {
  await fixture;
  for (const reply of [() => [null], () => [3], () => [[1]]]) {
    await withUnion(reply, () => assert.rejects(() => storesBoughtFrom(BUYER), UnknownReplyError));
  }
});

test("the person's copy fails whole on an unknown list, never says the store is not in their library", async () => {
  const sid = await fixture;
  const scope = { email: BUYER, sid } as unknown as ErasureScope;
  await withUnion(() => [null], () => assert.rejects(() => COPIERS["lib/buyer-library.ts"](scope), UnknownReplyError));
  // Healthy control: the same copier reads it.
  assert.deepEqual(await COPIERS["lib/buyer-library.ts"](scope), [{ inYourLibrary: true }]);
});

test("a deletion ask for every store on an unknown list is logged as failed, never ends in silence as no store", async () => {
  await fixture;
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    await withUnion(
      () => [null],
      async () => {
        const answer = await askErasureLink({ email: BUYER, ip: "203.0.113.24", origin: "https://marktmorgen.test" });
        // The page answers the same for every address (review C4-7): that does not change.
        assert.equal(answer.status, "sent");
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    );
  } finally {
    console.error = error;
  }
  assert.ok(logged.some((line) => line.includes("emailing a deletion link failed") && line.includes("UnknownReplyError")), `logged: ${JSON.stringify(logged)}`);
});

test("healthy control and confirmed absence: the store is known to its buyer, no store to a stranger", async () => {
  const sid = await fixture;
  assert.deepEqual(await storesKnownFor(BUYER), [sid]);
  assert.deepEqual(await storesBoughtFrom(BUYER), [sid]);
  assert.deepEqual(await storesKnownFor(STRANGER), []);
  assert.deepEqual(await storesBoughtFrom(STRANGER), []);
  await withUnion(() => [[]], async () => assert.deepEqual(await storesKnownFor(BUYER), []));
});

/** Every pipeline made only of SREM answers `reply(commands)`; every other pipeline is the stub's. */
async function withForget<T>(reply: (count: number) => unknown, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = async (commands: (string | number)[][]) =>
    (commands.length && commands.every((c) => c[0] === "SREM") ? reply(commands.length) : original.call(redis, commands)) as Awaited<
      ReturnType<typeof original>
    >;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const FORGET_MALFORMED: [string, (count: number) => unknown][] = [
  ["no reply at all", () => []],
  ["one reply short", (count) => new Array(count - 1).fill(0)],
  ["one reply too many", (count) => new Array(count + 1).fill(0)],
  ["a null in a slot", (count) => [null, ...new Array(count - 1).fill(0)]],
  ["an error object in a slot", (count) => [{ error: "ERR" }, ...new Array(count - 1).fill(0)]],
  ["a string in a slot", (count) => ["1", ...new Array(count - 1).fill(0)]],
  ["a negative number in a slot", (count) => [-1, ...new Array(count - 1).fill(0)]],
  ["more than one member removed by one SREM", (count) => [2, ...new Array(count - 1).fill(0)]],
  ["a hole in the list", (count) => new Array(count)],
];

for (const [label, reply] of FORGET_MALFORMED) {
  test(`forgetting a library's store: ${label} is unknown, never 0 records erased`, async () => {
    const sid = await fixture;
    await withForget(reply, () => assert.rejects(() => forgetLibraryPerson(sid, BUYER), UnknownReplyError));
    // Nothing was removed by the odd answer: the store is still known to its buyer.
    assert.deepEqual(await storesKnownFor(BUYER), [sid]);
  });
}

test("forgetting a library's store: healthy control and confirmed nothing to forget", async () => {
  const sid = await fixture;
  const erased = "erased@library-exact.example";
  await rememberBuyers(sid, [erased]);
  assert.deepEqual(await storesKnownFor(erased), [sid]);
  assert.equal(await forgetLibraryPerson(sid, erased), 1);
  assert.deepEqual(await storesKnownFor(erased), []);
  // Exact zeros: confirmed nothing left to forget.
  assert.equal(await forgetLibraryPerson(sid, erased), 0);
  assert.equal(await forgetLibraryPerson(sid, STRANGER), 0);
});
