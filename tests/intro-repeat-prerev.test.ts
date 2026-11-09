/**
 * Pre-review of claude5/intro-repeat-count @ 099b23b129 (9 November 2026), kept as its regression test, from the
 * reviewer's proofs (scratchpad prerev-intro-repeat-proof.test.ts, P1 to P4):
 *   P1  the per-pass cap counts only sales not yet looked at: the ones already marked never take its places;
 *   P2  the mark and the count are one step after the read (INTRO_REPEAT_COUNT_IF): a count that fails leaves the sale
 *       for the next pass, never lost;
 *   P3  a sale already counted costs at most one command a pass for the whole page (one MGET of the marks), never one
 *       a sale (the reviewer's proof asked for none; one read of the marks is what knowing they were counted takes);
 *   P4  a Stripe read is never waited on past the sweep's deadline; the sale waits for the next pass;
 *   P5  the sweep runs it after the order confirmations;
 *   P6  the words: by email address, no "0 people" when only unknowns, the month in UTC, and a month that could not be
 *       read is said so.
 * Synthetic Redis (tests/redis-stub.ts) and synthetic Stripe answers only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as intro from "@/lib/intro-repeat";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

type Row = Record<string, unknown>;
type Command = (string | number)[];
type Ask = (method: "GET", account: string, path: string) => Promise<Record<string, unknown>>;
const api = intro as unknown as Record<string, unknown>;
const noteIntroRepeats = api.noteIntroRepeats as (store: Store, paid: Row[], deadline: number, ask?: Ask) => Promise<number>;
const introRepeatMonth = api.introRepeatMonth as (statsId: string, month: string) => Promise<{ repeat: number; first: number; unknown: number } | null>;
const words = api.introRepeatWords as (month: { repeat: number; first: number; unknown: number } | null) => string;
const CAP = api.INTRO_REPEAT_CHECKS_PER_PASS as number;

const STATS = "0123456789abcdef0123456789abcdef";
const STORE = { handle: "introclub", previousHandles: [], releasedHandles: [], statsId: STATS, stripeAccountId: "acct_IntroSynthetic01" } as unknown as Store;
const NOW = Date.UTC(2026, 10, 9, 12) / 1000;
const session = (id: string, over: Row = {}): Row => ({ id, mode: "subscription", status: "complete", payment_status: "paid", created: NOW, customer_details: { email: "a@example.test" }, metadata: { store: "introclub", product: "club", intro: "1" }, ...over });
const empty: Ask = async () => ({ object: "list", data: [], has_more: false });
const real = redis.pipeline.bind(redis);
const total = (m: { repeat: number; first: number; unknown: number } | null) => (m ? m.repeat + m.first + m.unknown : -1);
const quiet = async <T>(work: () => Promise<T>): Promise<T> => {
  const log = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = log;
    redis.pipeline = real;
  }
};

test("P1: the sales past the cap are counted on the next pass", async () => {
  redis.clear();
  const rows = Array.from({ length: CAP + 5 }, (_, i) => session(`cs_test_Cap${String(i).padStart(4, "0")}`));
  assert.equal(await noteIntroRepeats(STORE, rows, Date.now() + 10_000, empty), CAP);
  assert.equal(await noteIntroRepeats(STORE, rows, Date.now() + 10_000, empty), 5);
  assert.equal(total(await introRepeatMonth(STATS, "2026-11")), CAP + 5);
});

test("P2: a count that fails is not lost: the next pass counts the sale, once", async () => {
  redis.clear();
  redis.pipeline = (async (batch: Command[]) => {
    if (batch.some((c) => c[0] === "HINCRBY" || (c[0] === "EVAL" && String(c[1]).includes("intro-repeat-count")))) throw new Error("Upstash timeout (synthetic)");
    return real(batch);
  }) as typeof redis.pipeline;
  await quiet(() => noteIntroRepeats(STORE, [session("cs_test_Lost00001")], Date.now() + 10_000, empty));
  await noteIntroRepeats(STORE, [session("cs_test_Lost00001")], Date.now() + 10_000, empty);
  await noteIntroRepeats(STORE, [session("cs_test_Lost00001")], Date.now() + 10_000, empty);
  assert.equal(total(await introRepeatMonth(STATS, "2026-11")), 1);
});

test("P3: a sale already counted costs one command a pass for the whole page, and no Stripe read", async () => {
  redis.clear();
  const rows = [session("cs_test_Cost00001"), session("cs_test_Cost00002"), session("cs_test_Cost00003")];
  await noteIntroRepeats(STORE, rows, Date.now() + 10_000, empty);
  let commands = 0;
  let reads = 0;
  redis.pipeline = (async (batch: Command[]) => {
    commands += batch.length;
    return real(batch);
  }) as typeof redis.pipeline;
  try {
    for (let pass = 0; pass < 288; pass += 1) {
      await noteIntroRepeats(STORE, rows, Date.now() + 10_000, async () => {
        reads += 1;
        return { data: [], has_more: false };
      });
    }
  } finally {
    redis.pipeline = real;
  }
  assert.equal(commands, 288, "one MGET of the page's marks a pass");
  assert.equal(reads, 0);
});

test("P4: a slow Stripe read is never waited on past the deadline, and the sale waits for the next pass", async () => {
  redis.clear();
  const slow: Ask = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return { object: "list", data: [], has_more: false };
  };
  const rows = [session("cs_test_Slow00001", { customer_details: { email: " Mixed@Example.test" } })];
  const deadline = Date.now() + 1000;
  assert.equal(await quiet(() => noteIntroRepeats(STORE, rows, deadline, slow)), 0);
  const over = Date.now() - deadline;
  assert.ok(over < 200, `ran ${over} ms past the deadline`);
  assert.equal(total(await introRepeatMonth(STATS, "2026-11")), 0, "nothing counted on a read not waited for");
  assert.equal(await noteIntroRepeats(STORE, rows, Date.now() + 10_000, empty), 1, "counted on the next pass");
});

test("P5: the sweep looks at them after the order confirmations", () => {
  const sweep = readFileSync("lib/checkout-sweep.ts", "utf8");
  const at = sweep.indexOf("noteIntroRepeats(store, paid, deadline)");
  const confirmations = sweep.indexOf("const outcome = await confirmPurchase(store, paid[i].id as string, paid[i]);");
  assert.ok(at > 0 && confirmations > 0 && at > confirmations, `${at} after ${confirmations}`);
});

test("P6: the words say what was counted, and nothing more", () => {
  assert.match(words({ repeat: 2, first: 5, unknown: 0 }), /2 sales .*same email address.* this month \(UTC\)/);
  const onlyUnknown = words({ repeat: 0, first: 3, unknown: 1 });
  assert.doesNotMatch(onlyUnknown, /\b0 (people|sales|person)/);
  assert.match(onlyUnknown, /1 sale/);
  assert.equal(words({ repeat: 0, first: 4, unknown: 0 }), "");
  assert.match(words(null), /could not be read/);
  const page = readFileSync("app/studio/memberships/page.tsx", "utf8");
  assert.match(page, /introAgain === null \|\| introRepeatWords\(introAgain\)/);
  const data = readFileSync("lib/person-data.ts", "utf8");
  assert.match(data, /file: "lib\/intro-repeat\.ts", how: "expires", days: 2/);
});
