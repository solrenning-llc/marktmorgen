/**
 * Reads that decide money owed and CRM records, only in their exact shape
 * (CX-123 rules 24 and 30). A Redis reply that is missing, cut short or of
 * another shape is unknown: it never stands for "no refund owed", "no
 * fields", "no values", "the default pipelines" or "nothing to delete".
 *
 *   - autoRefundsOwed (lib/auto-captions.ts): the AI-caption refunds Stripe has
 *     not confirmed, shown on the studio's course page. An unknown read said
 *     none were owed, and the page then showed nothing.
 *   - readFields, readValues, allValues and readPipelines (lib/crm.ts): an
 *     unknown read said no fields, no values or the default pipelines; the
 *     person's deletion (forgetCrmPerson) then deleted none of the person's
 *     answers or deals and still said it was done.
 *   - forgetCrm (lib/crm.ts), a deleted store's CRM: an unknown fields read
 *     kept everything, deals naming buyers included (Claude 6 on #2901). The
 *     keys it does not need the fields for go at once; the fields record and
 *     its values stay findable for a later try, and it throws.
 *   - listAsCsv (lib/free.ts), the list's file: an unknown fields or values
 *     read gave every CRM column empty with no error (Claude 4 on #2901); a
 *     page of the list read in another shape cut the file short.
 *
 * Synthetic records only, in the in-memory Redis stand-in.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { autoRefundsOwed } from "@/lib/auto-captions";
import { allValues, forgetCrm, forgetCrmPerson, readFields, readPipelines, readValues } from "@/lib/crm";
import { upsertContact } from "@/lib/contacts";
import { listAsCsv } from "@/lib/free";
import { personKey } from "@/lib/person-key";
import { streamPath } from "@/lib/stream-rules";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";

/** Redis answers `fault` for the `nth` pipeline sent (1 for the first), and truthfully for every other. */
async function faulted<T>(nth: number, fault: unknown, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  let calls = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    calls += 1;
    return calls === nth ? fault : original.call(redis, commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

// ---- AI-caption refunds owed ----

const FOLDER = "c".repeat(32);
const VIDEO = "2b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const owedRecord = JSON.stringify({ langs: ["en"], got: [], at: 1_000, cents: 3500, pi: "pi_SyntheticOwed01", path: streamPath(FOLDER, "lesson000001", VIDEO), owed: { cents: null, key: "k-synthetic", since: 1, looks: 0 } });
const seedOwed = async () => {
  redis.clear();
  await redis.pipeline([["SADD", `nl:stream:autoowed:${FOLDER}`, VIDEO], ["SET", `nl:stream:auto:${VIDEO}`, owedRecord, "EX", 3600]]);
};

test("control: a refund owed is listed, and a store with none confirmed has none", async () => {
  await seedOwed();
  assert.deepEqual(await autoRefundsOwed(FOLDER), [{ id: VIDEO, cents: 3500, stuck: false }]);
  assert.deepEqual(await autoRefundsOwed("d".repeat(32)), []);
});

for (const [label, nth, fault] of [
  ["the members' reply missing", 1, []],
  ["the members not a list", 1, [{}]],
  ["a member not a string", 1, [[42]]],
  ["a member that is not a video id", 1, [["not-a-video"]]],
  ["the records' reply cut short", 2, []],
  ["a record not a string", 2, [7]],
  ["a record that does not read", 2, ["{"]],
] as const) {
  test(`refunds owed: ${label} is unknown, never "none owed"`, async () => {
    await seedOwed();
    await assert.rejects(() => faulted(nth, fault, () => autoRefundsOwed(FOLDER)));
  });
}

test("the course page says the refunds could not be read, never shows nothing in their place", () => {
  const page = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  assert.equal(page.includes("autoRefundsOwed(folder).catch(() => [])"), false);
  assert.equal(page.includes("data-captions-refunds-unread"), true);
});

// ---- CRM fields, values and pipelines ----

const STATS = "synthetic-crm-exact";
const ANA = "a".repeat(32);
const FIELD = { id: "plan01", name: "Plan", type: "text", options: [] };
const DEAL = { id: "deal000001", title: "Synthetic deal", email: "ana@example.com", stage: "lead00", cents: 0, note: "", createdAt: 1, updatedAt: 1 };
const PIPES = [
  { id: "sales0", name: "Sales", stages: [{ id: "lead00", name: "New", kind: "open" }, { id: "won000", name: "Won", kind: "won" }, { id: "lost00", name: "Lost", kind: "lost" }] },
  { id: "part01", name: "Partners", stages: [{ id: "pnew01", name: "New", kind: "open" }, { id: "pwon01", name: "Won", kind: "won" }, { id: "plst01", name: "Lost", kind: "lost" }] },
];
const seedCrm = async () => {
  redis.clear();
  await redis.pipeline([
    ["SET", `nl:crm:fields:${STATS}`, JSON.stringify([FIELD])],
    ["HSET", `nl:crm:v:${STATS}:${FIELD.id}`, ANA, "Gold"],
    ["HSET", `nl:crm:deals:${STATS}`, DEAL.id, JSON.stringify(DEAL)],
    ["SET", `nl:crm:pipes:${STATS}`, JSON.stringify(PIPES)],
  ]);
};
const kept = async () => {
  const [value, deal] = await redis.pipeline([["HGET", `nl:crm:v:${STATS}:${FIELD.id}`, ANA], ["HGET", `nl:crm:deals:${STATS}`, DEAL.id]]);
  return { value, deal: typeof deal === "string" };
};

test("control: fields, values, pipelines read as saved; nothing saved reads as none or the defaults", async () => {
  await seedCrm();
  assert.deepEqual((await readFields(STATS)).map((f) => f.id), [FIELD.id]);
  assert.deepEqual(await readValues(STATS, ANA, [FIELD as never]), { [FIELD.id]: "Gold" });
  assert.deepEqual(await allValues(STATS, [FIELD as never]), { [FIELD.id]: { [ANA]: "Gold" } });
  assert.deepEqual((await readPipelines(STATS)).map((p) => p.id), ["sales0", "part01"]);
  assert.deepEqual(await readFields("synthetic-crm-none"), []);
  assert.deepEqual((await readPipelines("synthetic-crm-none")).map((p) => p.id), ["sales0"]);
});

for (const [label, fault] of [
  ["the reply missing", []],
  ["a record not a string", [5]],
  ["a record that does not read", ["{"]],
  ["a record not a list", [JSON.stringify({})]],
  ["a field that does not read", [JSON.stringify([FIELD, { id: "BAD" }])]],
] as const) {
  test(`fields: ${label} is unknown, never "no fields"`, async () => {
    await seedCrm();
    await assert.rejects(() => faulted(1, fault, () => readFields(STATS)));
  });
}

for (const [label, fault] of [
  ["the reply missing", []],
  ["a value not a string", [5]],
]) {
  test(`one person's values: ${label} is unknown, never "no value"`, async () => {
    await seedCrm();
    await assert.rejects(() => faulted(1, fault, () => readValues(STATS, ANA, [FIELD as never])));
  });
}

for (const [label, fault] of [
  ["the reply missing", []],
  ["an object in place of the list", [{ [ANA]: "Gold" }]],
  ["a list cut in the middle of a pair", [[ANA]]],
  ["a value not a string", [[ANA, 5]]],
  ["not a list", [5]],
]) {
  test(`every value: ${label} is unknown, never "no values"`, async () => {
    await seedCrm();
    await assert.rejects(() => faulted(1, fault, () => allValues(STATS, [FIELD as never])));
  });
}

for (const [label, fault] of [
  ["the reply missing", []],
  ["a record not a string", [5, null]],
  ["a record that does not read", ["{", null]],
]) {
  test(`pipelines: ${label} is unknown, never the default pipeline alone`, async () => {
    await seedCrm();
    await assert.rejects(() => faulted(1, fault, () => readPipelines(STATS)));
  });
}

test("control: a person's deletion deletes their answer and their deal", async () => {
  await seedCrm();
  assert.equal(await forgetCrmPerson(STATS, ANA, "ana@example.com"), 2);
  assert.deepEqual(await kept(), { value: null, deal: false });
});

for (const [label, nth, fault] of [
  ["the fields' reply unknown", 1, [5]],
  ["the deals' reply unknown", 2, [5]],
  ["the deals' reply an object", 2, [{ [DEAL.id]: JSON.stringify(DEAL) }]],
] as const) {
  test(`a person's deletion with ${label} fails and says so, never "done" with their records kept`, async () => {
    await seedCrm();
    await assert.rejects(() => faulted(nth, fault, () => forgetCrmPerson(STATS, ANA, "ana@example.com")));
  });
}

// ---- A deleted store's CRM (forgetCrm) ----

const TASKS_KEY = `nl:crm:tasks:${STATS}`;
const STAGES_KEY = `nl:crm:stages:${STATS}`;
const seedStore = async () => {
  await seedCrm();
  await redis.pipeline([["HSET", TASKS_KEY, ANA, JSON.stringify([{ id: "task000001", text: "Call Ana" }])], ["SET", STAGES_KEY, JSON.stringify(PIPES[0].stages)]]);
};
const left = async () => {
  const [fields, value, deals, pipes, stages, tasks] = await redis.pipeline([
    ["EXISTS", `nl:crm:fields:${STATS}`],
    ["HGET", `nl:crm:v:${STATS}:${FIELD.id}`, ANA],
    ["EXISTS", `nl:crm:deals:${STATS}`],
    ["EXISTS", `nl:crm:pipes:${STATS}`],
    ["EXISTS", STAGES_KEY],
    ["EXISTS", TASKS_KEY],
  ]);
  return { fields, value, deals, pipes, stages, tasks };
};

test("control: a deleted store's CRM goes whole, its answers included", async () => {
  await seedStore();
  await forgetCrm(STATS);
  assert.deepEqual(await left(), { fields: 0, value: null, deals: 0, pipes: 0, stages: 0, tasks: 0 });
});

for (const [label, fault] of [
  ["not a string", [7]],
  ["missing", []],
  ["a record that does not read", ["{"]],
] as const) {
  test(`a deleted store's CRM with the fields' reply ${label}: deals, pipelines, stages and tasks go, the answers stay findable, and it throws`, async () => {
    await seedStore();
    await assert.rejects(() => faulted(1, fault, () => forgetCrm(STATS)));
    // The deal naming ana@example.com is gone; the fields record stays so a later try still finds the answers' keys.
    assert.deepEqual(await left(), { fields: 1, value: "Gold", deals: 0, pipes: 0, stages: 0, tasks: 0 });
    await forgetCrm(STATS);
    assert.deepEqual(await left(), { fields: 0, value: null, deals: 0, pipes: 0, stages: 0, tasks: 0 });
  });
}

// ---- The list's file (listAsCsv) ----

const LIST = "e".repeat(32);
const LIST_STORE = { statsId: STATS, listId: LIST } as never;
const seedList = async () => {
  redis.clear();
  await upsertContact(LIST, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await redis.pipeline([
    ["SET", `nl:crm:fields:${STATS}`, JSON.stringify([FIELD])],
    ["HSET", `nl:crm:v:${STATS}:${FIELD.id}`, personKey(STATS, "ana@example.com"), "Gold"],
  ]);
};

test("control: the list's file has the field's column and Ana's answer in it", async () => {
  await seedList();
  const rows = (await listAsCsv(LIST_STORE, false)).split("\r\n");
  assert.equal(rows[0].endsWith(',"Plan"'), true);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].startsWith('"ana@example.com"'), true);
  assert.equal(rows[1].endsWith(',"Gold"'), true);
});

for (const [label, nth, fault] of [
  ["the fields' reply not a string", 1, [7]],
  ["the fields' reply missing", 1, []],
  ["the values' reply an object", 2, [{ x: "Gold" }]],
  ["the values' reply missing", 2, []],
  ["a page of the list not a list", 3, [7]],
  ["a page of the list without its people", 3, [["0", 7]]],
] as const) {
  test(`the list's file with ${label} fails and says so, never a file with the CRM columns or people left out`, async () => {
    await seedList();
    await assert.rejects(() => faulted(nth, fault, () => listAsCsv(LIST_STORE, false)));
  });
}
