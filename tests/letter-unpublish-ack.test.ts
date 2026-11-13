/**
 * Taking a published email off the store is said as done only when Redis
 * confirms its copy is deleted (CX-123 rule 24; audit R24 round 8, item 5).
 *
 * The copy is what the email's own address reads (/@store/letters/<id>), so a
 * DEL whose reply is not a count of 0 or 1 is not "taken off": unpublishLetter
 * throws UnknownReplyError, the studio's route answers an error, not ok, and
 * the email stays on the store's list, so the studio still offers to take it
 * off and the next try deletes it. The same for a ZREM that is not a count.
 * Real code over the memory Redis stub; only the targeted reply is replaced,
 * and the targeted command is then not run. Synthetic data only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import type { Broadcast } from "@/lib/broadcasts";
import { letterIdFor, publishLetter, publishedLetters, readLetter, unpublishLetter } from "@/lib/letters";
import { UnknownReplyError } from "@/lib/redis-reply";
import { POST as lettersRoute } from "@/app/api/store/letters/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Cmd = (string | number)[];
type Mode = { slot: unknown } | "short" | "transport";
const original = redis.pipeline;

/** Runs every command but the targeted one, whose reply is replaced (or left out, or the request fails). */
async function tampered<T>(target: (c: Cmd) => boolean, mode: Mode, task: () => Promise<T>): Promise<{ out: T; hits: number }> {
  let hits = 0;
  redis.pipeline = async (commands: Cmd[]) => {
    if (!commands.some(target)) return original.call(redis, commands);
    hits += 1;
    if (mode === "transport") throw new Error("SYNTHETIC_LETTER_TRANSPORT");
    const out: unknown[] = [];
    for (const c of commands) {
      if (!target(c)) out.push((await original.call(redis, [c]))[0]);
      else if (mode !== "short") out.push(mode.slot);
    }
    return out as Awaited<ReturnType<typeof original>>;
  };
  try {
    return { out: await task(), hits };
  } finally {
    redis.pipeline = original;
  }
}

function broadcast(store: Store, idSeed: string): Broadcast {
  const id = idSeed.padStart(24, "0");
  const b: Broadcast = {
    id, listId: store.listId!, handle: store.handle, subject: "Fictional notes", body: "A fictional email, sent to fictional people.",
    productId: null, notProductId: null, who: "all", narrow: null, status: "sent",
    createdAt: 1_760_000_000, sendAt: 1_760_000_100, finishedAt: 1_760_000_200,
    total: 3, sent: 3, note: "", failures: 0, listed: true, tagged: true, test: null,
  };
  redis.run(["SET", `nl:mail:bc:${id}`, JSON.stringify(b)]);
  return b;
}

const fixture = (async () => {
  redis.clear();
  const owner = "letter-unpublish-ack@example.test";
  await claimHandle(owner, "letterunpublishack", "Fictional letters", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_letterack", subscriptionId: "sub_letterack", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const session = await openSession(owner);
  const call = async (body: Record<string, unknown>) => {
    const r = await lettersRoute(new NextRequest("https://marktmorgen.com/api/store/letters", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { store, call };
})();

let seed = 0;
async function published() {
  const { store } = await fixture;
  seed += 1;
  const sent = broadcast(store, `a${seed.toString(16)}`);
  const done = await publishLetter(store, sent, Date.now());
  assert.ok(done.ok);
  return { sent, id: done.letter.id };
}

const isDel = (id: string) => (c: Cmd) => c[0] === "DEL" && c[1] === `nl:letters:i:${id}`;
const isZrem = (id: string) => (c: Cmd) => c[0] === "ZREM" && c[2] === id;
const UNKNOWN: [string, Mode][] = [
  ["a text", { slot: "x" }],
  ["a count as text", { slot: "1" }],
  ["a count in a list", { slot: [1] }],
  ["true", { slot: true }],
  ["no value", { slot: undefined }],
  ["null", { slot: null }],
  ["more than one key", { slot: 2 }],
  ["a fraction", { slot: 0.5 }],
  ["no reply for it", "short"],
];

test("healthy: taken off, its copy gone and off the list", async () => {
  const { store, call } = await fixture;
  const { sent, id } = await published();
  assert.equal(id, letterIdFor(store.sid, sent.id));
  const r = await call({ action: "unpublish", id: sent.id });
  assert.deepEqual([r.status, r.body.ok], [200, true]);
  assert.equal(await readLetter(store, id), null);
  assert.equal((await publishedLetters(store))?.has(id), false);
});

test("confirmed already off (DEL 0, ZREM 0): still ok, nothing to take off", async () => {
  const { store, call } = await fixture;
  const { sent, id } = await published();
  for (let i = 0; i < 2; i += 1) {
    const r = await call({ action: "unpublish", id: sent.id });
    assert.deepEqual([r.status, r.body.ok], [200, true]);
  }
  assert.equal(await readLetter(store, id), null);
});

for (const [name, mode] of UNKNOWN) {
  test(`DEL answers ${name}: not said as taken off, and the email stays on the list for the next try`, async () => {
    const { store, call } = await fixture;
    const { sent, id } = await published();
    await assert.rejects(tampered(isDel(id), mode, () => unpublishLetter(store, id)), UnknownReplyError);
    const { out: r, hits } = await tampered(isDel(id), mode, () => call({ action: "unpublish", id: sent.id }));
    assert.equal(hits, 1);
    assert.notEqual(r.body.ok, true);
    assert.equal(r.status >= 500, true);
    assert.equal(typeof r.body.message, "string");
    // Its copy was not deleted, and it is still readable at its address: the studio still lists it as published.
    assert.equal((await readLetter(store, id))?.id, id);
    assert.equal((await publishedLetters(store))?.has(id), true);
    // The next try, with Redis answering, takes it off.
    const again = await call({ action: "unpublish", id: sent.id });
    assert.deepEqual([again.status, again.body.ok, await readLetter(store, id)], [200, true, null]);
  });
}

for (const [name, mode] of UNKNOWN) {
  test(`ZREM answers ${name}: not said as taken off`, async () => {
    const { store, call } = await fixture;
    const { sent, id } = await published();
    const { out: r, hits } = await tampered(isZrem(id), mode, () => call({ action: "unpublish", id: sent.id }));
    assert.equal(hits, 1);
    assert.notEqual(r.body.ok, true);
    assert.equal(r.status >= 500, true);
    // Still on the list, so the studio offers to take it off again.
    assert.equal((await publishedLetters(store))?.has(id), true);
  });
}

test("a request that fails: not said as taken off", async () => {
  const { store, call } = await fixture;
  const { sent, id } = await published();
  const { out: r } = await tampered(isDel(id), "transport", () => call({ action: "unpublish", id: sent.id }));
  assert.notEqual(r.body.ok, true);
  assert.equal(r.status >= 500, true);
  assert.equal((await readLetter(store, id))?.id, id);
});
