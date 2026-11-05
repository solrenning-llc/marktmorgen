import test from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { claimHeldRecheck, heldStoreKnown, heldStoresDue, readHeldMonth, recordHeldMonth } from "@/lib/held-stores";

const DAY = Date.UTC(2026, 9, 31, 12);
const MONTH = ["0", "1", "2026-10-31", "1"];

test("ordinary frozen Redis evidence preserves each reader with one original command", async () => {
  const pipeline = redis.pipeline.bind(redis);
  const seen: unknown[][][] = [];
  redis.pipeline = async commands => {
    seen.push(commands);
    const value = commands[0]?.[0] === "ZSCORE" ? "0" : commands[0]?.[0] === "ZRANGEBYSCORE" ? Object.freeze(["kept@example.test"]) : Object.freeze(MONTH.slice());
    return Object.freeze([value]) as unknown as unknown[];
  };
  try {
    assert.equal(await heldStoreKnown("kept@example.test"), true);
    assert.deepEqual(await heldStoresDue(DAY), ["kept@example.test"]);
    assert.deepEqual(await readHeldMonth("2026-10"), { month: "2026-10", count: 0, peak: 1 });
    assert.deepEqual(seen.map(commands => commands.length), [1, 1, 1]);
    assert.deepEqual(seen.map(commands => commands[0]?.[0]), ["ZSCORE", "ZRANGEBYSCORE", "HMGET"]);
  } finally { redis.pipeline = pipeline; }
});

test("malformed outer evidence refuses absence or a completed aggregate without executable reads", async () => {
  const pipeline = redis.pipeline.bind(redis);
  let executed = 0;
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, "0", { enumerable: true, get() { executed++; return null; } });
  const revoked = Proxy.revocable([null], {}); revoked.revoke();
  const symbolic: unknown[] = [null]; Object.defineProperty(symbolic, Symbol("hidden"), { value: 1 });
  const extra: unknown[] = [null]; Object.defineProperty(extra, "hidden", { value: 1 });
  // Async return values are probed for `then` by Promise resolution before
  // the consumer sees them. Count only reflection by the actual reader.
  const proxy = new Proxy([null], { get(_target, key) { if (key === "then") return undefined; executed++; throw Error("read trap"); }, getPrototypeOf() { executed++; throw Error("prototype trap"); }, ownKeys() { executed++; throw Error("keys trap"); } });
  try {
    for (const reply of [[], Array(1), [null, null], accessor, revoked.proxy, proxy, symbolic, extra]) {
      redis.pipeline = async () => reply;
      await assert.rejects(heldStoreKnown("kept@example.test"));
      await assert.rejects(heldStoresDue(DAY));
      assert.equal(await readHeldMonth("2026-10"), null);
    }
    assert.equal(executed, 0);
    redis.pipeline = async () => [null];
    assert.equal(await heldStoreKnown("kept@example.test"), false);
    redis.pipeline = async () => [[]];
    assert.deepEqual(await heldStoresDue(DAY), []);
  } finally { redis.pipeline = pipeline; }
});

test("nested month and candidate replies refuse hidden metadata and non-data slots", async () => {
  const pipeline = redis.pipeline.bind(redis);
  let executed = 0;
  const withExtra = (values: unknown[]) => { Object.defineProperty(values, "hidden", { value: 1 }); return values; };
  const withSymbol = (values: unknown[]) => { Object.defineProperty(values, Symbol("hidden"), { value: 1 }); return values; };
  const hidden = (values: unknown[]) => { Object.defineProperty(values, "0", { value: values[0], enumerable: false }); return values; };
  try {
    for (const change of [withExtra, withSymbol, hidden]) {
      redis.pipeline = async commands => [change(commands[0]?.[0] === "HMGET" ? MONTH.slice() : ["kept@example.test"])];
      await assert.rejects(heldStoresDue(DAY));
      assert.equal(await readHeldMonth("2026-10"), null);
    }
    const score = { valueOf() { executed++; return 0; }, toString() { executed++; return "0"; } };
    redis.pipeline = async () => [score];
    await assert.rejects(heldStoreKnown("kept@example.test"));
    redis.pipeline = async () => [[score, "1", "2026-10-31", "1"]];
    assert.equal(await readHeldMonth("2026-10"), null);
    assert.equal(executed, 0);
  } finally { redis.pipeline = pipeline; }
});

test("strict write acknowledgements keep lost claims consumed and malformed replies unauthorized", async () => {
  redis.clear();
  const pipeline = redis.pipeline.bind(redis), realNow = Date.now;
  Date.now = () => DAY;
  let executed = 0;
  const response = new Proxy([1], { get(target, key, receiver) { if (key !== "then") executed++; return Reflect.get(target, key, receiver); } });
  redis.pipeline = async commands => {
    const result = await pipeline(commands);
    return String(commands[0]?.[1]).startsWith("-- marktmorgen:held-recheck") ? response : result;
  };
  try {
    assert.equal(await claimHeldRecheck("lost@example.test", DAY), false);
    assert.equal(executed, 0);
    redis.pipeline = pipeline;
    assert.equal(await claimHeldRecheck("lost@example.test", DAY), false);
    redis.pipeline = async () => [1, 1];
    await assert.rejects(recordHeldMonth(DAY, true), /unknown/);
    redis.pipeline = async () => [1];
    await recordHeldMonth(DAY, true);
  } finally { redis.pipeline = pipeline; Date.now = realNow; }
});
