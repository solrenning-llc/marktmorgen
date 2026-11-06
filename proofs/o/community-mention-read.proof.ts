import assert from "node:assert/strict";
import { whoIs } from "@/lib/community-mentions";
import { store } from "../../tests/redis-stub";

const original = store.pipeline.bind(store);
const member = "a".repeat(32);
let failures = 0;
let checks = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  checks += 1;
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unknown"}`); }
}
async function read(reply: unknown): Promise<Map<string, string>> {
  store.pipeline = (async () => reply) as typeof store.pipeline;
  try { return await whoIs("c".repeat(32), ["alice", "bob"]); }
  finally { store.pipeline = original; }
}
async function main(): Promise<void> {
await check("complete membership and explicit absence", async () => {
  assert.deepEqual([...await read([[member, null]])], [["alice", member]]);
});
await check("confirmed empty lookup", async () => {
  assert.equal((await read([[null, null]])).size, 0);
});
await check("creator-only lookup spends no Redis read", async () => {
  store.pipeline = (async () => { throw new Error("unexpected Redis read"); }) as typeof store.pipeline;
  try { assert.equal((await whoIs("c".repeat(32), ["creator"])).get("creator"), "creator"); }
  finally { store.pipeline = original; }
});
for (const [name, reply] of [
  ["missing pipeline result", []],
  ["short HMGET result", [[member]]],
  ["extra pipeline result", [[member, null], 0]],
  ["non-list HMGET result", [null]],
  ["malformed member identity", [["not-a-member", null]]],
] as const) {
  await check(name, async () => { await assert.rejects(() => read(reply)); });
}
console.log(`${checks} checks, ${failures} failures, ${checks - failures} passing controls`);
process.exitCode = failures ? 1 : 0;
}
void main();
