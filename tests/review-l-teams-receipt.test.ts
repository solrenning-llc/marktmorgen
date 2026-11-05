import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { keepTeamsAuthorization, takeTeamsAuthorization } from "@/lib/microsoft-teams-pending-state";
import { prepareTeamsAuthorization } from "@/lib/microsoft-teams-authorization-state";
import { store as redis } from "./redis-stub";

const binding = { storeId: "c".repeat(32), session: "synthetic-session-for-review-".repeat(3), actor: "l-teams-review@example.test" };
const pipeline = redis.pipeline.bind(redis);
afterEach(() => { redis.pipeline = pipeline; redis.clear(); });

for (const operation of ["SET", "GETDEL"] as const) test(`${operation} rejects symbol and hidden extra properties without executing them`, async () => {
  for (const kind of ["symbol", "hidden"] as const) {
    const prepared = prepareTeamsAuthorization(binding)!;
    let getters = 0, calls = 0;
    const reply = [operation === "SET" ? "OK" : prepared.sealed];
    Object.defineProperty(reply, kind === "symbol" ? Symbol("extra") : "extra", { get() { getters += 1; return null; } });
    redis.pipeline = async () => { calls += 1; return reply; };
    const result = operation === "SET" ? await keepTeamsAuthorization(binding, async () => true, async () => true)
      : await takeTeamsAuthorization(prepared.state, binding, async () => true);
    assert.equal(result, null); assert.equal(getters, 0); assert.equal(calls, 1);
  }
});

for (const operation of ["SET", "GETDEL"] as const) test(`${operation} does not treat array-like objects as receipts`, async () => {
  const prepared = prepareTeamsAuthorization(binding)!;
  for (const reply of [{ 0: operation === "SET" ? "OK" : prepared.sealed, length: 1 }, "OK", new Uint8Array([1])]) {
    let calls = 0;
    redis.pipeline = async () => { calls += 1; return reply as unknown as unknown[]; };
    const result = operation === "SET" ? await keepTeamsAuthorization(binding, async () => true, async () => true)
      : await takeTeamsAuthorization(prepared.state, binding, async () => true);
    assert.equal(result, null); assert.equal(calls, 1);
  }
});

test("frozen exact receipts preserve actual stored one-use state and the same command order", async () => {
  redis.clear();
  const commands: string[] = [];
  redis.pipeline = async work => { commands.push(String(work[0][0])); return Object.freeze(await pipeline(work)) as unknown as unknown[]; };
  const kept = await keepTeamsAuthorization(binding, async () => true, async () => true);
  assert.ok(kept);
  assert.ok(await takeTeamsAuthorization(kept.state, binding, async () => true));
  assert.equal(await takeTeamsAuthorization(kept.state, binding, async () => true), null);
  assert.deepEqual(commands, ["SET", "GETDEL", "GETDEL"]);
});

test("a failed transport does no retry or verifier permission work", async () => {
  const prepared = prepareTeamsAuthorization(binding)!;
  let calls = 0, permissions = 0;
  redis.pipeline = async () => { calls += 1; throw new Error("synthetic transport failure"); };
  assert.equal(await takeTeamsAuthorization(prepared.state, binding, async () => { permissions += 1; return true; }), null);
  assert.equal(calls, 1); assert.equal(permissions, 0);
});
