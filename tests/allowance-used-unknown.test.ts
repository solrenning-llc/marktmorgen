/**
 * Rule 24 for the store's figures (lib/store-allowance.ts): a count of what was
 * taken in the window that cannot be read is unknown, never 0 used. Before,
 * `allowanceUsed` answered 0 for a lost or malformed reply, for a store whose
 * window is not known and with no Redis, so a caller deciding to call a model
 * or send an email read "room", and the studio said "0 of N used". The count
 * read for a decision or a screen is now `allowanceUsedExact`: null when it is
 * not known, 0 only for a count confirmed absent. Synthetic stores only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import * as allowance from "@/lib/store-allowance";
import * as rules from "@/lib/store-allowance-rules";
import type { AllowanceKind } from "@/lib/store-allowance-rules";

type Exact = (store: allowance.AllowanceStore, kind: AllowanceKind, now?: number) => Promise<number | null>;
type Line = (used: number | null, limit: number) => string;
// Read through the module so that this file loads, and each test says what is missing, on code without them.
const exact = (allowance as unknown as { allowanceUsedExact?: Exact }).allowanceUsedExact;
const emailsLine = (rules as unknown as { emailsUsedLine?: Line }).emailsUsedLine;

const store = {
  sid: "u".repeat(32), handle: "unreadcount", statsId: null, tier: "creator" as const,
  subscriptionActive: true, subscriptionId: "sub_Unread000001", trialEnds: 0, planEndedAt: "", cycle: "month" as const, period: paidPeriod(),
};

/** Answers the one-command read of a store's count with `reply` (or loses it), and passes every other command through. */
function unreadCounts(kind: AllowanceKind, reply: unknown[] | "lost"): () => void {
  const original = redis.pipeline;
  redis.pipeline = async (commands) => {
    const read = commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith(`nl:allow:${kind}:`);
    if (!read) return original(commands);
    if (reply === "lost") throw new Error("synthetic lost reply");
    return [...reply];
  };
  return () => { redis.pipeline = original; };
}

const MALFORMED: [string, unknown[] | "lost"][] = [
  ["a lost reply", "lost"],
  ["a missing reply", []],
  ["a word", ["many"]],
  ["a negative count", ["-1"]],
  ["a fraction", ["1.5"]],
  ["an object", [{}]],
  ["a list", [["3"]]],
  // Text INCRBY never writes (Codex Z on #3169): Number() reads each as a count, so each must be unknown here.
  ["an empty string", [""]],
  ["whitespace", [" "]],
  ["hexadecimal zero", ["0x0"]],
  ["a decimal zero", ["0.0"]],
  ["an exponent", ["0e4"]],
  ["a leading plus", ["+3"]],
  ["a leading zero", ["03"]],
  ["a fractional number", [2.5]],
];

beforeEach(() => redis.clear());

test("the exact count is read for decisions and screens", () => {
  assert.equal(typeof exact, "function", "allowanceUsedExact is exported by lib/store-allowance.ts");
});

for (const [label, reply] of MALFORMED) {
  test(`${label} is an unknown count, never 0 used`, async () => {
    assert.equal(typeof exact, "function", "allowanceUsedExact is exported by lib/store-allowance.ts");
    assert.ok((await allowance.takeAllowance(store, "email", 2)).ok);
    const restore = unreadCounts("email", reply);
    try {
      assert.equal(await exact!(store, "email"), null);
    } finally {
      restore();
    }
  });
}

test("control: the text INCRBY writes, and a whole number, are read as the count", async () => {
  assert.equal(typeof exact, "function", "allowanceUsedExact is exported by lib/store-allowance.ts");
  for (const [reply, count] of [["0", 0], ["25", 25], [25, 25], [null, 0]] as const) {
    const restore = unreadCounts("email", [reply]);
    try {
      assert.equal(await exact!(store, "email"), count, `${JSON.stringify(reply)} reads as ${count}`);
    } finally {
      restore();
    }
  }
});

test("a paying store whose billing month is not known has an unknown count, not 0 used", async () => {
  assert.equal(typeof exact, "function", "allowanceUsedExact is exported by lib/store-allowance.ts");
  assert.equal(await exact!({ ...store, period: undefined }, "email"), null);
});

test("control: a count read whole is the count, and a count never taken is a confirmed 0", async () => {
  assert.equal(typeof exact, "function", "allowanceUsedExact is exported by lib/store-allowance.ts");
  assert.ok((await allowance.takeAllowance(store, "email", 3)).ok);
  assert.equal(await exact!(store, "email"), 3);
  assert.equal(await exact!(store, "studio"), 0);
  assert.equal(await allowance.allowanceUsed(store, "email"), 3);
});

test("the studio's email line says an unread count is unknown, and never says 0 used", () => {
  assert.equal(typeof emailsLine, "function", "emailsUsedLine is exported by lib/store-allowance-rules.ts");
  assert.equal(emailsLine!(5, 75), "5 of 75 used.");
  assert.equal(emailsLine!(0, 75), "0 of 75 used.");
  const unknown = emailsLine!(null, 75);
  assert.match(unknown, /could not be read just now/);
  assert.match(unknown, /75/);
  assert.doesNotMatch(unknown, /\b0 of\b/);
});
