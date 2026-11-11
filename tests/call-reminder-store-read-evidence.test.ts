import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sendCallReminders } from "@/lib/call-reminders";
import { REMINDER_QUEUE } from "@/lib/call-records";
import { readFileSync } from "node:fs";
import { storeForHandleExactly } from "@/lib/store";
import { store as redis } from "./redis-stub";

// The cron (app/api/cron/mail/route.ts) passes storeForHandleExactly. A store read that
// answers in an unknown shape is not a store that is gone: the due reminder must
// stay queued, as a thrown read already keeps it (Claude 1 MEDIUM on #2508).
const pipeline = redis.pipeline.bind(redis);
const now = Date.now();
const member = `calls-evidence|harbor|cs_test_123456789012345678901234|1|${now + 3600_000}`;
const originalFetch = globalThis.fetch;
const originalKey = process.env.RESEND_API_KEY;
let handleReply: unknown;

beforeEach(async () => {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_call_reminder_only";
  globalThis.fetch = (async () => { throw new Error("Unexpected external request"); }) as typeof fetch;
  await pipeline([["ZADD", REMINDER_QUEUE, String(now - 1000), member]]);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "GET" && commands[0]?.[1] === "nl:store:handle:harbor") return handleReply as never;
    return pipeline(commands);
  }) as typeof redis.pipeline;
});
afterEach(() => {
  redis.pipeline = pipeline;
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalKey;
});

const queued = async () => (await pipeline([["ZRANGEBYSCORE", REMINDER_QUEUE, "-inf", "+inf"]]))[0] as string[];

for (const [label, value] of Object.entries({ empty: [], extra: [null, null], wrongType: [7], emptyString: [""] })) {
  test(`an unknown store read keeps the due reminder queued: ${label}`, async () => {
    handleReply = value;
    const counts = await sendCallReminders((handle) => storeForHandleExactly(handle), Date.now() + 60_000, "https://local.example").catch(() => null);
    assert.deepEqual(await queued(), [member]);
    if (counts) assert.equal(counts.dropped, 0);
  });
}

test("a confirmed absent store still lets the reminder go", async () => {
  handleReply = [null];
  const counts = await sendCallReminders((handle) => storeForHandleExactly(handle), Date.now() + 60_000, "https://local.example");
  assert.deepEqual(await queued(), []);
  assert.equal(counts.dropped, 1);
});

test("the cron hands the reminders the exact store reader", () => {
  const route = readFileSync("app/api/cron/mail/route.ts", "utf8");
  assert.match(route, /sendCallReminders\(storeForHandleExactly,/);
});

test("an unknown store read still lets a reminder go once it is hours late", async () => {
  handleReply = [];
  const late = `calls-evidence|harbor|cs_test_223456789012345678901234|1|${now - 3600_000}`;
  await pipeline([["ZADD", REMINDER_QUEUE, String(now - 7 * 3600_000), late]]);
  const counts = await sendCallReminders((handle) => storeForHandleExactly(handle), Date.now() + 60_000, "https://local.example");
  assert.deepEqual(await queued(), [member]);
  assert.equal(counts.dropped, 1);
});
