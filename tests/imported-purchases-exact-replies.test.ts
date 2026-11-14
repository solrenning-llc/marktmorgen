import assert from "node:assert/strict";
import {
  forgetImportedPerson,
  grantImported,
  importedBuyers,
  importedFrom,
  importedKey,
  takeGiven,
} from "@/lib/imported-purchases";
import { paidCourses } from "@/lib/learn";
import { addProduct, claimHandle, ensureStatsId, setPastBuyers, setProductCourse, storeForEmail } from "@/lib/store";
import type { DataStore } from "@/lib/store-data";
import { store as redis } from "./redis-stub";

let passed = 0;
let failed = 0;

async function check(name: string, work: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await work();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const realPipeline = redis.pipeline.bind(redis) as Pipeline;

async function withReplies<T>(replies: unknown[][], work: () => Promise<T>): Promise<T> {
  const queue = replies.map((reply) => [...reply]);
  (redis as unknown as { pipeline: Pipeline }).pipeline = async () => {
    const reply = queue.shift();
    if (!reply) throw new Error("No synthetic Redis reply left");
    return reply;
  };
  try {
    const value = await work();
    assert.equal(queue.length, 0, "every synthetic reply is used");
    return value;
  } finally {
    (redis as unknown as { pipeline: Pipeline }).pipeline = realPipeline;
  }
}

const valid = (job = "0123456789abcdef01234567") => JSON.stringify({
  at: 1_793_293_200,
  job,
  items: null,
  option: null,
});

const ROOM = { sid: "import-exact", statsId: "a".repeat(24), handle: "import-exact" } as DataStore;

async function main(): Promise<void> {
  await check("control: an exact imported-buyer hash is read", async () => {
    const buyers = await withReplies([[ ["buyer@example.com", "1793293200"] ]], () => importedBuyers("a".repeat(24)));
    assert.deepEqual([...buyers], [["buyer@example.com", 1_793_293_200]]);
  });

  await check("a malformed buyer time is unknown, never zero", async () => {
    await assert.rejects(() => withReplies([[ ["buyer@example.com", "not-a-time"] ]], () => importedBuyers("a".repeat(24))));
  });

  await check("a partial buyer list is unknown before the closing notice can advance", async () => {
    await assert.rejects(() => withReplies([[ ["good@example.com", "1793293200", "bad@example.com", "not-a-time"] ]], () => importedBuyers("a".repeat(24))));
  });

  await check("control: an exact imported purchase is admitted", () => {
    assert.deepEqual(importedFrom(["course_1", valid()]).map((row) => row.productId), ["course_1"]);
  });

  await check("a legacy exact purchase without items is still admitted", () => {
    assert.deepEqual(importedFrom(["course_1", JSON.stringify({ at: 1_793_293_200, job: "api:legacy" })]), [{
      productId: "course_1",
      at: 1_793_293_200,
      job: "api:legacy",
      items: null,
      option: null,
    }]);
  });

  await check("one legible purchase survives an incomplete neighbour", () => {
    assert.deepEqual(importedFrom(["course_1", valid(), "course_2"]).map((row) => row.productId), ["course_1"]);
  });

  await check("an incomplete purchase with no legible row is unknown", () => {
    assert.throws(() => importedFrom(["course_1"]));
  });

  await check("missing purchase fields never become time zero and an empty job", () => {
    assert.throws(() => importedFrom(["course_1", JSON.stringify({ items: null })]));
  });

  await check("a malformed bundle item invalidates that kept purchase", () => {
    const malformed = JSON.stringify({ at: 1_793_293_200, job: "0123456789abcdef01234567", items: ["lesson_1", 7], option: null });
    assert.throws(() => importedFrom(["course_1", malformed]));
  });

  await check("control: exact grant replies preserve one result per request", async () => {
    const answer = await withReplies([
      [[1, 0]],
      [1, 0],
    ], () => grantImported("a".repeat(24), "api:key", [
      { email: "a@example.com", productId: "course_1", items: null },
      { email: "b@example.com", productId: "course_1", items: null },
    ], undefined, "", ROOM));
    assert.deepEqual(answer, [true, false]);
  });

  await check("a partial grant reply is unknown, never a shorter success list", async () => {
    await assert.rejects(() => withReplies([
      [[1, 0]],
      [1],
    ], () => grantImported("a".repeat(24), "api:key", [
      { email: "a@example.com", productId: "course_1", items: null },
      { email: "b@example.com", productId: "course_1", items: null },
    ], undefined, "", ROOM)));
  });

  await check("a string grant acknowledgement is unknown, never success", async () => {
    await assert.rejects(() => withReplies([
      [[1, 0]],
      ["1"],
    ], () => grantImported("a".repeat(24), "api:key", [
      { email: "a@example.com", productId: "course_1", items: null },
    ], undefined, "", ROOM)));
  });

  await check("control: an exact take-back acknowledgement is accepted", async () => {
    assert.equal(await withReplies([[valid("api:key")], [1]], () => takeGiven("a".repeat(24), "a@example.com", "course_1", "api:")), true);
  });

  await check("a string take-back acknowledgement is unknown, never success", async () => {
    await assert.rejects(() => withReplies([[valid("api:key")], ["1"]], () => takeGiven("a".repeat(24), "a@example.com", "course_1", "api:")));
  });

  await check("control: exact erasure replies are counted", async () => {
    assert.equal(await withReplies([[1, 1]], () => forgetImportedPerson("a".repeat(24), "a@example.com")), 2);
  });

  await check("a partial erasure reply is unknown, never reported as completed work", async () => {
    await assert.rejects(() => withReplies([[1]], () => forgetImportedPerson("a".repeat(24), "a@example.com")));
  });

  await check("a malformed kept purchase is unknown at the real course-access caller", async () => {
    redis.clear();
    const owner = "owner-import-exact@example.test";
    const buyer = "buyer-import-exact@example.test";
    assert.ok((await claimHandle(owner, "import-exact", "Import exact", "")).ok);
    await ensureStatsId(owner);
    await setPastBuyers(owner);
    const made = await addProduct(owner, "Imported course", "", "12", null);
    assert.ok(made.ok);
    await setProductCourse(owner, made.product.id, { id: "a".repeat(32), lessons: 1 });
    const store = (await storeForEmail(owner))!;
    await redis.pipeline([["HSET", importedKey(store.statsId!, buyer), made.product.id, JSON.stringify({ items: null })]]);
    await assert.rejects(() => paidCourses(store, buyer));
  });

  await check("a store without imported buyers does not parse a missing imported reply", async () => {
    redis.clear();
    const owner = "owner-without-imports@example.test";
    const buyer = "buyer-without-imports@example.test";
    assert.ok((await claimHandle(owner, "without-imports", "Without imports", "")).ok);
    await ensureStatsId(owner);
    const made = await addProduct(owner, "Ordinary course", "", "12", null);
    assert.ok(made.ok);
    await setProductCourse(owner, made.product.id, { id: "b".repeat(32), lessons: 1 });
    const store = (await storeForEmail(owner))!;
    assert.deepEqual(await paidCourses(store, buyer), new Map());
  });

  console.log(`RESULT ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
