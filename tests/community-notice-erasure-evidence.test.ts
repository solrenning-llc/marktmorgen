import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetNoticesPerson } from "@/lib/community-notify";
import { store } from "./redis-stub";

const COMMUNITY = "notice-erasure-evidence";
const MEMBER = "b2b2b2b2b2b2";
const LIST = `nl:cm:${COMMUNITY}:nt:${MEMBER}`;
const SEEN = `nl:cm:${COMMUNITY}:nt:s:${MEMBER}`;

test("community notice erasure requires one exact Redis deletion acknowledgement", async () => {
  store.clear();
  const original: typeof store.pipeline = store.pipeline.bind(store);
  let getters = 0;
  const accessorReply: unknown[] = [];
  Object.defineProperty(accessorReply, 0, { get() { getters += 1; return 2; } });
  const malformed: unknown[] = [
    null,
    undefined,
    false,
    0,
    1,
    2,
    "OK",
    {},
    [],
    Array(1),
    [undefined],
    [null],
    [false],
    ["0"],
    ["1"],
    ["2"],
    [-1],
    [3],
    [1.5],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [0, 1],
    [2, 0],
    { 0: 2, length: 1 },
    accessorReply,
  ];
  try {
    for (const reply of malformed) {
      const commands: (string | number)[][] = [];
      store.pipeline = async batch => { commands.push(...batch); return reply as unknown[]; };
      await assert.rejects(forgetNoticesPerson(COMMUNITY, MEMBER));
      assert.deepEqual(commands, [["DEL", LIST, SEEN]]);
    }
  } finally {
    store.pipeline = original;
  }
  assert.equal(getters, 0);
});

test("community notice erasure accepts only possible two-key DEL counts", async () => {
  const original: typeof store.pipeline = store.pipeline.bind(store);
  try {
    for (const count of [0, 1, 2]) {
      const commands: (string | number)[][] = [];
      store.pipeline = async batch => { commands.push(...batch); return [count]; };
      assert.equal(await forgetNoticesPerson(COMMUNITY, MEMBER), count);
      assert.deepEqual(commands, [["DEL", LIST, SEEN]]);
    }
  } finally {
    store.pipeline = original;
  }
});

test("community notice erasure rejects an acknowledgement inherited from Object.prototype", async () => {
  const originalPipeline: typeof store.pipeline = store.pipeline.bind(store);
  const originalValue = Object.getOwnPropertyDescriptor(Object.prototype, "value");
  const accessorReply: unknown[] = [];
  Object.defineProperty(accessorReply, 0, { get() { return 2; } });
  Object.defineProperty(Object.prototype, "value", { configurable: true, value: 2 });
  try {
    store.pipeline = async () => accessorReply;
    await assert.rejects(forgetNoticesPerson(COMMUNITY, MEMBER));
  } finally {
    store.pipeline = originalPipeline;
    if (originalValue) Object.defineProperty(Object.prototype, "value", originalValue);
    else delete (Object.prototype as { value?: unknown }).value;
  }
});

test("an applied notice deletion with a lost acknowledgement stays unknown without replay", async () => {
  store.clear();
  const original: typeof store.pipeline = store.pipeline.bind(store);
  await original([["SET", LIST, "synthetic-list"], ["SET", SEEN, "synthetic-seen"]]);
  let writes = 0;
  try {
    store.pipeline = async batch => {
      writes += 1;
      await original(batch);
      return [];
    };
    await assert.rejects(forgetNoticesPerson(COMMUNITY, MEMBER));
  } finally {
    store.pipeline = original;
  }
  assert.equal(writes, 1);
  assert.deepEqual(await original([["EXISTS", LIST], ["EXISTS", SEEN]]), [0, 0]);
});
