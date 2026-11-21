import test from "node:test";
import assert from "node:assert/strict";
import { logTeam, LOG_LINE_BYTES } from "@/lib/team";
import { claimHandle, storeForEmail, storeIdCommand, storeRef, ERASING_KEY, erasingField } from "@/lib/store";
import { store as redis } from "./redis-stub";

type Mode = "gone" | "erasing" | "gone-after-read" | "erasing-after-read" | "remapped" | "unknown-read" | "unknown-write" | "other-erasing" | null;
async function world(erase: Mode) {
  redis.clear();
  const owner = "activity-owner@example.test";
  assert.equal((await claimHandle(owner, "activity-erasure", "Synthetic shop", "")).ok, true);
  const shop = (await storeForEmail(owner))!;
  const key = `nl:team:log:${shop.sid}`;
  if (erase === "gone") await redis.pipeline([["DEL", storeIdCommand(shop.sid)[1]], ["DEL", key]]);
  if (erase === "erasing") await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(shop)), "1"], ["DEL", key]]);
  if (erase === "other-erasing") await redis.pipeline([["HSET", ERASING_KEY, await erasingField("other@example.test"), "1"]]);
  const base = redis.pipeline.bind(redis);
  let billed = 0;
  let logged: unknown;
  let raced = false;
  const race = async () => {
    if (raced) return;
    if (erase === "gone-after-read") await base([["DEL", storeIdCommand(shop.sid)[1]], ["DEL", key]]);
    else if (erase === "erasing-after-read") await base([["HSET", ERASING_KEY, await erasingField(storeRef(shop)), "1"], ["DEL", key]]);
    else if (erase === "remapped") await base([["SET", storeIdCommand(shop.sid)[1], "other@example.test"]]);
    else return;
    raced = true;
  };
  try {
    redis.pipeline = async commands => {
      const identityRead = commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === storeIdCommand(shop.sid)[1];
      if (identityRead && erase === "unknown-read") { billed += 1; return []; }
      // The old writer has no identity read: stop it just before its plain LPUSH instead, so its RED also sees the
      // actual gone/erasing/remapped state before it writes, rather than merely missing this fixture's read hook.
      if (commands[0][0] === "LPUSH" && commands[0][1] === key) await race();
      const before = redis.scriptCalls;
      const reply = await base(commands);
      billed += commands.length + redis.scriptCalls - before;
      if (identityRead) await race();
      if (commands[0][0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:team-log-live:v1\n") && erase === "unknown-write") return [null];
      return reply;
    };
    logged = await logTeam(shop.sid, { who: "teammate@example.test", role: "editor", what: "Settings: connected a calendar" });
  } finally { redis.pipeline = base; }
  const [rows] = await base([["LRANGE", key, 0, -1]]);
  return { rows, logged, billed, shop, raced };
}

for (const erase of ["gone", "erasing"] as const) {
  test(`a delayed activity line never restores a teammate's address (${erase})`, async () => {
    assert.deepEqual((await world(erase)).rows, []);
  });
}
test("a live store still keeps the actual activity line", async () => {
  const { rows, billed, logged } = await world(null);
  assert.ok(Array.isArray(rows) && rows.length === 1);
  assert.equal(JSON.parse(String(rows[0])).who, "teammate@example.test");
  assert.equal(logged, true);
  assert.equal(billed, 6);
});

for (const [mode, cost] of [["gone-after-read", 3], ["erasing-after-read", 4], ["remapped", 3], ["unknown-read", 1]] as const) {
  test(`the identity read never licenses a later personal write (${mode})`, async () => {
    const out = await world(mode);
    assert.deepEqual(out.rows, []);
    assert.equal(out.logged, false);
    assert.equal(out.billed, cost);
    if (mode !== "unknown-read") assert.equal(out.raced, true);
  });
}
test("an unknown write acknowledgement never confirms the line", async () => {
  const out = await world("unknown-write");
  assert.equal(out.logged, false);
});
test("another store's erasing field does not suppress this store's line", async () => {
  const out = await world("other-erasing");
  assert.equal(out.logged, true);
  assert.equal((out.rows as unknown[]).length, 1);
});
test("the fenced log retains access details and its actual stored byte ceiling", async () => {
  const { shop } = await world(null);
  const access = { email: "member@example.test", one: false, changes: [] };
  await logTeam(shop.sid, { who: "actor@example.test", role: "owner", what: "Updated pipeline access", access });
  const key = `nl:team:log:${shop.sid}`;
  const [first] = await redis.pipeline([["LINDEX", key, 0]]);
  assert.deepEqual(JSON.parse(String(first)).access, access);
  await logTeam(shop.sid, { who: "a".repeat(500)+"@example.test", role: "owner", what: "界".repeat(200), access });
  const [long] = await redis.pipeline([["LINDEX", key, 0]]);
  assert.ok(Buffer.byteLength(String(long), "utf8") <= LOG_LINE_BYTES);
});
