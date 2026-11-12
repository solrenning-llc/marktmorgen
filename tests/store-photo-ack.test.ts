/**
 * The creator's page photo is said as saved only when Redis confirms the SET
 * ("OK"), and as removed only when it confirms the DEL (a count of 0 or 1)
 * (CX-123 rule 24; audit R24 round 8, item 9).
 *
 * /api/photo/<id> reads only the photo's own record, so a DEL that is not
 * confirmed is not "removed": deletePhoto throws UnknownReplyError and the
 * route answers an error, not ok. A photo taken off is deleted before the
 * page stops pointing at it, so after a failed try the studio still shows it
 * and the next try deletes it. A SET that is not confirmed never points the
 * page at a photo that may not be there. Real code over the memory Redis stub;
 * only the targeted reply is replaced, and the targeted command is then not
 * run. Synthetic data only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { claimHandle, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { UnknownReplyError } from "@/lib/redis-reply";
import { deletePhoto, readPhoto, writePhoto } from "@/lib/store-photo";
import { POST as photoRoute } from "@/app/api/store/photo/route";
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
    if (mode === "transport") throw new Error("SYNTHETIC_PHOTO_TRANSPORT");
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

/** A PNG's signature and a few synthetic bytes: what decodePhoto accepts. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const PNG64 = Buffer.from(PNG).toString("base64");
const owner = "store-photo-ack@example.test";
const fixture = (async () => {
  redis.clear();
  assert.equal((await claimHandle(owner, "storephotoack", "Fictional photo", "")).ok, true);
  const session = await openSession(owner);
  const call = async (body: Record<string, unknown>) => {
    const r = await photoRoute(new NextRequest("https://marktmorgen.com/api/store/photo", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { call };
})();
const pointsAt = async () => (await storeForEmail(owner))?.photoId ?? null;
const photoKeyOf = (id: string) => `nl:store:photo:${id}`;
const isSet = (c: Cmd) => c[0] === "SET" && String(c[1]).startsWith("nl:store:photo:");
const isDelOf = (id: string | null) => (c: Cmd) => c[0] === "DEL" && id !== null && c[1] === photoKeyOf(id);

const UNKNOWN: [string, Mode][] = [
  ["no value", { slot: undefined }],
  ["a text", { slot: "x" }],
  ["true", { slot: true }],
  ["null", { slot: null }],
  ["a list", { slot: [1] }],
  ["no reply for it", "short"],
];
const SET_UNKNOWN: [string, Mode][] = [...UNKNOWN, ["lowercase ok", { slot: "ok" }], ["a count", { slot: 1 }]];
const DEL_UNKNOWN: [string, Mode][] = [...UNKNOWN, ["a count as text", { slot: "1" }], ["more than one key", { slot: 2 }], ["a negative count", { slot: -1 }]];

/** Puts a photo on the page through the route, healthy, and returns its id. */
async function photoOn(): Promise<string> {
  const r = await (await fixture).call({ photo: PNG64 });
  assert.deepEqual([r.status, r.body.ok], [200, true]);
  assert.equal(typeof r.body.photoId, "string");
  return r.body.photoId as string;
}
/** Takes the page's photo off through the route, healthy. */
async function photoOff(): Promise<void> {
  const r = await (await fixture).call({ remove: true });
  assert.deepEqual([r.status, r.body.ok, await pointsAt()], [200, true, null]);
}

test("healthy: saved and served; replaced, the old one deleted; removed, deleted; removing nothing is fine", async () => {
  const first = await photoOn();
  assert.equal(await pointsAt(), first);
  assert.equal((await readPhoto(first))?.type, "image/png");
  const second = await photoOn();
  assert.deepEqual([await pointsAt(), await readPhoto(first)], [second, null]);
  await photoOff();
  assert.equal(await readPhoto(second), null);
  await photoOff();
  await deletePhoto(second);
});

for (const [name, mode] of SET_UNKNOWN) {
  test(`SET answers ${name}: not said as saved, the page not pointed at it`, async () => {
    await assert.rejects(tampered(isSet, mode, () => writePhoto(PNG, "image/png")), UnknownReplyError);
    const before = await pointsAt();
    const { out: r, hits } = await tampered(isSet, mode, () => (async () => (await fixture).call({ photo: PNG64 }))());
    assert.equal(hits, 1);
    assert.notEqual(r.body.ok, true);
    assert.equal(r.status, 500);
    assert.equal(await pointsAt(), before);
  });
}

for (const [name, mode] of DEL_UNKNOWN) {
  test(`DEL answers ${name} when the photo is removed: not said as removed, and the next try deletes it`, async () => {
    const id = await photoOn();
    await assert.rejects(tampered(isDelOf(id), mode, () => deletePhoto(id)), UnknownReplyError);
    const { out: r, hits } = await tampered(isDelOf(id), mode, () => (async () => (await fixture).call({ remove: true }))());
    assert.equal(hits, 1);
    assert.notEqual(r.body.ok, true);
    assert.equal(r.status, 500);
    // Still served, and the page still shows it, so the studio still offers to remove it.
    assert.equal((await readPhoto(id))?.type, "image/png");
    assert.equal(await pointsAt(), id);
    await photoOff();
    assert.equal(await readPhoto(id), null);
  });

  test(`DEL answers ${name} for the old photo when it is replaced: not said as done`, async () => {
    const old = await photoOn();
    const { out: r, hits } = await tampered(isDelOf(old), mode, () => (async () => (await fixture).call({ photo: PNG64 }))());
    assert.equal(hits, 1);
    assert.notEqual(r.body.ok, true);
    assert.equal(r.status, 500);
    await photoOff();
  });
}

test("a request that fails on the DEL: not said as removed", async () => {
  const id = await photoOn();
  const { out: r } = await tampered(isDelOf(id), "transport", () => (async () => (await fixture).call({ remove: true }))());
  assert.notEqual(r.body.ok, true);
  assert.equal(r.status, 500);
  assert.equal((await readPhoto(id))?.type, "image/png");
  await photoOff();
});
