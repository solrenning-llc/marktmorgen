/**
 * An affiliate program's kept book reads Redis only in its exact shape (CX-123 rules 24 and 30; Claude 6, MÉDIO).
 *
 *   - forgetBookSnapshot, the step of a person's erasure that deletes the kept book holding their masked address
 *     (lib/affiliate-leads.ts, forgetLeadPerson): an EXISTS, a draft pointer, or the version's start or raise in another shape
 *     was read as "no book" (Number(null) === 0, a pointer not text taken as none), so the erasure ended as done
 *     while the book stayed, shown on the affiliate page for up to a day and kept for eight. Now it throws
 *     UnknownReplyError and the erasure is tried again.
 *   - The book's scripts: an answer that was not a whole number (the text "1", [1], true) was coerced by Number(),
 *     so a deletion nobody confirmed was taken as done. Now it throws, as a Redis that cannot run them does.
 *   - snapshotState, which decides whether a load buys the whole program's refresh (affiliatePageUnits of the
 *     store's window and up to 23 pages of the creator's Stripe account): a short pipeline, a field list in
 *     another shape or a count not a whole number read as 0, so a fresh book looked out of date (or a refresh
 *     already running looked absent) and was bought again. Now it is null, and the load is refused
 *     (lib/affiliate-page-admission.ts) with nothing bought.
 *
 * Synthetic data only; MemoryRedis has no HSTRLEN and none of the book's scripts, so the two the checks need are
 * stood in for here, step for step as their Lua reads (tests/public-reads-ceiling.test.ts does the same; the Lua
 * itself runs on a real Redis in tests/security/affiliate-book.redis-run.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { BOOK_FORGET, BOOK_FRESH_SECONDS, forgetBookSnapshot, needsRefresh, snapshotState } from "@/lib/affiliate-book-snapshot";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const SID = "st_bookexact01";
const BOOK = `nl:aff:${SID}:book`;
const POINTER = `nl:aff:${SID}:book:draft`;
const VERSION = `nl:aff:${SID}:book:ver`;
const AFF = "aaaaaaaaaaaa";
const NOW = Math.floor(Date.now() / 1000);
const SHOP = { statsId: SID } as unknown as Store;
const PART = JSON.stringify({ at: NOW - 60, book: { rows: [{ affiliate: { id: AFF } }], lines: [{ aff: AFF, lead: { email: "l•••@example.com" } }], payouts: [] } });

const memory = redis.pipeline.bind(redis);
const one = async (command: (string | number)[]) => (await memory([command]))[0];
/** HSTRLEN and BOOK_FORGET as the Lua reads them; everything else as MemoryRedis answers it. */
async function base(commands: (string | number)[][]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const c of commands) {
    if (c[0] === "EVAL" && c[1] === BOOK_FORGET) {
      const [book, draft, version, pointer, token, keep, now] = c.slice(3).map(String);
      const seen = await one(["GET", pointer]);
      if ((seen ?? "") !== token) { out.push(2); continue; }
      await memory([["DEL", book, draft], ["SET", version, now, "NX", "EX", keep], ["INCR", version], ["EXPIRE", version, keep]]);
      out.push(1);
    } else if (c[0] === "HSTRLEN") {
      const value = await one(["HGET", c[1], c[2]]);
      out.push(typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0);
    } else out.push(...(await memory([c])));
  }
  return out;
}
type Alter = (batch: (string | number)[][], answers: unknown[]) => unknown[];
async function withReplies<T>(alter: Alter, run: () => Promise<T>): Promise<{ value: T } | { error: unknown }> {
  redis.pipeline = (async (batch: (string | number)[][]) => alter(batch, await base(batch))) as typeof redis.pipeline;
  try {
    return await run().then((value) => ({ value }), (error) => ({ error }));
  } finally {
    redis.pipeline = memory;
  }
}
const healthy: Alter = (_batch, answers) => answers;

async function seedBook() {
  redis.clear();
  await memory([["HSET", BOOK, "_at", String(NOW - 60), "_kept", "1", "_short", "0", "_by", "tok_one", AFF, PART]]);
}
const bookLeft = async () => Number(await one(["EXISTS", BOOK]));

// --- forgetBookSnapshot ---------------------------------------------------------------------------------------

// The erasure's first read (main's #3081 shape): SET NX EX, INCR, EXPIRE (the version's raise), GET pointer, EXISTS.
const isForgetRead = (batch: (string | number)[][]) => batch.length === 5 && batch[0]?.[0] === "SET" && batch[4]?.[0] === "EXISTS";
const isForgetScript = (batch: (string | number)[][]) => batch.length === 1 && batch[0][0] === "EVAL" && batch[0][1] === BOOK_FORGET;

test("forget, healthy: the book is deleted and the version raised", async () => {
  await seedBook();
  const result = await withReplies(healthy, () => forgetBookSnapshot(SID));
  assert.ok("value" in result, "no error");
  assert.equal(await bookLeft(), 0);
  assert.ok(Number(await one(["GET", VERSION])) >= 1);
});

test("forget, confirmed empty: no book and no draft, nothing to delete, done", async () => {
  redis.clear();
  const result = await withReplies(healthy, () => forgetBookSnapshot(SID));
  assert.ok("value" in result, "no error");
  assert.ok(Number(await one(["GET", VERSION])) >= 1, "the version is raised all the same");
});

test("forget, the version already kept: its start answers null (not set again), the book is deleted, done", async () => {
  await seedBook();
  await memory([["SET", VERSION, "41", "EX", 600]]);
  const result = await withReplies(healthy, () => forgetBookSnapshot(SID));
  assert.ok("value" in result, "no error");
  assert.equal(await bookLeft(), 0);
  assert.ok(Number(await one(["GET", VERSION])) > 41, "raised from where it was");
});

const FORGET_SHAPES: [string, unknown][] = [
  ["null", null], ["empty text", ""], ["false", false], ["an empty list", []], ["the text 0", "0"], ["[0]", [0]], ["an object", { x: 1 }], ["the text 1", "1"], ["2", 2], ["-1", -1],
];
for (const [label, odd] of FORGET_SHAPES) {
  test(`forget, EXISTS answered ${label}: unknown, the erasure is not called done and is tried again`, async () => {
    await seedBook();
    const result = await withReplies((batch, answers) => (isForgetRead(batch) ? answers.map((a, i) => (i === 4 ? odd : a)) : answers), () => forgetBookSnapshot(SID));
    assert.ok("error" in result && result.error instanceof UnknownReplyError, `${label}: throws UnknownReplyError`);
  });
}

const POINTER_SHAPES: [string, unknown][] = [["a number", 5], ["a list", ["tok"]], ["an object", { token: "tok" }], ["true", true]];
for (const [label, odd] of POINTER_SHAPES) {
  test(`forget, the draft pointer answered ${label}: unknown, never taken as "no draft"`, async () => {
    redis.clear();
    await memory([["SET", POINTER, "tok_two"], ["HSET", `nl:aff:${SID}:book:new:tok_two`, AFF, PART]]);
    const result = await withReplies((batch, answers) => (isForgetRead(batch) ? answers.map((a, i) => (i === 3 ? odd : i === 4 ? 0 : a)) : answers), () => forgetBookSnapshot(SID));
    assert.ok("error" in result && result.error instanceof UnknownReplyError, `${label}: throws UnknownReplyError`);
  });
}

const READ_SHAPES: [string, Alter][] = [
  ["the version start answered 1", (batch, answers) => (isForgetRead(batch) ? [1, ...answers.slice(1)] : answers)],
  ["the version start answered true", (batch, answers) => (isForgetRead(batch) ? [true, ...answers.slice(1)] : answers)],
  ["the version start answered an empty list", (batch, answers) => (isForgetRead(batch) ? [[], ...answers.slice(1)] : answers)],
  ["the version raise answered null", (batch, answers) => (isForgetRead(batch) ? [answers[0], null, ...answers.slice(2)] : answers)],
  ["the version raise answered the text 1", (batch, answers) => (isForgetRead(batch) ? [answers[0], "1", ...answers.slice(2)] : answers)],
  ["the expiry answered null", (batch, answers) => (isForgetRead(batch) ? [answers[0], answers[1], null, ...answers.slice(3)] : answers)],
  ["the read answered four replies", (batch, answers) => (isForgetRead(batch) ? answers.slice(0, 4) : answers)],
  ["the read answered six replies", (batch, answers) => (isForgetRead(batch) ? [...answers, 0] : answers)],
  ["the read answered no list", (batch, answers) => (isForgetRead(batch) ? (null as unknown as unknown[]) : answers)],
];
for (const [label, alter] of READ_SHAPES) {
  test(`forget, ${label}: unknown, with no book in sight it is still not called done`, async () => {
    redis.clear();
    const result = await withReplies(alter, () => forgetBookSnapshot(SID));
    assert.ok("error" in result && result.error instanceof UnknownReplyError, `${label}: throws UnknownReplyError`);
  });
}

// The script's own answer, when it did nothing: never coerced into "deleted".
const SCRIPT_SHAPES: [string, unknown[]][] = [["the text 1", ["1"]], ["[1]", [[1]]], ["true", [true]], ["1.5", [1.5]], ["two answers", [1, 1]], ["none", []]];
for (const [label, odd] of SCRIPT_SHAPES) {
  test(`forget, the deletion script answered ${label} and deleted nothing: not called done`, async () => {
    await seedBook();
    // The script is not run at all here: only its answer comes back.
    redis.pipeline = (async (batch: (string | number)[][]) => (isForgetScript(batch) ? odd : base(batch))) as typeof redis.pipeline;
    const result = await forgetBookSnapshot(SID).then((value) => ({ value }), (error) => ({ error })).finally(() => { redis.pipeline = memory; });
    // On the throw it deletes what it can at once and the erasure is tried again (forgetBookSnapshot's own fallback).
    assert.ok("error" in result, `${label}: throws, so the erasure is tried again`);
    assert.equal(await bookLeft(), 0, `${label}: and the book is deleted as the throw falls back`);
  });
}

test("forget, the erasure's caller lets the throw through (lib/affiliate-leads.ts)", () => {
  const leads = readFileSync("lib/affiliate-leads.ts", "utf8");
  assert.equal((leads.match(/await forgetBookSnapshot\(statsId\);/g) ?? []).length, 2, "both calls awaited, not caught");
  assert.ok(!/forgetBookSnapshot\(statsId\)\.catch/.test(leads));
});

// --- snapshotState -------------------------------------------------------------------------------------------

const isStateRead = (batch: (string | number)[][]) => batch.length === 4 && batch[0]?.[0] === "HMGET" && batch[1]?.[0] === "HSTRLEN";

test("state, healthy: a fresh kept book, nothing to buy", async () => {
  await seedBook();
  const result = await withReplies(healthy, () => snapshotState(SHOP, AFF));
  assert.ok("value" in result);
  assert.deepEqual(result.value, { at: NOW - 60, kept: true, freshFor: BOOK_FRESH_SECONDS, sliceBytes: Buffer.byteLength(PART, "utf8"), triedAt: 0, tries: 0 });
  assert.equal(needsRefresh(result.value!, NOW), false);
});

test("state, confirmed empty: no book kept, so the refresh is due", async () => {
  redis.clear();
  const result = await withReplies(healthy, () => snapshotState(SHOP, AFF));
  assert.ok("value" in result);
  assert.deepEqual(result.value, { at: 0, kept: false, freshFor: BOOK_FRESH_SECONDS, sliceBytes: 0, triedAt: 0, tries: 0 });
});

test("state, a refresh running: its mark and tries are read", async () => {
  await seedBook();
  await memory([["SET", `nl:aff:${SID}:book:tried`, String(NOW - 30)], ["SET", `nl:aff:${SID}:book:tries`, "2"]]);
  const result = await withReplies(healthy, () => snapshotState(SHOP, AFF));
  assert.ok("value" in result && result.value);
  assert.equal(result.value.triedAt, NOW - 30);
  assert.equal(result.value.tries, 2);
});

const at = (i: number, odd: unknown): Alter => (batch, answers) => (isStateRead(batch) ? answers.map((a, j) => (j === i ? odd : a)) : answers);
const meta = (odd: unknown): Alter => at(0, odd);
const STATE_SHAPES: [string, Alter][] = [
  ["the fields answered null", meta(null)],
  ["the fields answered one of three", meta([String(NOW - 60)])],
  ["the fields answered four", meta([String(NOW - 60), "1", "0", "x"])],
  ["the fields answered an object", meta({ 0: String(NOW - 60), 1: "1", 2: "0", length: 3 })],
  ["the time answered empty text", meta(["", "1", "0"])],
  ["the time answered 1e9", meta(["1e9", "1", "0"])],
  ["the time answered a number", meta([NOW - 60, "1", "0"])],
  ["the kept mark answered a number", meta([String(NOW - 60), 1, "0"])],
  ["the part's length answered null", at(1, null)],
  ["the part's length answered the text 12", at(1, "12")],
  ["the part's length answered 1.5", at(1, 1.5)],
  ["the refresh mark answered empty text", at(2, "")],
  ["the refresh mark answered a number", at(2, NOW - 30)],
  ["the tries answered 1e3", at(3, "1e3")],
  ["the tries answered a list", at(3, ["1"])],
  ["the read answered two replies", (batch, answers) => (isStateRead(batch) ? answers.slice(0, 2) : answers)],
  ["the read answered five replies", (batch, answers) => (isStateRead(batch) ? [...answers, null] : answers)],
];
for (const [label, alter] of STATE_SHAPES) {
  test(`state, ${label}: unknown, null, so no refresh is bought on it`, async () => {
    await seedBook();
    const result = await withReplies(alter, () => snapshotState(SHOP, AFF));
    assert.ok("value" in result, "the state never throws");
    assert.equal(result.value, null, `${label}: null`);
  });
}

test("state: the approved affiliate's load is refused on a null state, before anything is taken", () => {
  const admission = readFileSync("lib/affiliate-page-admission.ts", "utf8");
  const read = admission.lastIndexOf("const state = await snapshotState(store, affiliate.id);");
  assert.ok(read > 0 && admission.indexOf("if (!state) return REFUSED;", read) > read);
  assert.ok(admission.indexOf("if (!again || !needsRefresh(again, seconds)) return null;") > 0, "the refresh re-reads and stops on null");
});
