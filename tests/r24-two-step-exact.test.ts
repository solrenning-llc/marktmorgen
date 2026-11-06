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
 *     another shape; a session with no lock is still open;
 *   - a code is spent only on SET NX's own "OK": an unknown answer rejects;
 *   - mayAddSecondStep refuses and hasSecondStep answers yes on an unknown record.
 *
 * Synthetic records only; no email leaves.
 */
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { openSession } from "@/lib/auth";
import { checkCode, lockedUntil, openLockedSession, twoStepOn } from "@/lib/two-step";
import { hasSecondStep, mayAddSecondStep } from "@/lib/second-step-gate";
import { finishProvenSignIn } from "@/lib/signin-finish";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const recordKey = (email: string) => `nl:2fa:${sha(`nimbus-2fa:${email}`).slice(0, 40)}`;
const lockedKey = (session: string) => `nl:2fa:locked:${sha(`nimbus-2fa-locked:${session}`).slice(0, 40)}`;
const codeHash = (code: string) => sha(`nimbus-2fa-code:${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`);

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
