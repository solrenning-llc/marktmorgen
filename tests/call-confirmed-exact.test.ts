/**
 * Whether a booked call was already confirmed (lib/calls.ts, isConfirmed) is read exactly (rule 24). It read the EXISTS
 * reply as `Number(seen) === 1`, so a reply lost or in another shape (true, [1], "1", null) was "not confirmed": the
 * reminder job (lib/call-reminders.ts) then confirmed the booking again, sending the buyer and the creator the paid
 * confirmation a second time, and a package's lapsed hold counted as a session not used. Now EXISTS 1 is confirmed,
 * 0 is not, and anything else throws UnknownReplyError (the reminder stays in line for the next run). Synthetic only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { isConfirmed } from "@/lib/calls";
import { UnknownReplyError } from "@/lib/redis-reply";

const real = redis.pipeline.bind(redis);
let odd: unknown = undefined;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (odd !== undefined && commands.length === 1 && commands[0][0] === "EXISTS") return odd === "LOST" ? [] : [odd];
  return real(commands);
}) as typeof redis.pipeline;

beforeEach(() => {
  redis.clear();
  odd = undefined;
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
});

for (const reply of [true, [1], "1", null, 2, -1, "LOST"]) {
  test(`a confirmation mark read as ${JSON.stringify(reply)} is unknown, never "not confirmed"`, async () => {
    odd = reply;
    await assert.rejects(isConfirmed("cs_test_" + "a".repeat(24)), UnknownReplyError);
  });
}

test("EXISTS 1 is confirmed and 0 is not", async () => {
  odd = 1;
  assert.equal(await isConfirmed("cs_test_" + "b".repeat(24)), true);
  odd = 0;
  assert.equal(await isConfirmed("cs_test_" + "b".repeat(24)), false);
});

// Revisor 1's LEVE on claude4/call-confirmed-exact: the throw above reaches packageState. A package whose sessions left
// cannot be read is never a server error and never sells a session: preparing one says "error", holding one says no
// (the time is let go), and the booking page reads it as unknown, booking nothing.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { holdSession, prepareSession } from "@/lib/call-packages";

const CHECKOUT = "cs_test_" + "p".repeat(24);
const TOKEN = "c".repeat(48);
async function packageWithLapsedHold(): Promise<void> {
  const bought = { s: "statsx", h: "shop", p: "prod01", e: "buyer@example.com", total: 3, at: 1, until: 0, token: TOKEN, holds: [{ session: "cs_test_" + "h".repeat(24), until: 1 }] };
  await real([
    ["SET", `nl:pkg:${CHECKOUT}`, JSON.stringify(bought)],
    ["SET", `nl:pkg:t:${createHash("sha256").update(TOKEN).digest("hex")}`, CHECKOUT],
  ]);
}

test("a package whose sessions left cannot be read: preparing a session says error, never a throw", async () => {
  await packageWithLapsedHold();
  odd = "1";
  const store = { statsId: "statsx", stripeAccountId: "acct_1TestPkgUnread", handle: "shop", language: "en" } as never;
  assert.deepEqual(await prepareSession(store, TOKEN, "https://marktmorgen.com"), { ok: false, reason: "error" });
});

test("holding a session against it says no, never a throw, so the time is let go", async () => {
  await packageWithLapsedHold();
  odd = "1";
  assert.equal(await holdSession({ statsId: "statsx" } as never, CHECKOUT, "cs_test_" + "n".repeat(24), 9_999_999_999), false);
});

test("the booking page reads a package it cannot count as unknown, never a server error", () => {
  const page = readFileSync("app/[handle]/book/[product]/page.tsx", "utf8");
  assert.match(page, /packageState\(pkg\.bought\)\.catch\(/);
});
