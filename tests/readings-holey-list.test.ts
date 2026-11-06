/**
 * A kept reading's erasure check (lib/store-readings.ts, keptReading, the
 * READING_COPY step) is read only in its exact shape (CX-123 rule 24/30,
 * found in the review of #2865). The step answers the places, 1-based and in
 * order, of those it names who were deleted from the store, and an empty
 * list when nobody was. Any other shape is unknown, never "nobody deleted":
 * a list with a hole (Array#every skips it), a Proxy, a getter or inherited
 * slot, a place repeated or out of order, a place outside the names, a
 * member of another type, no list at all or a pipeline of another length.
 * Each of those takes the closed branch: the copy goes and the reading is
 * shown naming nobody.
 *
 * The controls run the real step in the in-memory Redis: nobody deleted
 * keeps the reading whole; one person deleted is shown without them only.
 * Synthetic addresses and the in-memory Redis only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { keptReading } from "@/lib/store-readings";
import { suppressCommand } from "@/lib/suppression";
import { store as redis } from "./redis-stub";

type V = { names: string[] };
const LIST = "rhl-list";
const A = "erased@example.com";
const B = "kept@example.com";
const guard = { listId: LIST, names: (v: V) => v.names, without: (v: V, gone: Set<string>) => ({ names: v.names.filter((n) => !gone.has(n)) }) };

let next = 0;
type Commands = (string | number)[][];
/** The kept reading of a fresh store naming A and B, with the READING_COPY step's pipeline answered by `replies` (null: as Redis would). */
async function reading(replies: (() => unknown) | null) {
  const statsId = `rhlstats${(next += 1)}`;
  const key = `nl:reading:sales:${statsId}`;
  const original = redis.pipeline;
  await original.call(redis, [["SET", key, JSON.stringify({ at: 1, value: { names: [A, B] } })]]);
  if (replies) redis.pipeline = (async (commands: Commands) => (commands[0][0] === "EVAL" ? replies() : original.call(redis, commands))) as typeof redis.pipeline;
  try {
    const got = await keptReading({ statsId }, "sales", async () => ({ names: [A, B] }), Date.now(), true, guard);
    const [copy] = await original.call(redis, [["GET", key]]);
    return { shown: got?.value, copy };
  } finally {
    redis.pipeline = original;
  }
}

const holey = new Array(1);
const getter: unknown[] = [];
Object.defineProperty(getter, "0", { get: () => 1, enumerable: true, configurable: true });
const inherited: unknown[] = Object.setPrototypeOf([], Object.assign(Object.create(Array.prototype), { 0: 1 })) as unknown[];
inherited.length = 1;

const unknown: [string, () => unknown][] = [
  ["a hole in the place list", () => [holey]],
  ["a hole after a real place", () => [[1, , ]]],
  ["a Proxy place list", () => [new Proxy([], {})]],
  ["a getter slot", () => [getter]],
  ["an inherited slot", () => [inherited]],
  ["a place repeated (an extra entry)", () => [[1, 1]]],
  ["more places than names", () => [[1, 2, 2]]],
  ["places out of order", () => [[2, 1]]],
  ["a place past the names", () => [[3]]],
  ["a place of zero", () => [[0]]],
  ["a place as text", () => [["1"]]],
  ["a place as a fraction", () => [[1.5]]],
  ["a place as a big number", () => [[2 ** 53]]],
  ["a count instead of a list", () => [1]],
  ["nothing back", () => [null]],
  ["an empty pipeline", () => []],
  ["a pipeline with an extra reply", () => [[], []]],
  ["a holey pipeline", () => new Array(1)],
];

for (const [name, replies] of unknown) {
  test(`unknown: ${name} names nobody and keeps no copy`, async () => {
    const { shown, copy } = await reading(replies);
    assert.deepEqual(shown, { names: [] }, `${name} was read as an answer`);
    assert.equal(copy, null, `${name} left a copy kept`);
  });
}

test("control: nobody deleted keeps the reading whole, in the real step", async () => {
  const { shown, copy } = await reading(null);
  assert.deepEqual(shown, { names: [A, B] });
  assert.equal(typeof copy, "string");
  assert.deepEqual((JSON.parse(copy as string) as { value: V }).value, { names: [A, B] });
});

test("control: an empty place list answered by hand is still nobody deleted", async () => {
  const { shown } = await reading(() => [[]]);
  assert.deepEqual(shown, { names: [A, B] });
});

test("control: a frozen place list is still read", async () => {
  const { shown } = await reading(() => [Object.freeze([1])]);
  assert.deepEqual(shown, { names: [B] });
});

test("control: one person deleted is shown without them only, in the real step", async () => {
  await redis.pipeline([suppressCommand(LIST, A)]);
  try {
    const { shown, copy } = await reading(null);
    assert.deepEqual(shown, { names: [B] });
    assert.equal(copy, null);
  } finally {
    await redis.pipeline([["DEL", `nl:erased:${LIST}`]]);
  }
});
