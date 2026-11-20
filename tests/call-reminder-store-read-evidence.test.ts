import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as reminders from "@/lib/call-reminders";
import * as stores from "@/lib/store";
import { REMINDER_QUEUE } from "@/lib/call-records";
import { store as redis } from "./redis-stub";

// Claude 3 (cloud G) on #2508: the mail cron hands sendCallReminders a store reader. A handle read that answers in an
// unknown shape is not a store that is gone, so the due reminder must stay queued, as a thrown read already keeps it.
// The reader is the one the cron really passes, taken from app/api/cron/mail/route.ts, never a stand-in.
const pipeline = redis.pipeline.bind(redis);
const now = Date.now();
const member = `calls-evidence|harbor|cs_test_123456789012345678901234|1|${now + 3600_000}`;
const originalFetch = globalThis.fetch;
const originalKey = process.env.RESEND_API_KEY;
let handleReply: unknown;

const cron = readFileSync(join(process.cwd(), "app/api/cron/mail/route.ts"), "utf8");
const passed = /sendCallReminders\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(cron)?.[1];
type Reader = (handle: string) => Promise<stores.Store | null>;
const cronReader = (): Reader => {
  assert.ok(passed, "the mail cron passes a named store reader to sendCallReminders");
  const reader = (reminders as Record<string, unknown>)[passed] ?? (stores as Record<string, unknown>)[passed];
  assert.equal(typeof reader, "function", `${passed} is a store reader`);
  return reader as Reader;
};

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

for (const [label, value] of Object.entries({
  empty: [], extra: [null, null], wrongType: [7], emptyString: [""],
  recordMissing: ["owner@example.invalid"],
})) {
  test(`an unknown store read by the cron's reader keeps the due reminder queued: ${label}`, async () => {
    handleReply = value;
    const counts = await reminders.sendCallReminders(cronReader(), Date.now() + 60_000, "https://local.example");
    assert.deepEqual(await queued(), [member]);
    assert.equal(counts.dropped, 0);
  });
}

test("a confirmed absent store, read by the cron's reader, still lets the reminder go", async () => {
  handleReply = [null];
  const counts = await reminders.sendCallReminders(cronReader(), Date.now() + 60_000, "https://local.example");
  assert.deepEqual(await queued(), []);
  assert.equal(counts.dropped, 1);
});

test("an address that was let go, read by the cron's reader, still lets the reminder go", async () => {
  handleReply = ["released:owner@example.invalid"];
  const counts = await reminders.sendCallReminders(cronReader(), Date.now() + 60_000, "https://local.example");
  assert.deepEqual(await queued(), []);
  assert.equal(counts.dropped, 1);
});
