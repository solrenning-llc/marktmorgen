/**
 * Rule 24 for a session kept locked (lib/two-step.ts keptListed): a session
 * whose own lock is gone, of an account whose locked sessions could not be
 * logged out (the kept mark), asks three things in one pipeline: whether the
 * mark is there (EXISTS), whether the session is in the account's locked set
 * (SISMEMBER), and how long that set lasts (PTTL). Only those three replies in
 * their exact shape may set it free: a pipeline cut short, with a reply too
 * many, with a hole or a getter is unknown, and an unknown two-step lock is
 * locked, never "not locked" (an unlocked session may change the sign-in
 * address, the passkeys, two-step login and the payout details).
 *
 * Synthetic records only; no email leaves.
 */
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openSession } from "@/lib/auth";
import { lockedUntil, openLockedSession } from "@/lib/two-step";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const lockedKey = (session: string) => `nl:2fa:locked:${sha(`nimbus-2fa-locked:${session}`).slice(0, 40)}`;
const lockedSetKey = (email: string) => `nl:2fa:lockedset:${sha(`nimbus-2fa-lockedset:${email}`).slice(0, 40)}`;
const keptKey = (email: string) => `${lockedSetKey(email)}:kept`;
const KEPT_ANY = keptKey("any account");

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);

const KEPT = "r24-kept@example.com";
const OTHER = "r24-kept-other@example.com";

/** A session of KEPT whose own lock is gone, still in its account's locked set, with the account's kept mark and "*" in the list of kept accounts. */
async function keptSession(): Promise<string> {
  const session = await openLockedSession(KEPT, Date.now() + 7 * 86_400_000);
  await original([
    ["DEL", lockedKey(session)],
    ["SET", keptKey(KEPT), String(Date.now()), "EX", 3600],
    ["SET", KEPT_ANY, "*", "EX", 3600],
  ]);
  return session;
}

/** keptListed's pipeline (it starts with EXISTS of a kept mark) answers `reply` as a whole; every other pipeline is untouched. */
async function withKeptReply<T>(reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Cmd[]) => {
    const out = await original(commands);
    const first = commands[0];
    if (first?.[0] === "EXISTS" && String(first[1]).endsWith(":kept")) return typeof reply === "function" ? (reply as (out: unknown[]) => unknown)(out) : reply;
    return out;
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

const ready = (async () => {
  redis.clear();
})();

test("a kept session is still locked; with no kept mark, or out of the set, it is not (controls)", async () => {
  await ready;
  const session = await keptSession();
  assert.ok((await lockedUntil(session)) > Date.now(), "kept and listed: locked");
  await original([["DEL", keptKey(KEPT)]]);
  assert.equal(await lockedUntil(session), 0, "no kept mark (EXISTS 0): its day is over");
  const listedOut = await keptSession();
  await original([["SREM", lockedSetKey(KEPT), listedOut]]);
  assert.equal(await lockedUntil(listedOut), 0, "not in the set (SISMEMBER 0): not kept");
  const plain = await openSession(OTHER);
  assert.equal(await lockedUntil(plain), 0, "a session of an account never locked");
});

test("the three replies in their exact shape answer as the healthy read does (control)", async () => {
  await ready;
  const session = await keptSession();
  assert.ok((await withKeptReply([1, 1, 60_000], () => lockedUntil(session))) > Date.now(), "kept, listed: locked");
  assert.equal(await withKeptReply([0, 1, 60_000], () => lockedUntil(session)), 0, "confirmed no mark: not locked");
  assert.equal(await withKeptReply([1, 0, 60_000], () => lockedUntil(session)), 0, "confirmed not listed: not locked");
});

const sparse: unknown[] = [0, 0];
sparse.length = 3;
const getter: unknown[] = [0, 0, 0];
Object.defineProperty(getter, "0", { get: () => 0, enumerable: true });
const SHAPES: [string, unknown][] = [
  ["cut short to one zero", [0]],
  ["cut short to two zeros", [0, 0]],
  ["a reply too many", [0, 0, 0, 0]],
  ["a hole in the third slot", sparse],
  ["a getter in the first slot", getter],
  ["not a list", { 0: 0, 1: 0, 2: 0, length: 3 }],
  ["a Proxy over a list of zeros", new Proxy([0, 0, 0], {})],
];

for (const [label, reply] of SHAPES) {
  test(`a kept session whose three replies read as ${label}: locked, never set free`, async () => {
    await ready;
    const session = await keptSession();
    const until = await withKeptReply(reply, () => lockedUntil(session));
    assert.ok(until > Date.now(), `an unknown answer is never "not locked" (got ${until})`);
  });
}
