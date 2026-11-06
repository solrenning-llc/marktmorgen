/** Independent #2858 proof. Synthetic records; the runner freezes and hashes every changed source. */
import assert from "node:assert/strict";
import test from "node:test";

type ProofWorld = {
  assignment: typeof import("@/lib/assignment");
  redis: import("@/lib/redis-memory").MemoryRedis;
  personCopy: typeof import("@/lib/person-copy");
  COURSE: string;
  LESSON: string;
  WHO: string;
  renderPage: () => Promise<string>;
};
const w = (globalThis as unknown as { __M2858?: ProofWorld }).__M2858;
if (!w) throw new Error("Run through proofs/m/review-2858-assignments.mjs");
const { assignment: a, redis, personCopy, COURSE, LESSON, WHO } = w;
const OTHER = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const key = (who = WHO, lesson = LESSON) => `nl:course:${COURSE}:task:${lesson}:sub:${who}`;
const taskKey = `nl:course:${COURSE}:task:${LESSON}`;
const waitingKey = `nl:course:${COURSE}:tasks:waiting`;
const work = () => ({ text: "Synthetic work", file: { path: "private/synthetic/internal.pdf", name: "work.pdf", bytes: 100, type: "application/pdf" }, at: 1700000000, state: "waiting", feedback: "Synthetic feedback", reviewedAt: 0, tries: 1 });
const rows = [{ lessonId: LESSON, who: WHO }];
const scope = { learner: WHO, courses: [{ productId: "prd_proof", courseId: COURSE, lessonIds: [LESSON], moduleIds: [] }] };
const copy = async () => {
  // The fixture supplies only the fields this real copier reads; unrelated scope fields are not fabricated.
  const records = await personCopy.COPIERS["lib/assignment.ts"](scope as unknown as import("@/lib/erasure-rules").ErasureScope);
  return records.map((record) => {
    assert.ok(record !== null && typeof record === "object" && !Array.isArray(record));
    return record as Record<string, unknown>;
  });
};
async function replyWith(value: unknown, run: () => Promise<unknown>) {
  const original = redis.pipeline;
  redis.pipeline = (async () => value) as typeof redis.pipeline;
  try { return await run(); } finally { redis.pipeline = original; }
}

test("control: exact work and nil remain distinct, including false task switches", async () => {
  redis.clear();
  redis.run(["SET", key(), JSON.stringify(work())]);
  assert.deepEqual(await a.submissionsOf(COURSE, rows), [work()]);
  assert.deepEqual(await a.submissionsOf(COURSE, [{ lessonId: "lessonexpor2", who: WHO }]), [null]);
  const task = { prompt: "Synthetic task", review: false, gate: false, file: false };
  redis.run(["SET", taskKey, JSON.stringify(task)]);
  assert.deepEqual(await a.readTaskFor(COURSE, LESSON), task);
});

for (const raw of ["{", "", "null", "[]", "5", JSON.stringify({ ...work(), state: "unknown" }), JSON.stringify({ ...work(), tries: -1 }), JSON.stringify({ ...work(), file: { name: "work.pdf" } })]) {
  test(`copy: unread stored shape ${raw.slice(0, 35)} remains explicitly present without raw path`, async () => {
    redis.clear();
    redis.run(["SET", key(), raw]);
    assert.deepEqual(await a.submissionsOf(COURSE, rows), [{ unread: true }]);
    const records = await copy();
    assert.equal(records.length, 1);
    assert.equal(records[0].course, "prd_proof");
    assert.equal(records[0].lesson, LESSON);
    assert.equal(typeof records[0].unread, "string");
    assert.match(records[0].unread as string, /could not be read/);
    assert.doesNotMatch(JSON.stringify(records), /private\/synthetic|internal\.pdf/);
    assert.equal(redis.run(["GET", key()]), raw, "read does not erase the unread record");
  });
}

test("privacy control: a readable copy contains only requested learner and public file name", async () => {
  redis.clear();
  redis.run(["SET", key(), JSON.stringify(work())]);
  redis.run(["SET", key(OTHER), JSON.stringify({ ...work(), text: "Other synthetic learner" })]);
  const records = await copy();
  assert.equal(records.length, 1);
  assert.equal(records[0].text, "Synthetic work");
  assert.equal(records[0].file, "work.pdf");
  assert.doesNotMatch(JSON.stringify(records), /Other synthetic learner|private\/synthetic|internal\.pdf/);
});

for (const [name, value] of [["short", []], ["extra", [null, null]], ["wrong slot", [{}]], ["undefined slot", [undefined]], ["hole", new Array(1)], ["wrong outer", { 0: null, length: 1 }]] as [string, unknown][]) {
  test(`envelope ${name}: assignment batch and copy refuse, never silently omit`, async () => {
    await assert.rejects(() => replyWith(value, () => a.submissionsOf(COURSE, rows)), { name: "UnknownReplyError" });
    await assert.rejects(() => replyWith(value, copy), { name: "UnknownReplyError" });
  });
}

test("accessor and Proxy outer envelopes are rejected before traps execute", async () => {
  let ran = 0;
  let promiseThenReads = 0;
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, "0", { get() { ran++; return null; }, configurable: true });
  // Promise resolution in the async pipeline double checks then before the product sees the value.
  // Count that framework check separately; every data trap remains a failure.
  const proxy = new Proxy([null], { get(_target, name) { if (name === "then") { promiseThenReads++; return undefined; } ran++; return null; }, getOwnPropertyDescriptor() { ran++; return undefined; } });
  await assert.rejects(() => replyWith(accessor, copy), { name: "UnknownReplyError" });
  await assert.rejects(() => replyWith(proxy, copy), { name: "UnknownReplyError" });
  assert.equal(ran, 0);
  assert.equal(promiseThenReads, 1, "one Promise-assimilation check from the async double, before repliesFor");
});

test("transport rejection propagates through assignment copier", async () => {
  const original = redis.pipeline;
  redis.pipeline = async () => { throw new Error("synthetic transport unavailable"); };
  try { await assert.rejects(copy, /synthetic transport unavailable/); } finally { redis.pipeline = original; }
});

for (const value of [[], [7], ["{"], [JSON.stringify({ prompt: "Synthetic task", review: true, gate: false })], [JSON.stringify({ prompt: "Synthetic task", review: true, gate: false, file: 0 })]]) {
  test(`prompt unknown ${JSON.stringify(value).slice(0, 40)} refuses`, async () => {
    await assert.rejects(() => replyWith(value, () => a.readTaskFor(COURSE, LESSON)), { name: "UnknownReplyError" });
  });
}

test("full page control: known unread work is announced without empty claim or private path", async () => {
  redis.clear();
  redis.run(["ZADD", waitingKey, 1700000000, `${LESSON}|${WHO}`]);
  redis.run(["SET", key(), "{broken synthetic work"]);
  const html = await w.renderPage();
  assert.match(html, /1 piece of work could not be read/);
  assert.doesNotMatch(html, /Nothing is waiting|private\/synthetic/);
});

test("full page control: readable work displays and absence stays empty", async () => {
  redis.clear();
  const absent = await w.renderPage();
  assert.match(absent, /Nothing is waiting/);
  redis.run(["ZADD", waitingKey, 1700000000, `${LESSON}|${WHO}`]);
  redis.run(["SET", key(), JSON.stringify(work())]);
  const html = await w.renderPage();
  assert.match(html, /Synthetic work/);
  assert.doesNotMatch(html, /Nothing is waiting|could not be read/);
});

test("residual rule 24/30: malformed student member must not produce a confirmed empty studio", async () => {
  redis.clear();
  const malformed = "not-a-student";
  redis.run(["ZADD", waitingKey, 1700000000, `${LESSON}|${malformed}`]);
  redis.run(["SET", key(malformed), "{unread synthetic record"]);
  const listed = await a.waitingWork(COURSE);
  assert.equal(listed.total, 1, "source reports kept work");
  assert.equal(listed.rows.length, 1);
  const html = await w.renderPage();
  // Conditional presentation residual: this does not establish a valid student's work was hidden.
  // The unchanged failing assertion and the controls above exercise the real page/component path.
  assert.doesNotMatch(html, /Nothing is waiting/, "unknown member was silently filtered instead of refused/announced");
});
