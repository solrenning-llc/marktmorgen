import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetPushPerson } from "@/lib/community-push";
import { store } from "./redis-stub";

const COMMUNITY = "push-erasure-evidence";
const MEMBER = "a1a1a1a1a1a1";
const KEY = `nl:cm:${COMMUNITY}:ps:${MEMBER}`;

test("community push erasure requires one exact Redis deletion acknowledgement", async () => {
  store.clear();
  const original: typeof store.pipeline = store.pipeline.bind(store);
  let getters = 0;
  const accessorReply: unknown[] = [];
  Object.defineProperty(accessorReply, 0, { get() { getters += 1; return 1; } });
  const malformed: unknown[] = [
    null,
    undefined,
    false,
    0,
    1,
    "OK",
    {},
    [],
    Array(1),
    [undefined],
    [null],
    [false],
    ["0"],
    ["1"],
    [-1],
    [2],
    [1.5],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [0, 1],
    [1, 0],
    { 0: 1, length: 1 },
    accessorReply,
  ];
  try {
    for (const reply of malformed) {
      const commands: (string | number)[][] = [];
      store.pipeline = async batch => { commands.push(...batch); return reply as unknown[]; };
      await assert.rejects(forgetPushPerson(COMMUNITY, MEMBER));
      assert.deepEqual(commands, [["DEL", KEY]]);
    }
  } finally {
    store.pipeline = original;
  }
  assert.equal(getters, 0);
});

test("community push erasure accepts only the two possible single-key DEL counts", async () => {
  const original: typeof store.pipeline = store.pipeline.bind(store);
  try {
    for (const count of [0, 1]) {
      const commands: (string | number)[][] = [];
      store.pipeline = async batch => { commands.push(...batch); return [count]; };
      assert.equal(await forgetPushPerson(COMMUNITY, MEMBER), count);
      assert.deepEqual(commands, [["DEL", KEY]]);
    }
  } finally {
    store.pipeline = original;
  }
});

test("an applied deletion with a lost acknowledgement remains unknown and is never replayed", async () => {
  store.clear();
  const original: typeof store.pipeline = store.pipeline.bind(store);
  await original([["HSET", KEY, "https://push.example/device", "synthetic-device"]]);
  let writes = 0;
  try {
    store.pipeline = async batch => {
      writes += 1;
      await original(batch);
      return [];
    };
    await assert.rejects(forgetPushPerson(COMMUNITY, MEMBER));
  } finally {
    store.pipeline = original;
  }
  assert.equal(writes, 1);
  assert.deepEqual(await original([["HGETALL", KEY]]), [[]]);
});
