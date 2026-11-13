/**
 * 604 [WP3] unit 2: "Apply first" applications kept (lib/apply-first-store.ts).
 *
 * Synthetic only: the in-memory Redis stand-in (tests/redis-stub.ts) with a
 * fixed clock, example.invalid addresses. lib/redis-memory.ts does not run
 * this file's two scripts, so this test runs them step for step on the
 * stand-in's own commands, as Redis runs a script: one step, nothing between.
 * No email, no checkout, no provider, no network.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as memory } from "./redis-stub";
import { UnknownReplyError } from "@/lib/redis-reply";
import { personKey } from "@/lib/person-key";
import { ERASERS } from "@/lib/person-erasure";
import { COPIERS, COPY_PLAN } from "@/lib/person-copy";
import { PERSON_DATA } from "@/lib/person-data";
import type { ErasureScope } from "@/lib/erasure-rules";
import { APPLY_TOKEN, applyTokenDigest, canPurchase, parseApplication } from "@/lib/apply-first-rules";
import {
  APPLY_AFTER_DAYS, APPLY_CHANGE, APPLY_DAY_SECONDS, APPLY_DECIDE_COMMANDS, APPLY_KEEP_DAYS,
  APPLY_LIST_COMMANDS, APPLY_COPY_COMMANDS, APPLY_FORGET_COMMANDS, APPLY_MAX_KEPT, APPLY_MAX_PER_PERSON, APPLY_NEW, APPLY_PER_STORE_DAY,
  APPLY_RECORD_MAX_BYTES, APPLY_SUBMIT_COMMANDS,
  applicationsOfPerson, decideApplication, forgetApplyFirstPerson, listApplications, submitApplication, untilOf,
} from "@/lib/apply-first-store";

const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 10, 12);
let clock = START;
const shop = { sid: "s".repeat(24) };
const other = { sid: "t".repeat(24) };
const offer = "prod_synthetic01";
const ann = "Ann@Example.invalid ";
const bob = "bob@example.invalid";

type Cmd = (string | number)[];
const base = memory.run.bind(memory);
/** Every command sent, scripts counted with the commands they run. */
let sent: Cmd[] = [];
/** A hook that may answer a command in place of the stand-in (a fault, a race), or undefined to let it run. */
let fault: ((command: Cmd) => unknown) | null = null;

const inner = (command: Cmd) => base(command);
function runScript(command: Cmd): unknown {
  const [, script, , ...rest] = command.map(String);
  if (script === APPLY_NEW) {
    const [record, stores, person, id, text, ttl, until, now, most, mostPerson] = rest;
    if (inner(["EXISTS", record]) !== 0) return 3;
    inner(["ZREMRANGEBYSCORE", stores, "-inf", now]);
    inner(["ZREMRANGEBYSCORE", person, "-inf", now]);
    if (Number(inner(["ZCARD", stores])) >= Number(most)) return 4;
    if (Number(inner(["ZCARD", person])) >= Number(mostPerson)) return 5;
    inner(["SET", record, text, "EX", ttl]);
    inner(["ZADD", stores, until, id]);
    inner(["ZADD", person, until, id]);
    for (const index of [stores, person]) if (Number(inner(["TTL", index])) < Number(ttl)) inner(["EXPIRE", index, ttl]);
    return 1;
  }
  if (script === APPLY_CHANGE) {
    const [record, stores, person, old, text, ttl, until, id] = rest;
    if (inner(["GET", record]) !== old) return 0;
    inner(["SET", record, text, "EX", ttl]);
    inner(["ZADD", stores, until, id]);
    inner(["ZADD", person, until, id]);
    for (const index of [stores, person]) if (Number(inner(["TTL", index])) < Number(ttl)) inner(["EXPIRE", index, ttl]);
    return 1;
  }
  throw new Error("a script this test does not know");
}
memory.run = (command: Cmd) => {
  sent.push(command);
  if (fault) {
    const answer = fault(command);
    if (answer !== undefined) return answer;
  }
  return String(command[0]).toUpperCase() === "EVAL" ? runScript(command) : base(command);
};
const scriptSteps = (script: string) => script.split("redis.call(").length - 1;
// Redis keeps no empty sorted set; the stand-in leaves one where a read touched a key that was gone, so it is not counted.
const index = (key: string) => /^nl:apply:[sp]:/.test(key);
const keys = () => memory.keys().filter((key) => key.startsWith("nl:apply:") && base(["EXISTS", key]) === 1 && (!index(key) || Number(base(["ZCARD", key])) > 0));
const ttl = (key: string) => Number(base(["TTL", key]));
const at = (ms: number) => {
  clock = ms;
  memory.now = () => clock;
};

beforeEach(() => {
  memory.clear();
  at(START);
  sent = [];
  fault = null;
});

async function submit(email = ann, where = shop, what = offer) {
  const done = await submitApplication(where, { offer: what, email }, clock);
  assert.equal(done.ok, true, JSON.stringify(done));
  return (done as { ok: true; application: { id: string } }).application;
}

test("an application is kept with its address, both index entries and every expiry; the list shows it", async () => {
  const one = await submit();
  assert.match(one.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(one, { id: one.id, offer, email: "ann@example.invalid", state: "submitted", at: START, decidedAt: 0, expiresAt: 0, usedAt: 0 });
  const record = `nl:apply:r:${shop.sid}:${one.id}`;
  const person = `nl:apply:p:${shop.sid}:${personKey(shop.sid, ann)}`;
  const day = `nl:apply:d:${shop.sid}:20261110`;
  assert.deepEqual(keys(), [day, person, record, `nl:apply:s:${shop.sid}`].sort());
  for (const key of keys()) assert.ok(ttl(key) > 0, `${key} has an expiry`);
  assert.equal(ttl(record), APPLY_KEEP_DAYS * 86_400);
  assert.equal(ttl(day), APPLY_DAY_SECONDS);
  assert.equal(ttl(person), APPLY_KEEP_DAYS * 86_400, "an index goes with the last record it names");
  assert.equal(ttl(`nl:apply:s:${shop.sid}`), APPLY_KEEP_DAYS * 86_400);
  assert.ok(Buffer.byteLength(String(base(["GET", record]))) <= APPLY_RECORD_MAX_BYTES);
  at(START + 1_000);
  const two = await submit(bob);
  assert.deepEqual((await listApplications(shop, clock))?.map((a) => [a.id, a.email]), [[one.id, "ann@example.invalid"], [two.id, bob]]);
  // Another store sees none of them.
  assert.deepEqual(await listApplications(other, clock), []);
});

test("the store's day is counted before anything is kept, and a store past it keeps nothing more that day", async () => {
  base(["SET", `nl:apply:d:${shop.sid}:20261110`, String(APPLY_PER_STORE_DAY - 1), "EX", APPLY_DAY_SECONDS]);
  await submit();
  const before = keys();
  sent = [];
  assert.deepEqual(await submitApplication(shop, { offer, email: bob }, clock), { ok: false, reason: "day" });
  assert.deepEqual(sent.map((c) => c[0]), ["INCR", "EXPIRE"], "nothing but the day's count is sent");
  assert.deepEqual(keys(), before);
  // The next UTC day counts again.
  at(START + DAY);
  await submit(bob);
});

test("the store's and the address's caps are checked with the write, which keeps nothing past them", async () => {
  for (let i = 0; i < APPLY_MAX_PER_PERSON; i++) await submit();
  const before = keys().length;
  assert.deepEqual(await submitApplication(shop, { offer, email: ann }, clock), { ok: false, reason: "person" });
  assert.equal(keys().length, before);
  // A full store: its index holds APPLY_MAX_KEPT live entries.
  const stores = `nl:apply:s:${other.sid}`;
  for (let i = 0; i < APPLY_MAX_KEPT; i++) base(["ZADD", stores, String(START + DAY), i.toString(16).padStart(32, "0")]);
  assert.deepEqual(await submitApplication(other, { offer, email: bob }, clock), { ok: false, reason: "full" });
  assert.equal(base(["ZCARD", `nl:apply:p:${other.sid}:${personKey(other.sid, bob)}`]), 0);
  // Entries whose record is gone leave first: once they are past, the store takes one again.
  at(START + DAY);
  await submit(bob, other);
});

test("a form that is not right sends nothing to the database", async () => {
  for (const [email, what] of [["not an address", offer], ["", offer], [ann, ""], [ann, "has space"], [ann, "x".repeat(65)]]) {
    sent = [];
    assert.deepEqual(await submitApplication(shop, { offer: what, email }, clock), { ok: false, reason: "bad-input" });
    assert.equal(sent.length, 0);
  }
  assert.deepEqual(await submitApplication({ sid: "" }, { offer, email: ann }, clock), { ok: false, reason: "unavailable" });
});

test("approving answers the link's token once; the record keeps only its digest and lives past the link", async () => {
  const one = await submit();
  at(START + 1_000);
  const done = await decideApplication(shop, one.id, { kind: "approve", days: 30 }, clock);
  assert.equal(done.ok, true);
  const { application, token } = done as { ok: true; application: { state: string; expiresAt: number }; token: string };
  assert.match(token, APPLY_TOKEN);
  assert.equal(application.state, "approved");
  assert.equal(application.expiresAt, clock + 30 * DAY);
  const record = `nl:apply:r:${shop.sid}:${one.id}`;
  const raw = String(base(["GET", record]));
  assert.equal(raw.includes(token), false, "the plain token is never kept");
  const app = parseApplication(JSON.parse(raw).app);
  assert.ok(app);
  assert.equal(app.tokenDigest, applyTokenDigest(token));
  // The rules open the link for that address and that offer only.
  assert.deepEqual(canPurchase(app, { token, email: ann, offer, now: clock + DAY }), { ok: true });
  assert.deepEqual(canPurchase(app, { token, email: bob, offer, now: clock + DAY }), { ok: false, why: "wrong-email" });
  // The record and its index entries live until the later of its wait and the days after the link's end.
  assert.equal(untilOf(app), Math.max(app.at + APPLY_KEEP_DAYS * DAY, app.expiresAt + APPLY_AFTER_DAYS * DAY));
  assert.equal(untilOf({ ...app, expiresAt: app.at + 40 * DAY }), app.at + (40 + APPLY_AFTER_DAYS) * DAY);
  assert.equal(ttl(record), Math.ceil((untilOf(app) - clock) / 1000));
  assert.equal(Number(base(["ZSCORE", `nl:apply:s:${shop.sid}`, one.id])), untilOf(app));
  // An open link is not renewed; a declined application is final.
  assert.deepEqual(await decideApplication(shop, one.id, { kind: "approve" }, clock + 1), { ok: false, reason: "still-open" });
  const life = ttl(record);
  const declined = await decideApplication(shop, one.id, { kind: "decline" }, clock + 2);
  assert.equal(declined.ok && declined.application.state, "declined");
  assert.ok(ttl(record) >= life - 1, "a decline never shortens the record's life");
  assert.equal(Number(base(["ZSCORE", `nl:apply:s:${shop.sid}`, one.id])), untilOf(app));
  assert.equal("token" in declined, false);
  assert.deepEqual(await decideApplication(shop, one.id, { kind: "approve" }, clock + 3), { ok: false, reason: "final" });
  // Out-of-range days are refused, and nothing is written.
  const two = await submit(bob);
  const kept = base(["GET", `nl:apply:r:${shop.sid}:${two.id}`]);
  assert.deepEqual(await decideApplication(shop, two.id, { kind: "approve", days: 31 }, clock + 4), { ok: false, reason: "bad-input" });
  assert.equal(base(["GET", `nl:apply:r:${shop.sid}:${two.id}`]), kept);
});

test("an application is only found under its own store, and an unknown id is gone", async () => {
  const one = await submit();
  assert.deepEqual(await decideApplication(other, one.id, { kind: "decline" }, clock), { ok: false, reason: "gone" });
  assert.deepEqual(await decideApplication(shop, "f".repeat(32), { kind: "decline" }, clock), { ok: false, reason: "gone" });
  assert.deepEqual(await decideApplication(shop, "../x", { kind: "decline" }, clock), { ok: false, reason: "gone" });
});

test("a decision is written only over the record as it was read: a change or a deletion meanwhile writes nothing", async () => {
  const one = await submit();
  const record = `nl:apply:r:${shop.sid}:${one.id}`;
  // Another press writes between this one's read and its write: this one writes nothing over it.
  fault = (command) => {
    if (String(command[1]) === APPLY_CHANGE) {
      fault = null;
      base(["SET", record, "written by another press", "EX", 600]);
    }
    return undefined;
  };
  assert.deepEqual(await decideApplication(shop, one.id, { kind: "approve" }, clock + 1), { ok: false, reason: "changed" });
  assert.equal(base(["GET", record]), "written by another press");
  // The person is deleted between the read and the write: the record is not written back.
  const two = await submit(bob);
  const record2 = `nl:apply:r:${shop.sid}:${two.id}`;
  fault = (command) => {
    if (String(command[1]) === APPLY_CHANGE) {
      fault = null;
      base(["DEL", record2]);
    }
    return undefined;
  };
  assert.deepEqual(await decideApplication(shop, two.id, { kind: "decline" }, clock + 1), { ok: false, reason: "changed" });
  assert.equal(base(["EXISTS", record2]), 0);
});

test("rule 24: a reply that is not exact is never a saved application, a decision or an empty list", async () => {
  // The day's count in another shape: nothing kept.
  for (const reply of ["1", null, -1, 1.5]) {
    fault = (command) => (command[0] === "INCR" ? reply : undefined);
    assert.deepEqual(await submitApplication(shop, { offer, email: ann }, clock), { ok: false, reason: "unavailable" });
  }
  fault = (command) => (command[0] === "EXPIRE" && String(command[1]).startsWith("nl:apply:d:") ? 0 : undefined);
  assert.deepEqual(await submitApplication(shop, { offer, email: ann }, clock), { ok: false, reason: "unavailable" });
  assert.equal(keys().some((k) => k.startsWith("nl:apply:r:")), false);
  // The script ran but its answer was lost: the record read back says it was kept.
  fault = (command) => {
    if (String(command[1]) !== APPLY_NEW) return undefined;
    runScript(command);
    return "OK";
  };
  const landed = await submitApplication(shop, { offer, email: ann }, clock);
  assert.equal(landed.ok, true);
  // The script did not run and its answer was lost: not kept.
  fault = (command) => (String(command[1]) === APPLY_NEW ? null : undefined);
  assert.deepEqual(await submitApplication(shop, { offer, email: bob }, clock), { ok: false, reason: "unavailable" });
  fault = null;
  assert.equal((await listApplications(shop, clock))?.length, 1);
  const id = (landed as { ok: true; application: { id: string } }).application.id;
  // A decision whose answer was lost, read back: landed or not.
  fault = (command) => {
    if (String(command[1]) !== APPLY_CHANGE) return undefined;
    runScript(command);
    return [1];
  };
  assert.equal((await decideApplication(shop, id, { kind: "decline" }, clock + 1)).ok, true);
  const later = await submit(bob);
  fault = (command) => (String(command[1]) === APPLY_CHANGE ? "1" : undefined);
  assert.deepEqual(await decideApplication(shop, later.id, { kind: "decline" }, clock + 1), { ok: false, reason: "unavailable" });
  fault = null;
  // A record that is not exactly one this file wrote: the decision, the list and the copy are unknown.
  const record = `nl:apply:r:${shop.sid}:${later.id}`;
  const raw = String(base(["GET", record]));
  const wrong = [
    raw.replace('"v":1', '"v":2'),
    raw.replace("bob@example.invalid", "eve@example.invalid"),
    raw.replace('{"v":1,', '{"v":1,"v":1,'),
    raw.replace('{"v":1,', '{ "v":1,'),
    JSON.stringify({ v: 1, email: bob, app: JSON.parse(raw).app.replace(later.id, "e".repeat(32)) }),
    "x".repeat(APPLY_RECORD_MAX_BYTES + 1),
  ];
  for (const bad of wrong) {
    base(["SET", record, bad, "EX", 600]);
    assert.deepEqual(await decideApplication(shop, later.id, { kind: "decline" }, clock + 2), { ok: false, reason: "unavailable" }, bad.slice(0, 60));
    assert.equal(await listApplications(shop, clock + 2), null);
    await assert.rejects(applicationsOfPerson(shop.sid, bob), UnknownReplyError);
  }
  base(["SET", record, raw, "EX", 600]);
  // An index in another shape is unknown, never empty.
  for (const reply of [null, "x", [7], ["not-an-id"], [later.id, later.id]]) {
    fault = (command) => (command[0] === "ZRANGEBYSCORE" ? reply : undefined);
    assert.equal(await listApplications(shop, clock), null, JSON.stringify(reply));
    await assert.rejects(forgetApplyFirstPerson(shop.sid, bob), UnknownReplyError);
    await assert.rejects(applicationsOfPerson(shop.sid, bob), UnknownReplyError);
  }
  fault = (command) => (command[0] === "MGET" ? [null] : undefined);
  assert.equal(await listApplications(shop, clock), null, "an MGET of another length");
});

test("an approval applied whose reply was lost (a throw after the script ran) is read back and answers its token", async () => {
  const one = await submit();
  const record = `nl:apply:r:${shop.sid}:${one.id}`;
  // Codex U's probe on #3564: APPLY_CHANGE runs, then the acknowledgment is lost as a thrown transport error.
  fault = (command) => {
    if (String(command[1]) !== APPLY_CHANGE) return undefined;
    fault = null;
    runScript(command);
    throw new Error("synthetic: the reply to an applied approval was lost");
  };
  const done = await decideApplication(shop, one.id, { kind: "approve", days: 7 }, clock + 1);
  assert.equal(done.ok, true, JSON.stringify(done));
  const { token, application } = done as { ok: true; token: string; application: { state: string } };
  assert.equal(application.state, "approved");
  assert.match(token, APPLY_TOKEN);
  const app = parseApplication(JSON.parse(String(base(["GET", record]))).app);
  assert.ok(app);
  assert.equal(app.tokenDigest, applyTokenDigest(token));
  assert.deepEqual(canPurchase(app, { token, email: ann, offer, now: clock + DAY }), { ok: true });
  // The script did not run and the call threw: nothing is said to be saved.
  const two = await submit(bob);
  const before = base(["GET", `nl:apply:r:${shop.sid}:${two.id}`]);
  fault = (command) => {
    if (String(command[1]) !== APPLY_CHANGE) return undefined;
    fault = null;
    throw new Error("synthetic: the request never reached the database");
  };
  assert.deepEqual(await decideApplication(shop, two.id, { kind: "approve", days: 7 }, clock + 1), { ok: false, reason: "unavailable" });
  assert.equal(base(["GET", `nl:apply:r:${shop.sid}:${two.id}`]), before);
});

test("an approval applied whose reply and read back were both lost is unknown, and its retry with the same key answers a fresh link", async () => {
  const one = await submit();
  const record = `nl:apply:r:${shop.sid}:${one.id}`;
  const key = "a".repeat(32);
  // The script runs and its reply is lost; the read back is lost too: unknown, never "approved" without a link.
  let lost = false;
  fault = (command) => {
    if (String(command[1]) === APPLY_CHANGE) {
      runScript(command);
      lost = true;
      throw new Error("synthetic: reply lost");
    }
    if (lost && command[0] === "GET") {
      fault = null;
      throw new Error("synthetic: read back lost");
    }
    return undefined;
  };
  assert.deepEqual(await decideApplication(shop, one.id, { kind: "approve", days: 7, key }, clock + 1), { ok: false, reason: "unavailable" });
  fault = null;
  const applied = parseApplication(JSON.parse(String(base(["GET", record]))).app);
  assert.equal(applied?.state, "approved", "the approval did land");
  const lostDigest = applied!.tokenDigest;
  // Another press, another key (another tab): the open link is not touched.
  assert.deepEqual(await decideApplication(shop, one.id, { kind: "approve", days: 7, key: "b".repeat(32) }, clock + 2), { ok: false, reason: "still-open" });
  assert.deepEqual(await decideApplication(shop, one.id, { kind: "approve", days: 7 }, clock + 2), { ok: false, reason: "still-open" });
  assert.equal(parseApplication(JSON.parse(String(base(["GET", record]))).app)?.tokenDigest, lostDigest);
  // The same press again, with its key: a fresh token replaces the kept digest, so the link nobody holds stops working.
  const life = ttl(record);
  const again = await decideApplication(shop, one.id, { kind: "approve", days: 7, key }, clock + 3);
  assert.equal(again.ok, true, JSON.stringify(again));
  const { token } = again as { ok: true; token: string };
  assert.match(token, APPLY_TOKEN);
  const now = parseApplication(JSON.parse(String(base(["GET", record]))).app);
  assert.ok(now);
  assert.equal(now.state, "approved");
  assert.equal(now.tokenDigest, applyTokenDigest(token));
  assert.notEqual(now.tokenDigest, lostDigest);
  assert.equal(now.expiresAt, clock + 3 + 7 * DAY);
  assert.deepEqual(canPurchase(now, { token, email: ann, offer, now: clock + DAY }), { ok: true });
  assert.ok(ttl(record) >= life - 1, "a retry never shortens the record's life");
  assert.equal(Number(base(["ZSCORE", `nl:apply:s:${shop.sid}`, one.id])), untilOf(now));
  assert.equal(String(base(["GET", record])).includes(token), false, "the plain token is never kept");
  assert.equal(String(base(["GET", record])).includes(key), false, "the press's key is never kept, only its digest");
  // A key in another shape is refused, and nothing is written.
  const kept = base(["GET", record]);
  for (const bad of ["A".repeat(32), "a".repeat(31), "../x", 7]) {
    assert.deepEqual(await decideApplication(shop, one.id, { kind: "approve", days: 7, key: bad as string }, clock + 4), { ok: false, reason: "bad-input" }, String(bad));
  }
  assert.equal(base(["GET", record]), kept);
  // Declined is final, whatever the key.
  assert.equal((await decideApplication(shop, one.id, { kind: "decline" }, clock + 5)).ok, true);
  assert.deepEqual(await decideApplication(shop, one.id, { kind: "approve", days: 7, key }, clock + 6), { ok: false, reason: "final" });
});

test("a record goes by itself: waiting KEEP days, or AFTER days past its decision", async () => {
  const one = await submit();
  const two = await submit(bob);
  at(START + 50 * DAY);
  await decideApplication(shop, two.id, { kind: "decline" }, clock);
  at(START + APPLY_KEEP_DAYS * DAY);
  assert.deepEqual((await listApplications(shop, clock))?.map((a) => a.id), [two.id]);
  assert.equal(base(["EXISTS", `nl:apply:r:${shop.sid}:${one.id}`]), 0);
  at(START + (50 + APPLY_AFTER_DAYS) * DAY);
  assert.deepEqual(await listApplications(shop, clock), []);
  at(START + 200 * DAY);
  assert.deepEqual(keys(), [], "nothing is left once its expiry passes");
});

test("deleting a person takes every application of theirs in that store, and only theirs; the copy reads them first", async () => {
  const one = await submit();
  await submit(ann, shop, "prod_other");
  const kept = await submit(bob);
  const elsewhere = await submit(ann, other);
  await decideApplication(shop, one.id, { kind: "approve" }, clock + 1);
  const copy = await applicationsOfPerson(shop.sid, "ANN@example.invalid");
  assert.deepEqual(copy.map((a) => [a.offer, a.state, a.email]).sort(), [["prod_other", "submitted", "ann@example.invalid"], [offer, "approved", "ann@example.invalid"]]);
  assert.equal(JSON.stringify(copy).includes("token"), false);
  sent = [];
  assert.equal(await forgetApplyFirstPerson(shop.sid, ann), 2);
  assert.ok(sent.length <= APPLY_FORGET_COMMANDS, `forget ${sent.length}`);
  assert.deepEqual(await applicationsOfPerson(shop.sid, ann), []);
  assert.deepEqual((await listApplications(shop, clock))?.map((a) => a.id), [kept.id]);
  assert.equal((await applicationsOfPerson(other.sid, ann))[0]?.id, elsewhere.id);
  // A second run finds nothing more.
  assert.equal(await forgetApplyFirstPerson(shop.sid, ann), 0);
  // A delete that does not answer exactly is not "deleted".
  await submit(ann);
  fault = (command) => (command[0] === "DEL" ? "1" : undefined);
  await assert.rejects(forgetApplyFirstPerson(shop.sid, ann), UnknownReplyError);
  fault = null;
  assert.equal(await forgetApplyFirstPerson(null, ann), 0);
});

test("each call stays within its stated command ceiling, scripts' own commands counted", async () => {
  assert.equal(scriptSteps(APPLY_NEW), 12);
  assert.equal(scriptSteps(APPLY_CHANGE), 8);
  const counted = () => sent.reduce((n, c) => n + 1 + (String(c[1]) === APPLY_NEW ? scriptSteps(APPLY_NEW) : String(c[1]) === APPLY_CHANGE ? scriptSteps(APPLY_CHANGE) : 0), 0);
  sent = [];
  const one = await submit();
  assert.ok(counted() + 1 <= APPLY_SUBMIT_COMMANDS, `submit ${counted()} and a read back`);
  sent = [];
  await decideApplication(shop, one.id, { kind: "approve" }, clock + 1);
  assert.ok(counted() + 1 <= APPLY_DECIDE_COMMANDS, `decide ${counted()} and a read back`);
  sent = [];
  await listApplications(shop, clock);
  assert.ok(counted() <= APPLY_LIST_COMMANDS);
  sent = [];
  await applicationsOfPerson(shop.sid, ann);
  assert.ok(counted() <= APPLY_COPY_COMMANDS);
});

test("a person's deletion and copy run this file's own functions, by the store's sid (lib/person-erasure.ts, lib/person-copy.ts)", async () => {
  const one = await submit();
  await submit(bob);
  at(START + 2_000);
  await decideApplication(shop, one.id, { kind: "decline" }, clock);
  // Only what these two read is set; the rest of a scope is never reached by them.
  const scope = { sid: shop.sid, statsId: "x".repeat(24), email: "ann@example.invalid" } as unknown as ErasureScope;
  assert.deepEqual(PERSON_DATA.filter((d) => d.file === "lib/apply-first-store.ts").map((d) => d.how), ["erased"]);
  assert.equal(COPY_PLAN["lib/apply-first-store.ts"]?.how, "copied");
  assert.deepEqual(await COPIERS["lib/apply-first-store.ts"](scope), [{
    offer, state: "declined", applied: new Date(START).toISOString(), decided: new Date(START + 2_000).toISOString(), linkEnds: "", linkUsed: "",
  }]);
  const eraser = ERASERS.find((e) => e.module === "lib/apply-first-store.ts");
  assert.ok(eraser && !eraser.only, "both doors delete them");
  assert.equal(await eraser.run(scope, [], new Set()), 1);
  assert.deepEqual(await COPIERS["lib/apply-first-store.ts"](scope), []);
  assert.deepEqual((await listApplications(shop, clock))?.map((a) => a.email), [bob]);
});
