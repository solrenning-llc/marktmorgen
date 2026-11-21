/**
 * Rule 24 on the studio's main page (app/studio/page.tsx): a count of a plan's figure that cannot be read is
 * unknown, never "0 used". Two counts there still read an unread count as 0:
 *
 *   - "Your other figures this month" read each figure through `allowanceUsed`, which answers 0 for a lost or
 *     malformed reply (lib/store-allowance.ts says so: kept "only for the studio's main page ... still to be
 *     changed there"), so the creator read "0 of 5,000 store emails used" when the count was not read;
 *   - "Orders this month" read `ordersIn` (lib/orders.ts), which answers 0 when it cannot read, so the page said
 *     "0 orders counted" and never showed that new orders were paused.
 *
 * The decisions were already safe (takeAllowance and admitOrders refuse on an unread count); only the page was
 * wrong. Now the page reads the exact counts and says when one could not be read. Synthetic stores only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import * as admission from "@/lib/order-admission";
import * as rules from "@/lib/store-allowance-rules";

type Exact = (folder: string, window: string) => Promise<number | null>;
type Line = (used: number | null, limit: number, many: string) => string;
// Read through the module so that this file loads, and each test says what is missing, on code without them.
const ordersExact = (admission as unknown as { ordersCountedExact?: Exact }).ordersCountedExact;
const figureLine = (rules as unknown as { figureUsedLine?: Line }).figureUsedLine;

const FOLDER = "f".repeat(32);
const WINDOW = "2026-11-03";
const KEY = `nl:orders:n:${FOLDER}:${WINDOW}`;

/** Answers the one read of the window's order count with `reply` (or loses it); every other command passes through. */
function unreadOrders(reply: unknown[] | "lost"): () => void {
  const original = redis.pipeline;
  redis.pipeline = async (commands) => {
    const read = commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === KEY;
    if (!read) return original(commands);
    if (reply === "lost") throw new Error("synthetic lost reply");
    return [...reply];
  };
  return () => { redis.pipeline = original; };
}

beforeEach(() => redis.clear());

test("orders: the exact count is exported for the studio page", () => {
  assert.equal(typeof ordersExact, "function", "ordersCountedExact is exported by lib/order-admission.ts");
});

for (const [label, reply] of [
  ["a lost reply", "lost"],
  ["a missing reply", []],
  ["a word", ["many"]],
  ["a negative count", ["-1"]],
  ["a fraction", ["1.5"]],
  ["an empty string", [""]],
  ["hexadecimal zero", ["0x0"]],
  ["an exponent", ["0e4"]],
  ["an object", [{}]],
] as [string, unknown[] | "lost"][]) {
  test(`orders: ${label} is an unknown count, never 0`, async () => {
    assert.equal(typeof ordersExact, "function", "ordersCountedExact is exported by lib/order-admission.ts");
    await redis.pipeline([["SET", KEY, "7"]]);
    const restore = unreadOrders(reply);
    try {
      assert.equal(await ordersExact!(FOLDER, WINDOW), null);
    } finally {
      restore();
    }
  });
}

test("orders control: a count is read as it is, and a window with none is 0", async () => {
  assert.equal(typeof ordersExact, "function", "ordersCountedExact is exported by lib/order-admission.ts");
  assert.equal(await ordersExact!(FOLDER, WINDOW), 0);
  await redis.pipeline([["SET", KEY, "7"]]);
  assert.equal(await ordersExact!(FOLDER, WINDOW), 7);
});

test("figures: an unread count is said as unread, a read one as before", () => {
  assert.equal(typeof figureLine, "function", "figureUsedLine is exported by lib/store-allowance-rules.ts");
  assert.equal(figureLine!(120, 5_000, "store emails"), "120 of 5,000 store emails used");
  const unread = figureLine!(null, 5_000, "store emails");
  assert.match(unread, /could not be read/);
  assert.doesNotMatch(unread, /\b0 of\b/);
  assert.match(unread, /5,000 store emails/);
});

test("the studio page reads the exact counts and never shows an unread one as 0 or as room", () => {
  const page = readFileSync("app/studio/page.tsx", "utf8");
  assert.doesNotMatch(page, /\ballowanceUsed\(/, "the page reads allowanceUsedExact, never allowanceUsed");
  assert.match(page, /allowanceUsedExact\(current, kind\)/);
  assert.match(page, /figureUsedLine\(figure\.used, figure\.limit, KIND_WORDS\[figure\.kind\]\.many\)/);
  assert.doesNotMatch(page, /\bordersIn\(/, "the page reads ordersCountedExact, never ordersIn");
  assert.match(page, /ordersCountedExact\(folder, usageId\)/);
  // The paused notices only on a count that was read: an unread one is not 0, and not past the figure either.
  assert.match(page, /standing === "paid" && store && ordered !== null && ordered >= orderRoom/);
  assert.match(page, /standing === "trial" && ordered !== null && ordered >= TRIAL_ORDERS/);
});
