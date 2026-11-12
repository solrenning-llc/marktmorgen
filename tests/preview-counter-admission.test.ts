import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/store/preview/route";
import { reset, state } from "./preview-counter-admission-world";

const ask = () => GET(new NextRequest("https://example.com/api/store/preview?handle=test-preview&product=p1234", { headers: { "x-forwarded-for": "198.51.100.3" } }));
const downstream = () => [state.lookups, state.publicCalls, state.listings, state.copies, state.serves];
let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}`, error); }
}
async function refused() {
  const response = await ask();
  assert.equal(response.status, 429);
  assert.equal(await response.text(), "Too many at once. Try again in a minute.");
  assert.deepEqual(downstream(), [0, 0, 0, 0, 0]);
  assert.equal(state.commands.length, 2, "one counter attempt; no retry or readback");
}
async function main() {
  const sparse = new Array(2); sparse[1] = 1;
  for (const [name, reply] of [["missing", undefined], ["empty", []], ["partial", sparse], ["extra", ["OK", 1, "extra"]], ["text", ["OK", "1"]], ["null", ["OK", null]], ["zero", ["OK", 0]], ["negative", ["OK", -1]], ["fractional", ["OK", 0.5]], ["unknown SET", [false, 1]]] as [string, unknown][]) {
    await check(`preview refuses ${name} counter before lookup and file work`, async () => { reset(); state.override = true; state.reply = reply; await refused(); });
  }
  await check("counter timeout refuses before lookup and file work", async () => { reset(); state.throws = true; await refused(); });
  await check("confirmed counters preserve thirty previews per minute and the download path", async () => {
    reset();
    for (let i = 0; i < 30; i += 1) { const response = await ask(); assert.equal(response.status, 200); assert.equal(await response.text(), "Synthetic preview bytes"); }
    assert.equal((await ask()).status, 429);
    assert.deepEqual(downstream(), [30, 30, 30, 30, 30]);
    assert.equal(state.commands.length, 62);
    assert.match(String(state.commands[0][1]), /^nl:rl:preview:[0-9a-f]{32}$/);
    assert.deepEqual(state.commands[0].slice(2), ["0", "EX", 60, "NX"]);
  });
  await check("public quota refusal still stops listing and file work", async () => {
    reset(); state.publicAllowed = false; const response = await ask(); assert.equal(response.status, 429);
    assert.deepEqual(downstream(), [1, 1, 0, 0, 0]);
  });
  await check("a confirmed missing store remains a 404", async () => {
    reset(); state.storeFound = false; assert.equal((await ask()).status, 404);
    assert.deepEqual(downstream(), [1, 0, 0, 0, 0]);
  });
  for (const authorized of [true, false]) {
    await check(`preview settings authorization ${authorized} keeps its own path`, async () => {
      reset(); state.authorized = authorized; state.throws = true;
      const response = await POST(new NextRequest("https://example.com/api/store/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "p1234", pages: 3 }) }));
      assert.equal(response.status, authorized ? 200 : 403);
      assert.equal(state.settings, authorized ? 1 : 0);
      assert.equal(state.commands.length, 0);
      assert.deepEqual(downstream(), [0, 0, 0, 0, 0]);
    });
  }
  console.log(`${passed} passed; ${failed} failed`); process.exitCode = failed ? 1 : 0;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
