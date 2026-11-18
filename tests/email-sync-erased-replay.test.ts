/**
 * Privacy (erase-then-replay): a person deleted from a store is never handed to the creator's email platform — a third
 * party — on a yes they gave before the deletion. The thank-you page has no age limit and a sale's "told" mark lasts
 * 40 days (lib/sale-events.ts), the "handed over" mark 30 (lib/email-sync.ts SEEN_SECONDS): reloading the thank-you
 * page of an order placed before the deletion, after those marks, ran queuePerson again with the checkout's consent and
 * queued the address for the platform, although the deletion (lib/person-erasure.ts) had cleared their jobs. Now
 * queuePerson reads the store's deletion print (lib/suppression.ts) first: a person whose consent is from before the
 * deletion's second is "off", with nothing written and nothing logged; a new yes after it is handed over as anyone's.
 * Synthetic data only; nothing is sent anywhere (the queue is only read).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { QUEUE_KEY, queuePerson } from "@/lib/email-sync";
import { suppressCommand, suppressedKey, suppressionPrint } from "@/lib/suppression";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const STATS = "erasedsync0001";
const LIST = "e1a5ed0000aa";
const store = { statsId: STATS, listId: LIST } as Store;
const WHO = "deleted.buyer@example.com";
const cfgKey = `nl:esync:cfg:${STATS}`;
const logKey = `nl:esync:log:${STATS}`;
const ORDER_AT = Date.parse("2026-11-01T10:00:00Z");
const ERASED_SECONDS = Date.parse("2026-11-05T12:00:00Z") / 1000;
let n = 0;
const person = (email: string, at: number, consent = true) => ({ source: "purchase" as const, email, name: "Dana Reyes", products: [], consent, seed: `cs_test_erased${(n += 1)}`, at });

function reset(): void {
  redis.clear();
  redis.run(["SET", cfgKey, JSON.stringify({ handle: "erased", provider: "kit", key: "sealed-stand-in", last4: "0000", target: { id: "t1", name: "Synthetic list" }, free: true, buyers: "all", products: [], tags: {}, since: ORDER_AT - 86_400_000, connectedAt: ORDER_AT - 86_400_000 })]);
  redis.run(suppressCommand(LIST, WHO, ERASED_SECONDS));
}
const isPublication = (c: (string | number)[]) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:esync-enqueue:v1");
const writesJob = (c: (string | number)[]) => (c[0] === "SET" && String(c[1]).startsWith("nl:esync:j:")) || isPublication(c);
const queueSize = () => Number(redis.run(["ZCARD", QUEUE_KEY]));
const logSize = () => Number(redis.run(["LLEN", logKey]));
const holdsAddress = () => (redis.run(["LRANGE", logKey, 0, -1]) as string[]).some((id) => String(redis.run(["GET", `nl:esync:j:${id}`]) ?? "").includes(WHO));

test("a yes from before the deletion, replayed after it, hands nothing over and logs nothing", async () => {
  reset();
  assert.equal(await queuePerson(store, person(WHO, ORDER_AT)), "off");
  assert.equal(queueSize(), 0);
  assert.equal(logSize(), 0);
  assert.equal(holdsAddress(), false);
  // In capitals, as a checkout may give it: the same person.
  assert.equal(await queuePerson(store, person(" Deleted.Buyer@Example.com ", ORDER_AT)), "off");
  assert.equal(queueSize(), 0);
});

test("a yes in the very second of the deletion is not known to be after it", async () => {
  reset();
  assert.equal(await queuePerson(store, person(WHO, ERASED_SECONDS * 1000 + 500)), "off");
  assert.equal(queueSize(), 0);
});

test("a new purchase with the box checked after the deletion is handed over as anyone's", async () => {
  reset();
  assert.equal(await queuePerson(store, person(WHO, (ERASED_SECONDS + 60) * 1000)), "queued");
  assert.equal(queueSize(), 1);
  assert.equal(holdsAddress(), true);
});

test("someone never deleted is handed over as before", async () => {
  reset();
  assert.equal(await queuePerson(store, person("kept.buyer@example.com", ORDER_AT)), "queued");
  assert.equal(queueSize(), 1);
});

test("a deletion print that does not read is unknown: nothing written, never taken as not deleted", async () => {
  for (const value of ["yesterday", "17.5", ""]) {
    reset();
    redis.run(["HSET", suppressedKey(LIST), suppressionPrint(LIST, WHO), value]);
    await assert.rejects(queuePerson(store, person(WHO, (ERASED_SECONDS + 60) * 1000)));
    assert.equal(queueSize(), 0, value);
    assert.equal(logSize(), 0, value);
  }
});

/**
 * Codex C2 (5876565212) and Codex G (5876832230): the deletion can land between the first read of its print and the
 * job's write, and the job would then go to the platform. The erasure writes the print before it deletes any job
 * (lib/person-erasure.ts), so queuePerson reads the print again inside the step publishing the job.
 * A deletion that came in between prevents the job from being written.
 */
test("a deletion landing between the check and the job's write hands nothing over", async () => {
  reset();
  const KEPT = "late.deleted@example.com";
  const real = redis.pipeline.bind(redis);
  let landed = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!landed && commands.some(writesJob)) {
      landed = true;
      // The erasure, at this moment: its print first, then its jobs (none yet).
      await real([suppressCommand(LIST, KEPT, Math.floor(Date.now() / 1000))]);
    }
    return real(commands);
  }) as typeof redis.pipeline;
  let answer: string;
  try {
    answer = await queuePerson(store, person(KEPT, ORDER_AT));
  } finally {
    redis.pipeline = real;
  }
  assert.equal(landed, true, "the deletion landed after the first check");
  assert.equal(answer, "off");
  assert.equal(queueSize(), 0, "nothing waits for the platform");
  assert.equal((redis.run(["LRANGE", logKey, 0, -1]) as string[]).some((id) => String(redis.run(["GET", `nl:esync:j:${id}`]) ?? "").includes(KEPT)), false, "and no job holds the address");
});

test("a background worker cannot claim a job for consent erased before publication", async () => {
  reset();
  const email = "background.deleted@example.test";
  const pipeline = redis.pipeline.bind(redis);
  let raced = false;
  let visibleToWorker: number | undefined;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (raced || !commands.some(writesJob)) return pipeline(commands);
    raced = true;
    await pipeline([suppressCommand(LIST, email, ERASED_SECONDS)]);
    const written = await pipeline(commands);
    visibleToWorker = (redis.run(["ZRANGEBYSCORE", QUEUE_KEY, "-inf", Date.now()]) as string[]).length;
    return written;
  }) as typeof redis.pipeline;
  try {
    assert.equal(await queuePerson(store, person(email, ORDER_AT)), "off");
  } finally {
    redis.pipeline = pipeline;
  }
  assert.equal(raced, true);
  assert.equal(visibleToWorker, 0, "the cron saw no eligible job for erased consent");
  assert.equal(queueSize(), 0);
});

test("the deletion's reads are counted (Claude 4 and Codex N1): HAND_OVER_ERASED_READS, named in the cost registry", async () => {
  reset();
  const { HAND_OVER_ERASED_READS } = await import("@/lib/email-sync");
  const { COST_LINES } = await import("./plan-cost-registry");
  const real = redis.pipeline.bind(redis);
  let reads = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    reads += commands.filter((c) => (c[0] === "HGET" && c[1] === suppressedKey(LIST)) || (isPublication(c) && c[6] === suppressedKey(LIST))).length;
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    assert.equal(await queuePerson(store, person("counted.buyer@example.com", ORDER_AT)), "queued");
  } finally {
    redis.pipeline = real;
  }
  assert.equal(reads, HAND_OVER_ERASED_READS, "a person handed over reads the deletion print this many times");
  const named = COST_LINES.filter((line) => line.sources.some((s) => s.file === "lib/email-sync.ts" && s.names.includes("HAND_OVER_ERASED_READS"))).map((line) => line.id);
  assert.deepEqual(named.sort(), ["orders", "public-requests"], "the orders line and the public requests line (sign-ups, free copies) name them");
});
