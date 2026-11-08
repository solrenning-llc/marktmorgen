/**
 * A product's note after paying is said as saved only when Redis confirms the
 * SET ("OK"), and as forgotten only when it confirms the DEL (a count of 0 or
 * 1); the store's data room gives back the note's space only after a
 * confirmed DEL (CX-123 rule 24; audit R24 round 8, item 8).
 *
 * Any other reply throws UnknownReplyError: the studio's route answers an
 * error, not `{ ok: true, note }`, the product is not marked as having a note
 * it may not have, and a note that may still be kept stays counted. Real code
 * over the memory Redis stub; only the targeted reply is replaced, and the
 * targeted command is then not run. Synthetic data only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readListing } from "@/lib/catalog";
import { dataUsed } from "@/lib/store-data";
import { UnknownReplyError } from "@/lib/redis-reply";
import { dropThanksNote, readThanksNote, writeThanksNote } from "@/lib/thanks-note-store";
import { POST as thanksRoute } from "@/app/api/store/thanks-note/route";
import { store as redis } from "./redis-stub";

type Cmd = (string | number)[];
type Mode = { slot: unknown } | "short" | "transport";
const original = redis.pipeline;

/** Runs every command but the targeted one, whose reply is replaced (or left out, or the request fails). */
async function tampered<T>(target: (c: Cmd) => boolean, mode: Mode, task: () => Promise<T>): Promise<{ out: T; hits: number }> {
  let hits = 0;
  redis.pipeline = async (commands: Cmd[]) => {
    if (!commands.some(target)) return original.call(redis, commands);
    hits += 1;
    if (mode === "transport") throw new Error("SYNTHETIC_NOTE_TRANSPORT");
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

const NOTE = { heading: "Start here", body: "A fictional welcome for a fictional buyer.", video: null, button: null };
const owner = "thanks-note-ack@example.test";
const fixture = (async () => {
  redis.clear();
  assert.equal((await claimHandle(owner, "thanksnoteack", "Fictional notes", "")).ok, true);
  await ensureStatsId(owner);
  const store = (await storeForEmail(owner))!;
  assert.ok(store.statsId);
  const session = await openSession(owner);
  const call = async (body: Record<string, unknown>) => {
    const r = await thanksRoute(new NextRequest("https://marktmorgen.com/api/store/thanks-note", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { store, statsId: store.statsId, call };
})();

let made = 0;
async function product(): Promise<string> {
  made += 1;
  const p = await addProduct(owner, `Fictional guide ${made}`, "", "12", null);
  assert.ok(p.ok);
  return p.product.id;
}
const used = async () => (await dataUsed((await fixture).store))!.used;
const marked = async (id: string) => (await readListing((await storeForEmail(owner))!, id))?.note === true;

const noteKey = async (id: string) => `nl:product:note:${(await fixture).statsId}:${id}`;
const isCmd = (verb: string, key: string) => (c: Cmd) => c[0] === verb && c[1] === key;
const UNKNOWN: [string, Mode][] = [
  ["no value", { slot: undefined }],
  ["a text", { slot: "x" }],
  ["true", { slot: true }],
  ["a list", { slot: ["OK"] }],
  ["no reply for it", "short"],
];
const SET_UNKNOWN: [string, Mode][] = [...UNKNOWN, ["null", { slot: null }], ["lowercase ok", { slot: "ok" }], ["a count", { slot: 1 }]];
const DEL_UNKNOWN: [string, Mode][] = [...UNKNOWN, ["null", { slot: null }], ["a count as text", { slot: "1" }], ["more than one key", { slot: 2 }], ["a negative count", { slot: -1 }]];

test("healthy: saved, marked and readable; taken off, forgotten and its space given back", async () => {
  const { statsId, call } = await fixture;
  const id = await product();
  const before = await used();
  const saved = await call({ id, note: NOTE });
  assert.deepEqual([saved.status, saved.body.ok], [200, true]);
  assert.equal(await marked(id), true);
  assert.equal((await readThanksNote(statsId, id))?.heading, NOTE.heading);
  assert.equal((await used()) > before, true);
  const off = await call({ id, note: null });
  assert.deepEqual([off.status, off.body.ok], [200, true]);
  assert.equal(await marked(id), false);
  assert.equal(await readThanksNote(statsId, id), null);
  assert.equal(await used(), before);
});

test("healthy drop of a gone product's note: forgotten and its space given back; none kept is still fine", async () => {
  const { store, statsId } = await fixture;
  const id = await product();
  const before = await used();
  await writeThanksNote(statsId, id, NOTE, store);
  assert.equal((await used()) > before, true);
  await dropThanksNote(statsId, id, store);
  assert.deepEqual([await readThanksNote(statsId, id), await used()], [null, before]);
  await dropThanksNote(statsId, id, store);
  assert.equal(await used(), before);
});

for (const [name, mode] of SET_UNKNOWN) {
  test(`SET answers ${name}: not said as saved, the product not marked`, async () => {
    const { store, statsId, call } = await fixture;
    const id = await product();
    const key = await noteKey(id);
    await assert.rejects(tampered(isCmd("SET", key), mode, () => writeThanksNote(statsId, id, NOTE, store)), UnknownReplyError);
    const { out: r, hits } = await tampered(isCmd("SET", key), mode, () => call({ id, note: NOTE }));
    assert.equal(hits, 1);
    assert.notEqual(r.body.ok, true);
    assert.equal(r.status, 500);
    assert.equal(await marked(id), false);
    assert.equal(await readThanksNote(statsId, id), null);
  });
}

for (const [name, mode] of DEL_UNKNOWN) {
  test(`DEL answers ${name} when the note is taken off: not said as done, its space kept`, async () => {
    const { store, statsId, call } = await fixture;
    const id = await product();
    assert.equal((await call({ id, note: NOTE })).body.ok, true);
    const kept = await used();
    const key = await noteKey(id);
    await assert.rejects(tampered(isCmd("DEL", key), mode, () => writeThanksNote(statsId, id, null, store)), UnknownReplyError);
    assert.equal(await used(), kept);
    const { out: r, hits } = await tampered(isCmd("DEL", key), mode, () => call({ id, note: null }));
    assert.equal(hits, 1);
    assert.notEqual(r.body.ok, true);
    assert.equal(r.status, 500);
    // The note is still kept, and still counted in the store's data room.
    assert.equal((await readThanksNote(statsId, id))?.heading, NOTE.heading);
    assert.equal(await used(), kept);
    // The next try, with Redis answering, forgets it and gives its space back.
    const again = await call({ id, note: null });
    assert.deepEqual([again.status, again.body.ok, await readThanksNote(statsId, id)], [200, true, null]);
    assert.equal((await used()) < kept, true);
  });

  test(`DEL answers ${name} when a gone product's note is dropped: throws, its space kept`, async () => {
    const { store, statsId } = await fixture;
    const id = await product();
    await writeThanksNote(statsId, id, NOTE, store);
    const kept = await used();
    const key = await noteKey(id);
    await assert.rejects(tampered(isCmd("DEL", key), mode, () => dropThanksNote(statsId, id, store)), UnknownReplyError);
    assert.equal(await used(), kept);
    assert.equal((await readThanksNote(statsId, id))?.heading, NOTE.heading);
  });
}

test("a request that fails on the DEL: its space kept", async () => {
  const { store, statsId } = await fixture;
  const id = await product();
  await writeThanksNote(statsId, id, NOTE, store);
  const kept = await used();
  await assert.rejects(tampered(isCmd("DEL", await noteKey(id)), "transport", () => dropThanksNote(statsId, id, store)));
  assert.equal(await used(), kept);
});
