import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { keepTeamsAuthorization, takeTeamsAuthorization } from "@/lib/microsoft-teams-pending-state";
import { prepareTeamsAuthorization } from "@/lib/microsoft-teams-authorization-state";
import { store as redis } from "./redis-stub";

const binding = { storeId: "a".repeat(32), session: "synthetic-teams-session-".repeat(3), actor: "owner@example.test" };
const pipeline = redis.pipeline.bind(redis);
beforeEach(() => { redis.clear(); });
afterEach(() => { redis.pipeline = pipeline; });

const decorated = (value: unknown) => Object.assign([value], { unconfirmed: true });
const inherited = (value: unknown) => Object.setPrototypeOf(Array(1), Object.create(Array.prototype, { 0: { value } }));
const vectors: [string, (value: unknown) => unknown][] = [
  ["missing", () => []], ["undefined", () => [undefined]], ["false", () => [false]],
  ["extra null", value => [value, null]], ["extra duplicate", value => [value, value]],
  ["decorated", decorated], ["inherited", inherited],
];

for (const [name, reply] of vectors) test(`SET ${name} never offers unconfirmed authorization state`, async () => {
  let reserved = 0, writes = 0;
  redis.pipeline = async commands => { assert.equal(commands[0][0], "SET"); writes += 1; return reply("OK") as unknown[]; };
  const result = await keepTeamsAuthorization(binding, async () => true, async () => { reserved += 1; return true; });
  assert.equal(result, null);
  assert.equal(reserved, 1, "the existing funding callback still precedes the write");
  assert.equal(writes, 1, "an uncertain write is not replayed");
});

for (const [name, reply] of vectors) test(`GETDEL ${name} never opens an unconfirmed consumed state`, async () => {
  const prepared = prepareTeamsAuthorization(binding)!; assert.ok(prepared);
  let reads = 0, permissions = 0;
  redis.pipeline = async commands => { assert.equal(commands[0][0], "GETDEL"); reads += 1; return reply(prepared.sealed) as unknown[]; };
  const result = await takeTeamsAuthorization(prepared.state, binding, async () => { permissions += 1; return true; });
  assert.equal(result, null);
  assert.equal(reads, 1);
  assert.equal(permissions, 0, "do not proceed to permission or verifier handling on an unknown receipt");
});

for (const operation of ["SET", "GETDEL"] as const) test(`${operation}: receipt getters are never executed`, async () => {
  const prepared = prepareTeamsAuthorization(binding)!; let getters = 0;
  const receipt = Object.defineProperty(Array(1), "0", { enumerable: true, get() { getters += 1; return operation === "SET" ? "OK" : prepared.sealed; } });
  redis.pipeline = async () => receipt;
  const result = operation === "SET" ? await keepTeamsAuthorization(binding, async () => true, async () => true)
    : await takeTeamsAuthorization(prepared.state, binding, async () => true);
  assert.equal(result, null); assert.equal(getters, 0);
});

test("confirmed SET and atomic GETDEL retain the existing one-use behavior", async () => {
  let reserved = 0, permissions = 0;
  const permit = async () => { permissions += 1; return true; };
  const kept = await keepTeamsAuthorization(binding, permit, async () => { reserved += 1; return true; });
  assert.ok(kept);
  const opened = await takeTeamsAuthorization(kept.state, binding, permit);
  assert.ok(opened); assert.equal(opened.nonce, kept.nonce);
  assert.equal(await takeTeamsAuthorization(kept.state, binding, permit), null);
  assert.equal(reserved, 1); assert.equal(permissions, 2);
});

test("funding refusal performs no Redis operation", async () => {
  let calls = 0; redis.pipeline = async () => { calls += 1; return []; };
  assert.equal(await keepTeamsAuthorization(binding, async () => true, async () => false), null);
  assert.equal(calls, 0);
});
