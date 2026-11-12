import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sendCallReminders } from "@/lib/call-reminders";
import { REMINDER_QUEUE } from "@/lib/call-records";
import { store as redis } from "./redis-stub";

const pipeline = redis.pipeline.bind(redis);
const now = Date.now();
const member = `calls-evidence|harbor|cs_test_123456789012345678901234|1|${now + 3600_000}`;
const originalFetch = globalThis.fetch;
const originalKey = process.env.RESEND_API_KEY;
const originalStripeKey = process.env.STRIPE_SECRET_KEY;
let reply: unknown;
let reads: number;
let mutations: number;
let lookups: number;

beforeEach(() => {
  redis.clear();
  reads = 0; mutations = 0; lookups = 0;
  process.env.RESEND_API_KEY = "re_test_call_reminder_only";
  globalThis.fetch = (async () => { throw new Error("Unexpected external request"); }) as typeof fetch;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "ZRANGEBYSCORE" && commands[0]?.[1] === REMINDER_QUEUE) {
      reads += 1;
      return reply as never;
    }
    mutations += commands.length;
    return pipeline(commands);
  }) as typeof redis.pipeline;
});
afterEach(() => {
  redis.pipeline = pipeline;
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalKey;
  if (originalStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalStripeKey;
});

const run = (findStore: (handle: string) => Promise<import("@/lib/store").Store | null> = async () => { lookups += 1; return null; }) => sendCallReminders(findStore, Date.now() + 60_000, "https://local.example");

for (const [label, value] of Object.entries({
  absent: [], null: [null], wrongType: [{}], outerExtra: [[], null],
  odd: [[member, String(now - 1), member]],
  partialPair: [[member]],
  sparse: [Array(2)],
  nullMember: [[null, String(now - 1)]],
  nullScore: [[member, null]],
  emptyScore: [[member, ""]],
  badScore: [[member, "unknown"]],
  infiniteScore: [[member, Infinity]],
  futureScore: [[member, String(now + 86_400_000)]],
  overBound: [Array.from({ length: 201 }, () => [member, String(now - 1)]).flat()],
})) {
  test(`unconfirmed due queue is not a successful empty run: ${label}`, async () => {
    reply = value;
    await assert.rejects(run(), /reminder queue could not be read/);
    assert.equal(reads, 1);
    assert.equal(lookups, 0, "validate the whole queue before acting on even a valid first pair");
    assert.equal(mutations, 0, "unknown evidence cannot remove due work");
  });
}

test("confirmed empty due queue remains a successful empty run", async () => {
  reply = [[]];
  assert.deepEqual(await run(), { reminded: 0, confirmed: 0, dropped: 0 });
  assert.equal(reads, 1); assert.equal(lookups, 0); assert.equal(mutations, 0);
});

test("an unknown store lookup preserves due reminders", async () => {
  reply = [[member, String(now - 1)]];
  const counts = await run(async () => { throw new Error("synthetic store read timeout"); });
  assert.deepEqual(counts, { reminded: 0, confirmed: 0, dropped: 0 });
  assert.equal(lookups, 0);
  assert.equal(mutations, 0, "an unknown store must not ZREM the due reminder");
});

test("an unknown single-session payment read preserves due reminders", async () => {
  reply = [[member, String(now - 1)]];
  process.env.STRIPE_SECRET_KEY = "sk_test_call_reminder_only";
  let stripeReads = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.stripe.com");
    if (url.pathname === "/v1/checkout/sessions") {
      stripeReads += 1;
      return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
    }
    if (url.pathname === "/v1/checkout/sessions/cs_test_123456789012345678901234") {
      stripeReads += 1;
      return new Response(JSON.stringify({ error: { message: "synthetic timeout", type: "api_error" } }), { status: 503 });
    }
    throw new Error("unexpected synthetic Stripe route");
  }) as typeof fetch;
  const store = { callsId: "calls-evidence", handle: "harbor", email: "owner@example.invalid", stripeAccountId: "acct_test_reminders", previousHandles: [] } as unknown as import("@/lib/store").Store;
  const counts = await run(async () => store);
  assert.deepEqual(counts, { reminded: 0, confirmed: 0, dropped: 0 });
  assert.equal(stripeReads, 2, "the list is confirmed empty before the individual read fails");
  assert.equal(mutations, 0, "an unknown payment read must not ZREM the due reminder");
});

// Claude 3 (nuvem A) on #2508, MEDIUM 2: an unknown single-session read keeps the reminder only while it can still be
// of use, as a failed list read does (GIVE_UP_MS, six hours); past it the reminder leaves the queue and is counted
// dropped, so one session Stripe never answers for cannot hold the head of the queue for good.
test("a single-session payment read that keeps failing gives up once the reminder is hours late", async () => {
  reply = [[member, String(now - 7 * 3600_000)]];
  process.env.STRIPE_SECRET_KEY = "sk_test_call_reminder_only";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: "synthetic timeout", type: "api_error" } }), { status: 503 });
  }) as typeof fetch;
  const store = { callsId: "calls-evidence", handle: "harbor", email: "owner@example.invalid", stripeAccountId: "acct_test_reminders", previousHandles: [] } as unknown as import("@/lib/store").Store;
  const counts = await run(async () => store);
  assert.equal(counts.dropped, 1, "a reminder seven hours late is given up on");
  assert.ok(mutations > 0, "and taken out of the queue");
});

test("a complete due pair is processed, with string and numeric scores", async () => {
  for (const score of [String(now - 1), now - 1]) {
    reply = [[member, score]];
    assert.deepEqual(await run(), { reminded: 0, confirmed: 0, dropped: 1 });
  }
  assert.equal(lookups, 2, "explicitly absent stores retain existing cleanup");
});
