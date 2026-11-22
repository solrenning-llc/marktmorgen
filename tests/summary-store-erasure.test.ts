import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET as weekly } from "@/app/api/cron/weekly/route";
import { GET as monthly } from "@/app/api/cron/monthly/route";
import { sendPart, tryPeriodAgain, weekPeriod } from "@/lib/stats-report";
import type { Store } from "@/lib/store";
import { ERASING_KEY, erasingField, ownerKey, storeIdCommand, storeRef } from "@/lib/store";
import { control, ai, resetRetry, retry, summary } from "./summary-store-erasure-world";
import { store as redis } from "./redis-stub";

const original = redis.pipeline.bind(redis);
async function setup(variant = "primary") {
  redis.pipeline = original; redis.clear(); resetRetry(); ai.jobs = 0;
  control.folders = ["fixture-store"]; control.numbers = "visitors-5";
  summary.afterNumbers = undefined; summary.afterPost = undefined; summary.afterMail = undefined;
  summary.store.sid = variant === "legacy" ? "" : "a".repeat(32);
  summary.store.extra = variant === "extra";
  if (summary.store.sid) redis.run(["SET", storeIdCommand(summary.store.sid)[1], storeRef(summary.store)]);
  else redis.run(["SET", await ownerKey(summary.store.email), JSON.stringify(summary.store)]);
  retry.chat = "channel";
  redis.run(["SADD", "nl:weekly:to:fixture-store", "member@example.test"]);
}
async function erase(mode: string) {
  if (mode === "marked") redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(summary.store)), "fixture"]);
  else if (mode === "remapped") redis.run(["SET", storeIdCommand(summary.store.sid)[1], "other@example.test"]);
  else if (mode === "legacy-remapped") redis.run(["SET", await ownerKey(summary.store.email), JSON.stringify({ ...summary.store, statsId: "c".repeat(32) })]);
  else redis.run(["DEL", summary.store.sid ? storeIdCommand(summary.store.sid)[1] : await ownerKey(summary.store.email)]);
  // Complete the relevant summary-family walk, including claims previously admitted this period.
  for (const key of redis.keys()) if (/^nl:(weekly|monthly):sent:/.test(key)) redis.run(["DEL", key]);
}
function claims() { return redis.keys().filter(key => /^nl:(weekly|monthly):sent:/.test(key)); }
const request = (path: string) => new NextRequest(`https://example.test/api/cron/${path}`);
const routes = [["weekly", weekly], ["monthly", monthly]] as const;
for (const [kind, route] of routes) {
  for (const variant of ["primary", "extra", "legacy"]) {
    for (const mode of ["marked", "removed", variant === "legacy" ? "legacy-remapped" : "remapped"]) {
      test(`${kind}/${variant}/${mode}: erasure before period claim admits no work`, async () => {
        await setup(variant); let fired = false;
        redis.pipeline = async commands => {
          if (!fired && commands.some(c => (c[0] === "SET" || c[0] === "EVAL") && c.some(x => /^nl:(weekly|monthly):sent:[^:]+:fixture-store$/.test(String(x))))) { fired = true; await erase(mode); }
          return original(commands);
        };
        try {
          const response = await route(request(kind)); assert.equal(response.status, 200); assert.equal(fired, true);
          assert.equal(ai.jobs, 0); assert.deepEqual(retry.posts, []); assert.deepEqual(retry.mails, []); assert.deepEqual(claims(), []);
        } finally { redis.pipeline = original; }
      });
    }
  }
  test(`${kind}: erasure during numbers prevents AI, both parts and retry marks`, async () => {
    await setup(); summary.afterNumbers = () => erase("marked");
    assert.equal((await route(request(kind))).status, 200);
    assert.equal(ai.jobs, 0); assert.deepEqual(retry.posts, []); assert.deepEqual(retry.mails, []); assert.deepEqual(claims(), []);
  });
  test(`${kind}: an admitted post may finish, but erasure before email admits no owner/team mail`, async () => {
    await setup(); summary.afterPost = () => erase("removed");
    assert.equal((await route(request(kind))).status, 200);
    assert.equal(retry.posts.length, 1); assert.deepEqual(retry.mails, []); assert.deepEqual(claims(), []);
  });
  test(`${kind}: live control sends each part only once`, async () => {
    await setup();
    assert.equal((await route(request(kind))).status, 200); assert.equal((await route(request(kind))).status, 200);
    assert.equal(retry.posts.length, 1); assert.equal(retry.mails.filter(x => x === "owner@example.test").length, 1);
    assert.equal(ai.jobs, kind === "weekly" ? 1 : 0);
  });
}

test("the owner and team copies admitted as one batch may finish; the next pass sends nothing", async () => {
  await setup(); summary.afterMail = () => erase("removed");
  assert.equal((await weekly(request("weekly"))).status, 200);
  assert.deepEqual(retry.mails, ["owner@example.test", "member@example.test"]);
  assert.deepEqual(claims(), []);
  assert.equal((await weekly(request("weekly"))).status, 200);
  assert.equal(retry.mails.length, 2);
});
for (const [label, shape] of [["empty", []], ["boolean", [[true, "1"]]], ["extra", [[1, "1", 0]]], ["text code", [["1", "1"]]]] as const) {
  test(`unknown unapplied part receipt ${label}: no external send`, async () => {
    await setup();
    const period = { ...weekPeriod(summary.store.handle), store: summary.store as unknown as Store };
    const mark = `${period.key}:posted`; let sends = 0;
    redis.pipeline = async commands => commands.some(c => ((c[0] === "SET" && c.includes("NX")) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:summary-live:"))) && c.includes(mark)) ? shape as unknown as unknown[] : original(commands);
    try { assert.equal(await sendPart(period, "posted", async () => { sends++; return true; }), "missed"); assert.equal(sends, 0); }
    finally { redis.pipeline = original; }
  });
}
for (const applied of [true, false]) {
  test(`lost part response after ${applied ? "apply" : "no apply"}: recover only a unique committed claim`, async () => {
    await setup();
    const period = { ...weekPeriod(summary.store.handle), store: summary.store as unknown as Store };
    const mark = `${period.key}:emailed`; let sends = 0, calls = 0;
    redis.pipeline = async commands => {
      if (commands.some(c => ((c[0] === "SET" && c.includes("NX")) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:summary-live:"))) && c.includes(mark))) {
        calls++; if (applied) await original(commands); return [];
      }
      return original(commands);
    };
    try {
      assert.equal(await sendPart(period, "emailed", async () => { sends++; return true; }, { keyHoldsMs: 23 * 3600000 }), applied ? "sent" : "missed");
      assert.equal(sends, applied ? 1 : 0); assert.equal(calls, 1);
    } finally { redis.pipeline = original; }
  });
}
test("a late retry cannot recreate its count or release a period after erasure", async () => {
  await setup(); const period = { ...weekPeriod(summary.store.handle), store: summary.store as unknown as Store };
  redis.run(["SET", period.key, "earlier"]); let fired = false;
  redis.pipeline = async commands => {
    if (!fired && commands.some(c => c.includes(`${period.key}:tries`) && (c[0] === "INCR" || c[0] === "EVAL"))) { fired = true; await erase("marked"); }
    return original(commands);
  };
  try { assert.equal(await tryPeriodAgain(period), false); assert.equal(fired, true); assert.deepEqual(claims(), []); }
  finally { redis.pipeline = original; }
});
test("a getter in an untrusted inner receipt is not invoked", async () => {
  await setup(); const period = { ...weekPeriod(summary.store.handle), store: summary.store as unknown as Store };
  let reads = 0, sends = 0; const inner = [1, "1"];
  Object.defineProperty(inner, "0", { get() { reads++; return 1; } });
  redis.pipeline = async commands => commands.some(c => c[0] === "EVAL" && c.includes(`${period.key}:posted`)) ? [inner] : original(commands);
  try { assert.equal(await sendPart(period, "posted", async () => { sends++; return true; }), "missed"); assert.equal(reads, 0); assert.equal(sends, 0); }
  finally { redis.pipeline = original; }
});

test("an invalid negative retry count never releases the period or permits more tries", async () => {
  await setup(); const period = { ...weekPeriod(summary.store.handle), store: summary.store as unknown as Store };
  redis.run(["SET", period.key, "earlier"]); redis.run(["SET", `${period.key}:tries`, -2]);
  assert.equal(await tryPeriodAgain(period), false);
  assert.equal(redis.run(["GET", period.key]), "earlier");
});
for (const reply of [[[1, "1"]], [[1, 99]], [[1, -1]], [[0, "3"]]]) {
  test(`an unreadable or inconsistent retry receipt ${JSON.stringify(reply)} never permits another try`, async () => {
    await setup(); const period = { ...weekPeriod(summary.store.handle), store: summary.store as unknown as Store };
    redis.pipeline = async commands => commands.some(c => c[0] === "EVAL" && c[12] === "retry") ? reply : original(commands);
    try { assert.equal(await tryPeriodAgain(period), false); } finally { redis.pipeline = original; }
  });
}
