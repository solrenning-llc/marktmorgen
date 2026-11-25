/**
 * The real manual ad-spend add, through app/api/store/spend/route.ts, still fits one studio request after its write
 * became the fenced ad-spend-live:v1 script (row 100 of #5010; Claude 1 coord's rule 964c: every fence measured on its
 * whole route, at its worst, against its scope's envelope). The worst add here: the store already keeps
 * MAX_SPEND_ENTRIES lines, so the add also prunes the oldest, then reads the lines back. The take and lockedUntil are
 * padded to their worst, as tests/outreach-sender-erasure-fence.test.ts does, and each fenced EVAL is counted with its
 * inner calls (SPEND_WRITE_COMMANDS), which the in-memory script does not count by itself. Synthetic store only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/spend/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { SPEND_WRITE_COMMANDS, addSpend } from "@/lib/ad-spend";
import { MAX_SPEND_ENTRIES } from "@/lib/ad-spend-rules";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS, UNIT_COST, request } from "./plan-cost-registry";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const today = new Date().toISOString().slice(0, 10);
const LINE = { channel: "instagram", campaign: "spring", cents: 1200, from: today, to: today };

async function fixture() {
  redis.clear();
  const owner = "spend-envelope@example.test";
  await claimHandle(owner, "spend-envelope", "Synthetic store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_spendenvelope", subscriptionId: "sub_spendenvelope", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  // A full list, so the add prunes the oldest line too.
  for (let n = 0; n < MAX_SPEND_ENTRIES; n++) assert.ok((await addSpend(store.statsId!, LINE, Date.now(), store)).ok);
  return store;
}

for (const [what, op] of [["with the studio's operation id", "b".repeat(32)], ["from an older page", undefined]] as const) {
  test(`the real spend add ${what}, on a full list, fits one studio request`, async () => {
    const store = await fixture();
    const cookie = `${SESSION_COOKIE}=${await openSession(store.email)}`;
    const original = redis.pipeline;
    const commands: (string | number)[][] = [];
    const before = redis.scriptCalls;
    let bytes = 0;
    redis.pipeline = async (batch) => {
      commands.push(...batch);
      const replies = await original.call(redis, batch);
      bytes += JSON.stringify(batch).length + JSON.stringify(replies).length;
      return replies;
    };
    try {
      const response = await POST(new NextRequest("https://marktmorgen.com/api/store/spend", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ action: "add", ...LINE, ...(op ? { op } : {}) }),
      }));
      assert.equal(response.status, 200, await response.clone().text());
      const fenced = commands.filter((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:ad-spend-live:")).length;
      assert.equal(fenced, 1, "the add wrote through the fenced script once");
      assert.ok(commands.some((c) => c[0] === "HDEL"), "the add pruned the oldest line");
      const measured = commands.length + (redis.scriptCalls - before) + fenced * (SPEND_WRITE_COMMANDS - 1) + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
      console.log("AD_SPEND_ADD_ROUTE", JSON.stringify({ what, external: commands.length, scriptCalls: redis.scriptCalls - before, fencedInner: fenced * (SPEND_WRITE_COMMANDS - 1), takeWorst: TAKE_COMMANDS, lockedUntilWorst: LOCKED_UNTIL_STAR_COMMANDS, measured, bytes }));
      // Every command and every byte sent and read (the full list read twice, before and after), at the studio unit.
      assert.ok(request("studio", measured, Math.max(bytes, 50_000)) <= UNIT_COST.studio, `${measured} commands and ${bytes} bytes fit one studio request`);
    } finally {
      redis.pipeline = original;
    }
  });
}
