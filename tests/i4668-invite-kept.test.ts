/**
 * Issue #4668 (erasure, HIGH): marking an imported member's invitation kept (lib/move-members.ts, noteKept, from the
 * thanks page and the reminder job) wrote the whole invitation back with HSET after the person's erasure had deleted
 * it: their plain email, the old link token and the membership, with no expiry. Transcribed from Claude 2's
 * reproduction on main @e4dbb5e9bf. The invitation is now marked kept only while it is still the one read.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addProduct, storeForEmail } from "@/lib/store";
import { inviteField, inviteMembers, noteKept, readInvite } from "@/lib/move-members";
import { erasePerson } from "@/lib/person-erasure";
import { store as redis } from "./redis-stub";
import { makeWorld } from "./erasure-world";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;
type Command = (string | number)[];

test("a pending noteKept after the invitation's erasure leaves the deleted row absent", async () => {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_d2_invite_stand_in";
  process.env.RESEND_API_KEY = "re_test_d2_invite_stand_in";
  const world = await makeWorld();
  const made = await addProduct(world.store.email, "Synthetic membership", "", "19", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("membership fixture was not created");
  const store = (await storeForEmail(world.store.email))!;
  const productId = made.product.id;
  const email = "pending-invite@example.test";
  const now = Date.now();
  await inviteMembers(store, "synthetic-import", [{ email, productId, option: "", renews: Math.floor(now / 1000) + 20 * 86_400 }], now);
  const field = inviteField(email, productId);
  assert.equal((await readInvite(store.statsId!, field))?.e, email);
  const original = redis.pipeline.bind(redis);
  let reached!: () => void;
  const inviteUpdateReached = new Promise<void>((r) => (reached = r));
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let paused = false;
  redis.pipeline = (async (commands: Command[]) => {
    const keeps = (c: Command | undefined) => (c?.[0] === "HSET" && c[1] === `nl:mv:${store.statsId}` && c[2] === field)
      || (c?.[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:invite-kept-if-same:") && c[3] === `nl:mv:${store.statsId}` && c[5] === field);
    if (!paused && keeps(commands[0])) {
      paused = true; reached(); await hold;
    }
    return original(commands);
  }) as typeof redis.pipeline;
  const pending = noteKept(store, email, productId, now);
  await inviteUpdateReached;
  try {
    assert.equal((await erasePerson(store, email, { kind: "person" })).ok, true);
    assert.equal(await readInvite(store.statsId!, field), null);
  } finally { release(); }
  await pending;
  redis.pipeline = original;
  assert.equal(await readInvite(store.statsId!, field), null, "the final read, after the pending update");
});

test("a current invitation is still marked kept", async () => {
  redis.clear();
  const world = await makeWorld();
  const made = await addProduct(world.store.email, "Synthetic membership", "", "19", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("membership fixture was not created");
  const store = (await storeForEmail(world.store.email))!;
  const email = "kept-invite@example.test";
  const now = Date.now();
  await inviteMembers(store, "synthetic-import", [{ email, productId: made.product.id, option: "", renews: Math.floor(now / 1000) + 20 * 86_400 }], now);
  await noteKept(store, email, made.product.id, now);
  assert.equal((await readInvite(store.statsId!, inviteField(email, made.product.id)))?.kept, Math.floor(now / 1000));
});
