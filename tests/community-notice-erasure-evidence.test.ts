import { test } from "node:test";
import assert from "node:assert/strict";
import { allNoticesOf, forgetNoticesPerson } from "@/lib/community-notify";
import { COPIERS } from "@/lib/person-copy";
import { UnknownReplyError } from "@/lib/redis-reply";
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

/*
 * The copy of a member's data (lib/person-copy.ts, the community section) reads every notice they have through
 * allNoticesOf (CX-123 rule 24). A ZREVRANGE answered in another shape, or a kept notice that does not read, is not
 * "fewer notices": it throws UnknownReplyError, and copyPerson fails the whole copy instead of handing one over as
 * complete without them. Only the notice list's own read is answered off-shape here; every other read is the stand-in's.
 */
const noticeRow = (post: string, at: number) => JSON.stringify({ kind: "reply", post, comment: "", by: "CREATOR", words: "synthetic", at });

async function withNoticeReply<T>(reply: (real: unknown[]) => unknown, run: () => Promise<T>): Promise<T> {
  const original: typeof store.pipeline = store.pipeline.bind(store);
  store.pipeline = async (batch) => {
    const real = await original(batch);
    return (batch.length === 1 && batch[0][0] === "ZREVRANGE" && batch[0][1] === LIST ? reply(real) : real) as unknown[];
  };
  try {
    return await run();
  } finally {
    store.pipeline = original;
  }
}

const errorName = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "no error";
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  }
};

const copier = COPIERS["lib/community-erasure.ts"];
const scope = { communityId: COMMUNITY, learner: MEMBER } as unknown as Parameters<typeof copier>[0];
/** The community section's notifications; a member with nothing kept has no section at all (an empty copy). */
const notificationsOf = async () => ((await copier(scope)) as { notifications: unknown[] }[]).flatMap((r) => r.notifications);

test("a member's notices for their data copy: healthy and empty read exactly as before", async () => {
  store.clear();
  assert.deepEqual(await allNoticesOf(COMMUNITY, MEMBER), []);
  assert.deepEqual(await notificationsOf(), []);
  await store.pipeline([["ZADD", LIST, 100, noticeRow("p-old", 100)], ["ZADD", LIST, 200, noticeRow("p-new", 200)]]);
  assert.deepEqual(
    (await allNoticesOf(COMMUNITY, MEMBER)).map((n) => [n.post, n.at]),
    [["p-new", 200], ["p-old", 100]],
  );
  assert.deepEqual(await notificationsOf(), [
    { kind: "reply", post: "p-new", at: new Date(200_000).toISOString() },
    { kind: "reply", post: "p-old", at: new Date(100_000).toISOString() },
  ]);
});

test("a member's notices answered in an unknown shape throw, and the copy is never handed over without them", async () => {
  store.clear();
  await store.pipeline([["ZADD", LIST, 100, noticeRow("p-kept", 100)]]);
  let getters = 0;
  const accessorSlot: unknown[] = [];
  Object.defineProperty(accessorSlot, 0, { get() { getters += 1; return [noticeRow("p-kept", 100)]; } });
  const accessorMember: unknown[] = [];
  Object.defineProperty(accessorMember, 0, { get() { getters += 1; return noticeRow("p-kept", 100); } });
  const whole: [string, unknown][] = [
    ["null pipeline", null],
    ["undefined pipeline", undefined],
    ["object pipeline", {}],
    ["no reply", []],
    ["two replies", [[], []]],
    ["a hole for the reply", Array(1)],
    ["a getter for the reply", accessorSlot],
    ["array-like pipeline", { 0: [], length: 1 }],
  ];
  const one: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a string", noticeRow("p-kept", 100)],
    ["a number", 0],
    ["an object", {}],
    ["a number member", [1]],
    ["a null member", [null]],
    ["a nested list", [[noticeRow("p-kept", 100)]]],
    ["a hole member", Array(1)],
    ["a getter member", accessorMember],
    ["array-like", { 0: noticeRow("p-kept", 100), length: 1 }],
  ];
  const cases: [string, (real: unknown[]) => unknown][] = [
    ...whole.map(([what, reply]): [string, () => unknown] => [what, () => reply]),
    ...one.map(([what, reply]): [string, () => unknown] => [what, () => [reply]]),
  ];
  for (const [what, reply] of cases) {
    assert.equal(await withNoticeReply(reply, () => errorName(() => allNoticesOf(COMMUNITY, MEMBER))), "UnknownReplyError", `${what}: allNoticesOf`);
    assert.equal(await withNoticeReply(reply, () => errorName(() => copier(scope))), "UnknownReplyError", `${what}: the copy`);
  }
  assert.equal(getters, 0);
});

test("a kept notice that does not read throws, never a shorter copy", async () => {
  for (const bad of ["", "not json", "null", '"a string"', "[]", JSON.stringify({ post: 1, by: "CREATOR" }), JSON.stringify({ post: "p", by: 2 })]) {
    store.clear();
    await store.pipeline([["ZADD", LIST, 100, noticeRow("p-kept", 100)], ["ZADD", LIST, 200, bad || " "]]);
    if (!bad) await store.pipeline([["ZREM", LIST, " "]]);
    const reply = bad ? undefined : (real: unknown[]) => [[...(real[0] as string[]), ""]];
    const read = () => errorName(() => allNoticesOf(COMMUNITY, MEMBER));
    const copy = () => errorName(() => copier(scope));
    assert.equal(reply ? await withNoticeReply(reply, read) : await read(), "UnknownReplyError", `${JSON.stringify(bad)}: allNoticesOf`);
    assert.equal(reply ? await withNoticeReply(reply, copy) : await copy(), "UnknownReplyError", `${JSON.stringify(bad)}: the copy`);
  }
});
