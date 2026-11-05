import assert from "node:assert/strict";
import {
  forgetImportedPerson,
  grantImported,
  importedBuyers,
  importedFrom,
  takeGiven,
} from "../../lib/imported-purchases";
import { answerOrder, answerRedis } from "./imported-purchases-read-world";

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

const valid = (job = "0123456789abcdef01234567") => JSON.stringify({
  at: 1_793_293_200,
  job,
  items: null,
  option: null,
});

async function main(): Promise<void> {
await check("control: exact imported-buyer hash is read", async () => {
  answerRedis([["buyer@example.com", "1793293200"]]);
  assert.deepEqual([...await importedBuyers("a".repeat(24))], [["buyer@example.com", 1_793_293_200]]);
});

await check("odd HGETALL is unknown, never a partial buyer list", async () => {
  answerRedis([["buyer@example.com", "1793293200", "dangling@example.com"]]);
  await assert.rejects(() => importedBuyers("a".repeat(24)));
});

await check("malformed imported-buyer time is unknown, never zero", async () => {
  answerRedis([["buyer@example.com", "not-a-time"]]);
  await assert.rejects(() => importedBuyers("a".repeat(24)));
});

await check("control: exact imported purchase is admitted", () => {
  assert.deepEqual(importedFrom(["course_1", valid()]).map((row) => row.productId), ["course_1"]);
});

await check("odd HGETALL never grants the confirmed prefix", () => {
  assert.deepEqual(importedFrom(["course_1", valid(), "course_2"]), []);
});

await check("missing purchase fields never become at zero and an empty job", () => {
  assert.deepEqual(importedFrom(["course_1", JSON.stringify({ items: null })]), []);
});

await check("one malformed bundle item invalidates the whole kept purchase", () => {
  const malformed = JSON.stringify({ at: 1_793_293_200, job: "0123456789abcdef01234567", items: ["lesson_1", 7], option: null });
  assert.deepEqual(importedFrom(["course_1", malformed]), []);
});

await check("control: exact grant replies preserve one result per request", async () => {
  answerOrder([1, 0]);
  assert.deepEqual(await grantImported("a".repeat(24), "api:key", [
    { email: "a@example.com", productId: "course_1", items: null },
    { email: "b@example.com", productId: "course_1", items: null },
  ]), [true, false]);
});

await check("partial grant reply is unknown, never a shorter success list", async () => {
  answerOrder([1]);
  await assert.rejects(() => grantImported("a".repeat(24), "api:key", [
    { email: "a@example.com", productId: "course_1", items: null },
    { email: "b@example.com", productId: "course_1", items: null },
  ]));
});

await check("string grant acknowledgement is unknown, never success", async () => {
  answerOrder(["1"]);
  await assert.rejects(() => grantImported("a".repeat(24), "api:key", [
    { email: "a@example.com", productId: "course_1", items: null },
  ]));
});

await check("control: exact take-back acknowledgement is accepted", async () => {
  answerRedis([valid("api:key")], [1]);
  assert.equal(await takeGiven("a".repeat(24), "a@example.com", "course_1", "api:"), true);
});

await check("string take-back acknowledgement is unknown, never success", async () => {
  answerRedis([valid("api:key")], ["1"]);
  assert.equal(await takeGiven("a".repeat(24), "a@example.com", "course_1", "api:"), false);
});

await check("control: exact erasure replies are counted", async () => {
  answerRedis([1, 1]);
  assert.equal(await forgetImportedPerson("a".repeat(24), "a@example.com"), 2);
});

await check("partial erasure reply is unknown, never reported as complete work", async () => {
  answerRedis([1]);
  await assert.rejects(() => forgetImportedPerson("a".repeat(24), "a@example.com"));
});

console.log(`RESULT ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
