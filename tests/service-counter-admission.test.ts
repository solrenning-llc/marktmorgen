import assert from "node:assert/strict";
import type { Store } from "@/lib/store";
import { withinService, withinServiceWhy, withinStore } from "@/lib/metered-limits";
import { reset, state } from "./service-counter-admission-world";

const store = { sid: "c".repeat(32), handle: "test-supplier" } as Store;
let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}`, error); }
}
/** The actual gate authorizes this supplier spy. No provider is contacted. */
async function attempt() {
  if (await withinService("host-calendar", store.sid!, 2, 60, store)) state.supplierCalls += 1;
}

async function main() {
  const sparse = new Array(2); sparse[0] = 1;
  const unknowns: [string, unknown][] = [
    ["missing reply", undefined], ["null reply", null], ["empty pipeline", []],
    ["missing increment", [1]], ["missing SET acknowledgment", sparse],
    ["extra reply", [1, 1, "extra"]], ["text increment", ["1", 1]],
    ["null increment", [null, 1]], ["zero increment", [0, 1]],
    ["negative increment", [-1, 1]], ["fractional increment", [0.5, 1]],
    ["unsafe increment", [Number.MAX_SAFE_INTEGER + 1, 1]],
    ["nonfinite increment", [Number.NaN, 1]], ["false EXPIRE", [1, false]],
    ["unknown EXPIRE", [undefined, 1]], ["noncanonical SET", ["queued", 1]],
  ];
  for (const [name, reply] of unknowns) {
    await check(`${name}: no monthly quota or supplier call`, async () => {
      reset(); state.override = true; state.reply = reply;
      await attempt();
      assert.equal(state.supplierCalls, 0);
      assert.equal(state.quotaCalls, 0);
      assert.equal(state.commands.length, 2, "one SET+INCR attempt, no retry");
    });
  }
  await check("counter timeout never reaches the monthly quota or supplier", async () => {
    reset(); state.throws = true; await attempt();
    assert.deepEqual([state.supplierCalls, state.quotaCalls, state.commands.length], [0, 0, 2]);
  });
  await check("Redis not configured does no work", async () => {
    reset(); state.configured = false; await attempt();
    assert.deepEqual([state.supplierCalls, state.quotaCalls, state.commands.length], [0, 0, 0]);
  });
  await check("exact confirmed increment uses the existing key, TTL and bound", async () => {
    reset(); await attempt(); await attempt(); await attempt();
    assert.deepEqual([state.supplierCalls, state.quotaCalls, state.commands.length], [2, 2, 6]);
    assert.equal(state.commands[0][0], "INCR");
    assert.match(String(state.commands[0][1]), /^nl:rl:host-calendar:[0-9a-f]{32}$/);
    assert.deepEqual([state.commands[0][0], ...state.commands[1]], ["INCR", "EXPIRE", state.commands[0][1], 60, "NX"]);
    assert.deepEqual(state.commands[1], ["EXPIRE", state.commands[0][1], 60, "NX"]);
  });
  for (const reason of ["used", "pool", "unknown"] as const) {
    await check(`confirmed short window preserves monthly ${reason}`, async () => {
      reset(); state.quota = { ok: false, reason, limit: 1, message: `Known ${reason}` };
      assert.deepEqual(await withinServiceWhy("host-calendar", store.sid!, 2, 60, store), { reason, message: `Known ${reason}` });
      assert.deepEqual([state.quotaCalls, state.supplierCalls, state.commands.length], [1, 0, 2]);
    });
  }
  await check("confirmed public request keeps its existing path", async () => {
    reset(); assert.equal(await withinStore("search", store.sid!, 2, 60, store), true);
    assert.deepEqual([state.publicCalls, state.quotaCalls, state.commands.length], [1, 0, 2]);
  });
  console.log(`${passed} passed; ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
