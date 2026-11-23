/**
 * Codex L-20261121-0144 (#5010 row 65, MEDIUM, erasure and personal data): who on the team gets the weekly email was
 * kept with a plain DEL and SADD under nl:weekly:to:<handle>, after the route had read the store and its team. A store
 * whose erasure began in between got its team's addresses written back after the closing walk deleted them; and one
 * whose handle another store took after it wrote them over that store's own list. The list is now replaced only while
 * the store is live, in one fenced step (lib/stats-report.ts WEEKLY_TEAM_SET_IF_LIVE). Synthetic stores and addresses.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/weekly-team/route";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { setWeeklyTeam, weeklyTeam } from "@/lib/stats-report";
import { ERASING_KEY, claimHandle, ensureStoreId, erasingField, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";

const OWNER = "weekly-erasure@example.test";
const HANDLE = "weeklyerasure";
const MEMBER = "weekly-member@example.test";
const listKey = `nl:weekly:to:${HANDLE}`;
type Batch = (string | number)[][];

async function liveStore() {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Weekly erasure", "");
  const store = (await ensureStoreId(OWNER))!;
  // A team member who sees the numbers, so the route accepts the address.
  redis.run(["SET", `nl:team:${store.sid}`, JSON.stringify({ members: [{ email: MEMBER, role: "admin", joinedAt: "2026-11-01" }], invites: [] })]);
  return store;
}

/** What the store's erasure leaves when it began: its erasing mark, and the weekly list deleted. */
async function eraseBegins(store: Awaited<ReturnType<typeof liveStore>>) {
  redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]);
  redis.run(["DEL", listKey]);
}

test("a live store keeps who gets the weekly email (control)", async () => {
  const store = await liveStore();
  assert.equal(await setWeeklyTeam(store, [MEMBER]), "kept");
  assert.deepEqual(await weeklyTeam(HANDLE), [MEMBER]);
  assert.equal(await setWeeklyTeam(store, []), "kept");
  assert.deepEqual(await weeklyTeam(HANDLE), [], "nobody chosen is kept as nobody");
});

test("a store whose erasure has begun writes no addresses back", async () => {
  const store = await liveStore();
  await eraseBegins(store);
  assert.equal(await setWeeklyTeam(store, [MEMBER]), "gone");
  assert.equal(redis.run(["EXISTS", listKey]), 0, "no list under the erased store's handle");
});

test("a store whose handle another store now holds leaves that store's list alone", async () => {
  const store = await liveStore();
  // The id key no longer holds this store's ref: its account moved (moveAccount), as when another store took over.
  redis.run(["SET", storeIdCommand(store.sid)[1], "another-store-ref"]);
  redis.run(["SADD", listKey, "someone-else@example.test"]);
  assert.equal(await setWeeklyTeam(store, [MEMBER]), "gone");
  assert.deepEqual(await weeklyTeam(HANDLE), ["someone-else@example.test"], "the other store's list is untouched");
});

test("the route: an erasure that begins while it reads the team keeps no addresses and is never said saved", async () => {
  const store = await liveStore();
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const plain = redis.pipeline;
  redis.pipeline = (async (batch: Batch) => {
    const replies = await plain(batch);
    // The team is read last before the write: the erasure begins right after it answers.
    if (batch.length === 1 && batch[0]?.[0] === "GET" && batch[0][1] === `nl:team:${store.sid}`) await eraseBegins(store);
    return replies;
  }) as typeof redis.pipeline;
  try {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/weekly-team", {
      method: "POST",
      headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json", cookie },
      body: JSON.stringify({ emails: [MEMBER] }),
    }));
    const body = (await response.json()) as { ok?: boolean };
    assert.equal(body.ok, false, "not said saved");
    assert.equal(response.status, 410);
  } finally {
    redis.pipeline = plain;
  }
  assert.equal(redis.run(["EXISTS", listKey]), 0, "no list written back after the erasure began");
});

test("the route, counted as Upstash bills it, stays inside the studio unit it takes first", async () => {
  // Claude 1 coord's rules 964c and e931: the whole route against the unit it takes before the write, every command the
  // store runs counted (a script's inner calls included), and the take shown to come before the fenced write.
  const { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS, UNIT_COST, request } = await import("./plan-cost-registry");
  const studio = 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
  assert.equal(request("studio", studio, 50_000), UNIT_COST.studio, "the commands UNIT_COST.studio prices");
  const store = await liveStore();
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const before = await allowanceUsed(store, "studio");
  let atWrite: number | null = null;
  let billed = 0;
  const plainRun = redis.run.bind(redis);
  const plainPipeline = redis.pipeline;
  (redis as { run: typeof plainRun }).run = (command) => { billed += 1; return plainRun(command); };
  redis.pipeline = (async (batch: Batch) => {
    if (batch[0]?.[0] === "EVAL" && String(batch[0][1]).startsWith("-- marktmorgen:weekly-team-live:v1")) {
      const held = billed;
      atWrite = await allowanceUsed((await storeForEmail(OWNER))!, "studio");
      billed = held;
    }
    return plainPipeline(batch);
  }) as typeof redis.pipeline;
  try {
    billed = 0;
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/weekly-team", {
      method: "POST",
      headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json", cookie },
      body: JSON.stringify({ emails: [MEMBER] }),
    }));
    assert.equal(response.status, 200);
  } finally {
    (redis as { run: typeof plainRun }).run = plainRun;
    redis.pipeline = plainPipeline;
  }
  assert.equal(atWrite, before + 1, "the studio unit is taken before the list is written");
  assert.ok(billed <= studio, `the route bills ${billed} commands, over the ${studio} of its studio unit`);
});
