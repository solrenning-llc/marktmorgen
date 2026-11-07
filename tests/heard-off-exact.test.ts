/**
 * Whether a creator turned "Where did you hear about us?" off is read exactly
 * (CX-123 rule 24), like weeklyOff in lib/stats-report.ts: 0 means asking, 1
 * means off, and a reply in any other shape means "off" (the buyer is not asked
 * on a question we cannot tell the creator wanted) and is said in the log.
 * Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { heardOff, recordHeard, setHeardOff } from "@/lib/heard";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_heard_off_exact_only";

const MALFORMED: [string, unknown[]][] = [
  ["no reply at all", []],
  ["undefined", [undefined]],
  ["null", [null]],
  ["QUEUED", ["QUEUED"]],
  ["the string 1", ["1"]],
  ["the string 0", ["0"]],
  ["two replies", [0, 0]],
  ["a negative count", [-1]],
  ["a count of two", [2]],
  ["a fraction", [0.5]],
  ["an object", [{}]],
];

async function withReply<T>(reply: unknown[], run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "SISMEMBER" ? reply : original(commands))) as typeof redis.pipeline;
  try { return await run(); } finally { redis.pipeline = original; }
}

async function logged<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { return { value: await run(), lines }; } finally { console.error = original; }
}

for (const [label, reply] of MALFORMED) {
  test(`heardOff: ${label} is off (not asked) and is logged`, async () => {
    const { value, lines } = await logged(() => withReply(reply, () => heardOff("harbor")));
    assert.equal(value, true);
    assert.ok(lines.some((l) => l.includes("heard-off")), "the unknown reply is said in the log");
  });
}

test("recordHeard counts nothing on an unknown reply", async () => {
  const store = { handle: "harbor", stripeAccountId: "acct_1TestHeardOff01", statsId: "synthetic-stats", currency: "usd" } as unknown as Parameters<typeof recordHeard>[0];
  const { value } = await logged(() => withReply(["QUEUED"], () => recordHeard(store, "cs_test_heardoff00001", "friend")));
  assert.equal(value, "off");
});

test("healthy controls: on by default, off once switched off, on again, and nothing is logged", async () => {
  redis.clear();
  const { value, lines } = await logged(async () => {
    const out = [await heardOff("harbor")];
    await setHeardOff("harbor", true);
    out.push(await heardOff("harbor"));
    await setHeardOff("harbor", false);
    out.push(await heardOff("harbor"));
    return out;
  });
  assert.deepEqual(value, [false, true, false]);
  assert.deepEqual(lines, []);
});

test("confirmed replies 0 and 1 are read as before", async () => {
  assert.equal(await withReply([0], () => heardOff("harbor")), false);
  assert.equal(await withReply([1], () => heardOff("harbor")), true);
});
