import test from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { heldStoreKnown, heldStoresDue, readHeldMonth } from "@/lib/held-stores";

const DAY = Date.UTC(2026, 9, 1, 12);

test("held-store readers reject partial Redis envelopes before interpreting absence", async () => {
  const pipeline = redis.pipeline.bind(redis);
  try {
    redis.pipeline = async commands => {
      if (commands[0]?.[0] === "ZSCORE") return [null, "unexpected"];
      if (commands[0]?.[0] === "ZRANGEBYSCORE") return [];
      return pipeline(commands);
    };
    await assert.rejects(heldStoreKnown("held-partial@example.test"), /unknown/);
    await assert.rejects(heldStoresDue(DAY), /unknown/);
  } finally {
    redis.pipeline = pipeline;
  }
});

test("held-store readers never execute accessors supplied as Redis evidence", async () => {
  const pipeline = redis.pipeline.bind(redis);
  let reads = 0;
  const outer: unknown[] = [];
  Object.defineProperty(outer, "0", { enumerable: true, get() { reads++; return null; } });
  const rows: unknown[] = [];
  Object.defineProperty(rows, "0", { enumerable: true, get() { reads++; return "hidden@example.test"; } });
  redis.pipeline = async commands => commands[0]?.[0] === "ZSCORE" ? outer : [rows];
  try {
    await assert.rejects(heldStoreKnown("held-getter@example.test"), /unknown/);
    await assert.rejects(heldStoresDue(DAY), /unknown/);
    assert.equal(reads, 0);
  } finally {
    redis.pipeline = pipeline;
  }
});

test("sparse, inherited and proxied candidate lists never become an empty due list", async () => {
  const pipeline = redis.pipeline.bind(redis);
  const sparse = Array(1);
  const inherited = Array(1);
  Object.setPrototypeOf(inherited, ["inherited@example.test"]);
  let traps = 0;
  const proxied = new Proxy(["kept@example.test", ""], {
    get(target, key, receiver) {
      traps++;
      if (key === "length") return 1;
      return Reflect.get(target, key, receiver);
    },
  });
  try {
    for (const rows of [sparse, inherited, proxied]) {
      redis.pipeline = async commands => commands[0]?.[0] === "ZRANGEBYSCORE" ? [rows] : pipeline(commands);
      await assert.rejects(heldStoresDue(DAY), /unknown/);
    }
    assert.equal(traps, 0);
  } finally {
    redis.pipeline = pipeline;
  }
});

test("monthly held aggregates reject an executable outer reply", async () => {
  const pipeline = redis.pipeline.bind(redis);
  let reads = 0;
  const outer: unknown[] = [];
  Object.defineProperty(outer, "0", { enumerable: true, get() { reads++; return [0, 0, "2026-10-31", "1"]; } });
  redis.pipeline = async commands => commands[0]?.[0] === "HMGET" ? outer : pipeline(commands);
  try {
    assert.equal(await readHeldMonth("2026-10"), null);
    assert.equal(reads, 0);
  } finally {
    redis.pipeline = pipeline;
  }
});
