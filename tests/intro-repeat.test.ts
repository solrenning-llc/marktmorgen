/**
 * An introductory price paid again by somebody who had the same membership before (owner's decision 15, 9 November
 * 2026): accepted for now, never refused and never looked up before Stripe, and counted. The five-minute checkout sweep
 * (lib/checkout-sweep.ts) hands each paid checkout of a membership at its introductory price to noteIntroRepeats once
 * (a mark per checkout), which asks the creator's own Stripe account for the address's completed checkouts and counts
 * the sale in the store's month: "repeat" when one of them is an earlier membership of the same product, "first" when
 * none is, "unknown" when that could not be read whole (never taken for "first"). The count is aggregate, by store and
 * month: no address, no checkout id, no customer. The studio's memberships page shows the month's repeats.
 * Synthetic Redis (tests/redis-stub.ts) and a synthetic Stripe answer only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as intro from "@/lib/intro-repeat";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

type Row = Record<string, unknown>;
type Ask = (method: string, account: string, path: string) => Promise<Row>;
const api = intro as unknown as Record<string, unknown>;
const noteIntroRepeats = api.noteIntroRepeats as (store: Store, paid: Row[], deadline: number, ask?: Ask) => Promise<number>;
const introRepeatMonth = api.introRepeatMonth as (statsId: string, month: string) => Promise<{ repeat: number; first: number; unknown: number } | null>;

const STATS = "0123456789abcdef0123456789abcdef";
const STORE = { handle: "introclub", previousHandles: [], releasedHandles: [], statsId: STATS, stripeAccountId: "acct_IntroSynthetic01" } as unknown as Store;
const BUYER = "returning@example.test";
const NOW = Date.UTC(2026, 10, 9, 12) / 1000;
const MONTH = "2026-11";
const countKey = `nl:intro:rep:${STATS}:${MONTH}`;

function session(id: string, over: Row = {}, meta: Record<string, string> = {}): Row {
  return {
    id,
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    created: NOW,
    customer_details: { email: BUYER },
    metadata: { store: "introclub", product: "club", intro: "1", intro_cents: "500", regular_cents: "2000", ...meta },
    ...over,
  };
}

/** A Stripe that answers the address's completed checkouts with `rows`, and records what was asked. */
function stripe(rows: Row[], more = false): { ask: Ask; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: async (method, account, path) => {
      asked.push(`${method} ${account} ${path}`);
      return { object: "list", data: rows, has_more: more };
    },
  };
}

function reset(): void {
  redis.clear();
}

test("a returning member who pays the introductory price again is counted as a repeat, once", async () => {
  reset();
  const now = session("cs_test_IntroNow0001");
  const before = session("cs_test_IntroBefore01", { created: NOW - 200 * 86_400 });
  const { ask, asked } = stripe([now, before]);
  assert.equal(typeof noteIntroRepeats, "function", "noteIntroRepeats is exported");
  assert.equal(await noteIntroRepeats(STORE, [now], Date.now() + 10_000, ask), 1);
  assert.deepEqual(await introRepeatMonth(STATS, MONTH), { repeat: 1, first: 0, unknown: 0 });
  assert.ok(asked.length >= 1 && asked.every((line) => line.startsWith("GET acct_IntroSynthetic01 /checkout/sessions?")), asked.join("\n"));
  assert.ok(asked.every((line) => line.includes("status=complete")), "only completed checkouts are read");
  // The next pass meets the same checkout: nothing is read or counted again.
  const again = stripe([now, before]);
  assert.equal(await noteIntroRepeats(STORE, [now], Date.now() + 10_000, again.ask), 0);
  assert.equal(again.asked.length, 0, "no Stripe read for a checkout already looked at");
  assert.deepEqual(await introRepeatMonth(STATS, MONTH), { repeat: 1, first: 0, unknown: 0 });
});

test("a first membership is counted as first; another product or another store's checkout is not a repeat", async () => {
  reset();
  const now = session("cs_test_IntroNow0002");
  const other = session("cs_test_OtherProd001", { created: NOW - 50 * 86_400 }, { product: "other" });
  const elsewhere = session("cs_test_OtherStore01", { created: NOW - 50 * 86_400 }, { store: "someoneelse" });
  const oneTime = session("cs_test_OneTime00001", { created: NOW - 50 * 86_400, mode: "payment" });
  const unpaid = session("cs_test_Unpaid000001", { created: NOW - 50 * 86_400, payment_status: "unpaid" });
  await noteIntroRepeats(STORE, [now], Date.now() + 10_000, stripe([now, other, elsewhere, oneTime, unpaid]).ask);
  assert.deepEqual(await introRepeatMonth(STATS, MONTH), { repeat: 0, first: 1, unknown: 0 });
});

test("unknown is never taken for a first: a list cut short, a read that fails, or no address", async () => {
  reset();
  await noteIntroRepeats(STORE, [session("cs_test_IntroMore001")], Date.now() + 10_000, stripe([session("cs_test_IntroMore001")], true).ask);
  const failing: Ask = async () => {
    throw new Error("Stripe is down (synthetic)");
  };
  await noteIntroRepeats(STORE, [session("cs_test_IntroFail001")], Date.now() + 10_000, failing);
  await noteIntroRepeats(STORE, [session("cs_test_IntroShape01")], Date.now() + 10_000, async () => ({ data: "not a list" }));
  await noteIntroRepeats(STORE, [session("cs_test_IntroNoMail1", { customer_details: null })], Date.now() + 10_000, stripe([]).ask);
  assert.deepEqual(await introRepeatMonth(STATS, MONTH), { repeat: 0, first: 0, unknown: 4 });
});

test("only a paid membership at its introductory price is looked at", async () => {
  reset();
  const { ask, asked } = stripe([]);
  const rows = [
    session("cs_test_NoIntro00001", {}, { intro: "" }),
    session("cs_test_Payment00001", { mode: "payment" }),
    session("cs_test_Unpaid000002", { payment_status: "unpaid" }),
    session("cs_test_Foreign00001", {}, { store: "someoneelse" }),
  ];
  assert.equal(await noteIntroRepeats(STORE, rows, Date.now() + 10_000, ask), 0);
  assert.equal(asked.length, 0);
  assert.deepEqual(await introRepeatMonth(STATS, MONTH), { repeat: 0, first: 0, unknown: 0 });
});

test("the count holds no address, no checkout and no customer, and runs out by itself", async () => {
  reset();
  const now = session("cs_test_IntroNow0003");
  await noteIntroRepeats(STORE, [now], Date.now() + 10_000, stripe([now, session("cs_test_IntroBefore02", { created: NOW - 9 * 86_400 })]).ask);
  const dump = JSON.stringify(redis.run(["HGETALL", countKey]));
  assert.doesNotMatch(dump, /returning@|cs_test_|cus_/);
  const ttl = redis.run(["TTL", countKey]) as number;
  assert.ok(ttl > 0 && ttl <= 62 * 86_400, `kept a bounded time (${ttl} s)`);
});

test("a pass checks at most INTRO_REPEAT_CHECKS_PER_PASS sales, and stops at its deadline", async () => {
  reset();
  const cap = api.INTRO_REPEAT_CHECKS_PER_PASS as number;
  assert.equal(typeof cap, "number");
  const rows = Array.from({ length: cap + 5 }, (_, i) => session(`cs_test_IntroCap${String(i).padStart(4, "0")}`));
  const { ask, asked } = stripe([]);
  assert.equal(await noteIntroRepeats(STORE, rows, Date.now() + 10_000, ask), cap);
  assert.ok(asked.length <= cap * (api.INTRO_REPEAT_READS_PER_SALE as number));
  const late = stripe([]);
  assert.equal(await noteIntroRepeats(STORE, [session("cs_test_IntroLate001")], Date.now() - 1, late.ask), 0);
  assert.equal(late.asked.length, 0);
});

test("the sweep hands paid checkouts to it, and the memberships page shows the month", () => {
  const sweep = readFileSync("lib/checkout-sweep.ts", "utf8");
  assert.match(sweep, /noteIntroRepeats\(store, paid, deadline\)/);
  const page = readFileSync("app/studio/memberships/page.tsx", "utf8");
  assert.match(page, /introRepeatMonth\(store\.statsId/);
  assert.match(page, /data-intro-repeat/);
  const words = api.introRepeatWords as (month: { repeat: number; first: number; unknown: number }) => string;
  assert.equal(typeof words, "function");
  assert.match(words({ repeat: 2, first: 5, unknown: 0 }), /2 people who had .* before paid its introductory price again/);
  assert.match(words({ repeat: 1, first: 0, unknown: 1 }), /1 person .*1 more/);
});
