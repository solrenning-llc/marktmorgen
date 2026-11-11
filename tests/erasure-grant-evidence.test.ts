import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isValidElement, type ReactNode } from "react";
import DeletePage from "@/app/privacy/delete/page";
import { confirmErasure } from "@/lib/erasure-request";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { leadsKey, upsertContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : "";
}
async function setup() {
  redis.clear();
  const original = redis.pipeline.bind(redis);
  const owner = "grant-owner@example.test", email = "grant-person@example.test", token = "e".repeat(64);
  await claimHandle(owner, "grantproof", "Grant Proof", "");
  await ensureStoreId(owner); await ensureStatsId(owner); await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_grant_proof", subscriptionId: "sub_grant_proof", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  await upsertContact(store.listId!, email, { agreed: true, explicit: true, source: "free" }, ROOM);
  const key = "nl:erase:link:" + createHash("sha256").update("nimbus-erase-link:" + token).digest("hex").slice(0, 40);
  const grant = JSON.stringify({ e: email, s: [store.sid] });
  await original([["SET", key, grant, "EX", 3600]]);
  return { original, owner, email, token, store, key, grant };
}

test("an incomplete grant-read envelope does not relabel a retained live link expired", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("No external request allowed"); };
  const r = await setup();
  try {
    const before = text(await DeletePage({ searchParams: Promise.resolve({ token: r.token }) }));
    assert.match(before, /Delete grant-person@example.test/);
    redis.pipeline = async commands => commands.some(c => c[0] === "GET" && c[1] === r.key) ? [] : r.original(commands);
    const unavailable = text(await DeletePage({ searchParams: Promise.resolve({ token: r.token }) }));
    assert.equal(redis.run(["GET", r.key]), r.grant);
    console.log("D2 incomplete grant preview", { expired: unavailable.includes("That link has run out"), retained: true });
    assert.doesNotMatch(unavailable, /That link has run out or was already used/);
  } finally { redis.pipeline = r.original; globalThis.fetch = originalFetch; }
});

test("a malformed scope from a grant read cannot become done/zero while its contact remains", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("No external request allowed"); };
  const r = await setup();
  try {
    redis.pipeline = async commands => {
      const result = await r.original(commands);
      if (commands[0]?.[0] === "GET" && commands[0]?.[1] === r.key) result[0] = JSON.stringify({ e: r.email, s: [null] });
      return result;
    };
    const result = await confirmErasure(r.token);
    const observation = { state: result.state, grantRetained: redis.run(["GET", r.key]) === r.grant, contactRemains: typeof redis.run(["HGET", leadsKey(r.store.listId!), r.email]) === "string" };
    console.log("D2 malformed grant observation", observation);
    redis.pipeline = r.original;
    await r.original([["SET", r.key, r.grant, "EX", 3600]]);
    const recovered = await confirmErasure(r.token);
    assert.equal(recovered.state, "done", "ordinary original grant still finishes after recovery");
    assert.equal(redis.run(["HGET", leadsKey(r.store.listId!), r.email]), null);
    assert.notEqual(observation.state, "done", "unknown scope must never certify completion");
    assert.equal(observation.grantRetained, true);
    assert.equal(observation.contactRemains, true);
  } finally { redis.pipeline = r.original; globalThis.fetch = originalFetch; }
});
