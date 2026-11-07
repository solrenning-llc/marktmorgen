/**
 * Rule 24 for two-step login (lib/two-step.ts, lib/second-step-gate.ts,
 * lib/signin-finish.ts): a reply in an unknown shape is never "two-step login
 * is off", never "this session is not locked" and never "this code is fresh".
 *
 *   - twoStepOn rejects an unknown record reply (and a stored record that does
 *     not parse); a record that is there answers true, one that is not, false;
 *   - a login proven by the emailed link opens no session while the record
 *     cannot be read, and says so honestly;
 *   - lockedUntil answers locked when its MGET, or the lock it reads, is in
 *     another shape; a session with no lock is still open; past the lock's day,
 *     a kept mark or a lock's opening time in another shape keeps it locked
 *     (Codex J and Claude 5 on #2896), never sets it free;
 *   - a code is spent only on SET NX's own "OK": an unknown answer rejects;
 *   - mayAddSecondStep refuses and hasSecondStep answers yes on an unknown record.
 *
 * Synthetic records only; no email leaves.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { openSession } from "@/lib/auth";
import { checkCode, finishSignIn, holdSignIn, lockedUntil, openLockedSession, twoStepOn } from "@/lib/two-step";
import { hasSecondStep, mayAddSecondStep } from "@/lib/second-step-gate";
import { finishProvenSignIn } from "@/lib/signin-finish";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const recordKey = (email: string) => `nl:2fa:${sha(`nimbus-2fa:${email}`).slice(0, 40)}`;
const lockedKey = (session: string) => `nl:2fa:locked:${sha(`nimbus-2fa-locked:${session}`).slice(0, 40)}`;
const keptKey = (email: string) => `nl:2fa:lockedset:${sha(`nimbus-2fa-lockedset:${email}`).slice(0, 40)}:kept`;
const codeHash = (code: string) => sha(`nimbus-2fa-code:${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`);
const holdKey = (token: string) => `nl:2fa:hold:${sha(`nimbus-2fa-hold:${token}`).slice(0, 40)}`;

const ON = "r24-on@example.com";
const OFF = "r24-off@example.com";
const record = (codes: string[]) => JSON.stringify({ s: "synthetic-sealed-secret", since: 1, codes: codes.map(codeHash), last: -1, reset: 0, backup: "" });

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
/** Every command `match` picks answers `reply` instead; "short" answers the whole pipeline with no replies at all. */
async function withReply<T>(match: (cmd: Cmd) => boolean, reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Cmd[]) => {
    const out = await original(commands);
    if (!commands.some(match)) return out;
    if (reply === "short") return [];
    return commands.map((cmd, i) => (match(cmd) ? reply : out[i]));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}
const isGet = (key: string) => (cmd: Cmd) => cmd[0] === "GET" && cmd[1] === key;

const ready = (async () => {
  redis.clear();
  await original([["SET", recordKey(ON), record(["abcd-efgh", "jkmn-pqrs", "tuvw-xyz2"])]]);
})();

const UNKNOWN: [string, unknown][] = [["short pipeline", "short"], ["undefined", undefined], ["object", {}], ["number", 7], ["list", ["x"]]];

test("twoStepOn: a record there is on, none is off", async () => {
  await ready;
  assert.equal(await twoStepOn(ON), true);
  assert.equal(await twoStepOn(OFF), false);
});

for (const [label, reply] of UNKNOWN) {
  test(`twoStepOn rejects a record read as ${label} rather than saying it is off`, async () => {
    await ready;
    await withReply(isGet(recordKey(ON)), reply, () => assert.rejects(() => twoStepOn(ON)));
  });
}

test("twoStepOn rejects a stored record that does not parse", async () => {
  await ready;
  await withReply(isGet(recordKey(ON)), "{not json", () => assert.rejects(() => twoStepOn(ON)));
});

const signIn = () => finishProvenSignIn(new NextRequest("https://marktmorgen.com/api/auth/callback", { method: "POST" }), ON, "link", "/studio");

test("a link login with two-step on waits for the code (healthy control)", async () => {
  await ready;
  const response = await signIn();
  assert.equal(response.headers.get("location"), "https://marktmorgen.com/signin/code");
  assert.ok(!(response.headers.get("set-cookie") ?? "").includes("nl_session="));
});

for (const [label, reply] of UNKNOWN) {
  test(`a link login opens no session when the record reads as ${label}`, async () => {
    await ready;
    const response = await withReply(isGet(recordKey(ON)), reply, signIn);
    assert.ok(!(response.headers.get("set-cookie") ?? "").includes("nl_session="), "no session cookie");
    assert.equal(response.headers.get("location"), "https://marktmorgen.com/signin?status=login-unknown");
  });
}

test("lockedUntil: a locked session is locked, an ordinary one is not (controls)", async () => {
  await ready;
  const until = Date.now() + 7 * 86_400_000;
  const locked = await openLockedSession(ON, until);
  assert.equal(await lockedUntil(locked), until);
  const open = await openSession(OFF);
  assert.equal(await lockedUntil(open), 0);
});

for (const [label, reply] of [["short pipeline", "short"], ["undefined", undefined], ["object", {}], ["two items", [null, null]], ["number in a slot", [7, null, null]]] as [string, unknown][]) {
  test(`lockedUntil answers locked when its MGET reads as ${label}`, async () => {
    await ready;
    const locked = await openLockedSession(ON, Date.now() + 7 * 86_400_000);
    const open = await openSession(OFF);
    await withReply((cmd) => cmd[0] === "MGET", reply, async () => {
      assert.ok((await lockedUntil(locked)) > Date.now(), "the locked session stays locked");
      assert.ok((await lockedUntil(open)) > Date.now(), "an unknown answer is never read as unlocked");
    });
  });
}

test("lockedUntil answers locked when the lock itself is in another shape", async () => {
  await ready;
  const locked = await openLockedSession(ON, Date.now() + 7 * 86_400_000);
  await original([["SET", lockedKey(locked), "garbage|1", "EX", 3600]]);
  assert.ok((await lockedUntil(locked)) > Date.now());
});

// Past its day, a lock stays only while its account's locked sessions are kept (endLocked could not log them out
// after it opened): the kept mark's time and the lock's own opening time are read exactly, or it stays locked.
const LATE = "r24-late@example.com";
const DAY = 86_400_000;
/** A session whose lock ran out yesterday, opened ten days ago, with its account kept locked a second after. */
async function pastItsDay(): Promise<{ session: string; opened: number; until: number }> {
  const opened = Date.now() - 10 * DAY;
  const until = Date.now() - DAY;
  const session = await openLockedSession(LATE, until, opened);
  await original([["SET", keptKey(LATE), String(opened + 1000)]]);
  return { session, opened, until };
}
const isKeptGet = (cmd: Cmd) => cmd[0] === "GET" && cmd[1] === keptKey(LATE);

test("past its day: kept locked by a kept mark after it opened, set free without one (controls)", async () => {
  await ready;
  const { session } = await pastItsDay();
  assert.ok((await lockedUntil(session)) > Date.now(), "kept after it opened: still locked");
  await original([["DEL", keptKey(LATE)]]);
  assert.equal(await lockedUntil(session), 0, "no kept mark: its day is over");
  const { session: later, opened } = await pastItsDay();
  await original([["SET", keptKey(LATE), String(opened - 1000)]]);
  assert.equal(await lockedUntil(later), 0, "opened after the mark: not kept");
});

for (const [label, reply] of [["empty text", ""], ["a space", " "], ["scientific", "1e2"], ["hexadecimal", "0x10"], ["a number", 7], ["an object", {}], ["short pipeline", "short"]] as [string, unknown][]) {
  test(`past its day, a kept mark read as ${label}: still locked, never set free`, async () => {
    await ready;
    const { session } = await pastItsDay();
    await withReply(isKeptGet, reply, async () => {
      assert.ok((await lockedUntil(session)) > Date.now(), "an unknown mark counts as kept");
    });
  });
}

for (const [label, opening] of [["scientific", "1e20"], ["padded", " 99999999999999 "], ["hexadecimal", "0x7fffffffffff"], ["empty", ""]] as [string, string][]) {
  test(`past its day, its lock's opening time read as ${label}: still locked, never set free`, async () => {
    await ready;
    const { session, until } = await pastItsDay();
    await original([["SET", lockedKey(session), `${until}|${opening}`, "EX", 3600]]);
    assert.ok((await lockedUntil(session)) > Date.now(), "an unknown opening time is never later than the mark");
  });
}

test("past its day, a lock with more parts than this code writes: still locked", async () => {
  await ready;
  const { session, until, opened } = await pastItsDay();
  await original([["SET", lockedKey(session), `${until}|${opened + 5000}|x`, "EX", 3600]]);
  assert.ok((await lockedUntil(session)) > Date.now());
});

const isOnce = (cmd: Cmd) => cmd[0] === "SET" && String(cmd[1]).startsWith("nl:2fa:once:");

test("a recovery code is spent on SET NX's OK (healthy control)", async () => {
  await ready;
  assert.equal(await checkCode(ON, "abcd-efgh"), "recovery");
});

test("a code whose once-mark is already there (SET NX null) is wrong (confirmed control)", async () => {
  await ready;
  assert.equal(await withReply(isOnce, null, () => checkCode(ON, "jkmn-pqrs")), "wrong");
});

for (const [label, reply] of UNKNOWN) {
  test(`a code whose SET NX answers ${label} is never taken as fresh`, async () => {
    await ready;
    await withReply(isOnce, reply, () => assert.rejects(() => checkCode(ON, "tuvw-xyz2")));
  });
}

test("adding a second step: refused, and one counted as there, while the record cannot be read", async () => {
  await ready;
  const session = await openSession(ON);
  assert.equal(await mayAddSecondStep(ON, session), false, "healthy: a link session adds nothing to an account with an app");
  assert.equal(await mayAddSecondStep(OFF, await openSession(OFF)), true, "confirmed absence: the first way in may be added");
  for (const [label, reply] of UNKNOWN) {
    await withReply(isGet(recordKey(ON)), reply, async () => {
      assert.equal(await hasSecondStep(ON), true, `hasSecondStep on ${label}`);
      assert.equal(await mayAddSecondStep(ON, session), false, `mayAddSecondStep on ${label}`);
    });
  }
});

// ?status=constructor (or any name Object.prototype holds) picks no notice on the login pages: the tables are read
// only by their own keys, as TOASTS already is (on /signin/code an inherited function would be drawn as a child).
for (const path of ["app/signin/page.tsx", "app/signin/code/page.tsx"]) {
  test(`${path} reads ?status= only as one of its own notices`, () => {
    const text = readFileSync(path, "utf8");
    assert.equal((text.match(/NOTICES\[status\]/g) ?? []).length, (text.match(/Object\.hasOwn\(NOTICES, status\) \? NOTICES\[status\]/g) ?? []).length);
    assert.match(text, /Object\.hasOwn\(NOTICES, status\)/);
  });
}

// Claude 5 on #2896 (LIGHT 4): an unknown reply after the wait was spent is said as a login that could not be
// finished, never as an expired link; the notice says "now" once.
test("the code page: no wait left after an unknown reply says the login could not be finished, in plain words", () => {
  const text = readFileSync("app/signin/code/page.tsx", "utf8");
  assert.match(text, /if \(!email\) redirect\(\["unknown", "reset-unknown"\]\.includes\(status\) \? "\/signin\?status=login-unknown" : "\/signin\?status=expired"\);/);
  assert.doesNotMatch(text, /shows then\./);
  assert.match(text, /unknown: "Your code could not be checked just now, and nothing was opened\. Wait a moment, then type the code your app shows now\."/);
});

// Claude 5 on #2896 (MEDIUM, rule 30): the day two-step login turns off by itself is read only in a shape this code
// writes (0, or a whole millisecond at least RESET_DAYS after `since`). Any other number turned it off at once and
// opened a full session on the emailed link alone.
const RESET_ON = "r24-reset@example.com";
const resetRecord = (reset: unknown, since = 1) => JSON.stringify({ s: "synthetic-sealed-secret", since, codes: [codeHash("abcd-efgh")], last: -1, reset, backup: "" });
const resetSignIn = () => finishProvenSignIn(new NextRequest("https://marktmorgen.com/api/auth/callback", { method: "POST" }), RESET_ON, "link", "/studio");
for (const [label, reset, since] of [["0.5", 0.5, 1], ["1e2 (100 ms after 1970)", 100, 1], ["1.5", 1.5, 1], ["a negative day", -5, 1], ["text", "9", 1], ["null", null, 1], ["a day less than a week after it was turned on", Date.now() - 3_600_000, Date.now() - 86_400_000]] as [string, unknown, number][]) {
  test(`a link login opens no session when the turn-off day reads as ${label}`, async () => {
    await ready;
    await original([["SET", recordKey(RESET_ON), resetRecord(reset, since)]]);
    const response = await resetSignIn();
    assert.ok(!(response.headers.get("set-cookie") ?? "").includes("nl_session="), "no session cookie");
    assert.equal(response.headers.get("location"), "https://marktmorgen.com/signin?status=login-unknown");
    assert.equal(await original([["EXISTS", recordKey(RESET_ON)]]).then((r) => r[0]), 1, "two-step login is still on");
  });
}
for (const [label, reset] of [["0 (none asked)", 0], ["tomorrow", Date.now() + 86_400_000]] as [string, number][]) {
  test(`control: a turn-off day of ${label} waits for the code`, async () => {
    await ready;
    await original([["SET", recordKey(RESET_ON), resetRecord(reset)]]);
    const response = await resetSignIn();
    assert.equal(response.headers.get("location"), "https://marktmorgen.com/signin/code");
  });
}

// Claude 5 on #2896 (LIGHT 1): a waiting login's count of wrong codes read in another shape is spent, never counted
// from zero again; (LIGHT 2) its delete is read through countOf.
for (const [label, n] of [["5x", "5x"], ["null", null], ["an object", {}], ["1.5", 1.5], ["-1", -1], ["6", 6]] as [string, unknown][]) {
  test(`a waiting login whose wrong-code count reads as ${label} is spent, never judged again`, async () => {
    await ready;
    const token = await holdSignIn(ON);
    await original([["SET", holdKey(token), JSON.stringify({ e: ON, n }), "EX", 600]]);
    const answer = await finishSignIn(token, "000000");
    assert.deepEqual(answer, { ok: false, reason: "expired" });
    assert.equal((await original([["EXISTS", holdKey(token)]]))[0], 0, "the wait is spent");
  });
}
test("control: a waiting login with four wrong codes judges the fifth", async () => {
  await ready;
  const who = "r24-tries-control@example.com";
  await original([["SET", recordKey(who), record(["abcd-efgh"])]]);
  const token = await holdSignIn(who);
  await original([["SET", holdKey(token), JSON.stringify({ e: who, n: 4 }), "EX", 600]]);
  const answer = await finishSignIn(token, "zzzz-zzzz");
  assert.equal(answer.ok, false);
  assert.notEqual(answer.ok === false && answer.reason, "expired", "the code is judged, the wait not spent");
  assert.equal((await original([["EXISTS", holdKey(token)]]))[0], 1);
});
test("a right recovery code whose wait's delete answers \"1\" is not a delete it made", async () => {
  await ready;
  const who = "r24-tries-delete@example.com";
  await original([["SET", recordKey(who), record(["abcd-efgh"])]]);
  const token = await holdSignIn(who);
  const answer = await withReply((cmd) => cmd[0] === "DEL" && cmd[1] === holdKey(token), "1", () => finishSignIn(token, "abcd-efgh"));
  assert.deepEqual(answer, { ok: false, reason: "expired" });
});
