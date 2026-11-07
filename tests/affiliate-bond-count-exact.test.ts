/**
 * How many buyers a store has bonded to its affiliates, for the creator's own
 * screen (lib/affiliate-bond.ts, bondCount; rule 24): HLEN's own count, read
 * exactly. A store with no bonds yet answers 0, a real count; a reply in any
 * other shape is unknown and shown as unknown (null), never as 0 bonds.
 *
 * Synthetic only: the in-memory Redis, its pipeline answered by hand.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bondCount } from "@/lib/affiliate-bond";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const STATS = "st_bond_count";
const KEY = `nl:aff:${STATS}:bond`;
const store = { handle: "harbor", name: "Harbor Kitchen", statsId: STATS } as unknown as Store;

/** Runs `read` with the HLEN of the bonds answered by `reply`; every other call goes to the stub. */
async function answered<T>(reply: unknown, read: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.length === 1 && commands[0]?.[0] === "HLEN" && commands[0]?.[1] === KEY ? reply : original(commands)) as typeof redis.pipeline;
  try {
    return await read();
  } finally {
    redis.pipeline = original;
  }
}

beforeEach(() => redis.clear());

test("read exactly: none yet is 0, and the bonds kept are counted", async () => {
  assert.equal(await bondCount(store), 0, "no bonds yet: a real 0");
  redis.run(["HSET", KEY, "h1", "a1b2c3d4e5f6"]);
  redis.run(["HSET", KEY, "h2", "b1b2c3d4e5f6"]);
  assert.equal(await bondCount(store), 2);
  assert.equal(await bondCount({ ...store, statsId: null } as unknown as Store), 0, "a store with no numbers yet has none");
});

test("a count in an unknown shape is shown as unknown, never as 0 bonds", async () => {
  const odd: [string, unknown][] = [
    ["text", ["2"]],
    ["null", [null]],
    ["below zero", [-1]],
    ["a fraction", [1.5]],
    ["not a number", [Number.NaN]],
    ["true", [true]],
    ["an object", [{}]],
    ["an empty answer", []],
    ["two replies to one command", [2, 2]],
    ["not a list", null],
  ];
  for (const [label, reply] of odd) assert.equal(await answered(reply, () => bondCount(store)), null, label);
});
