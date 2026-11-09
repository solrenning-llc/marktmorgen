/**
 * Two follow-ups of Claude 2's review of #3304 (CX-123 rule 24).
 *
 * LOW 1, the page photo: a remove whose DEL Redis confirmed but whose pointer was not cleared (setPhotoId failed, a
 * busy store lock) left every page pointing at a deleted photo. The studio's read now checks the pointed photo with an
 * EXISTS: a confirmed 0 shows no photo and clears the pointer, only while it still names that photo; any other reply
 * throws UnknownReplyError and the pointer is kept (an unknown reply is never "no photo"). readPhoto reads its GET the
 * same way: null is "no photo", a kept "type;base64" is the photo, anything else throws.
 *
 * LOW 2, a product's note after paying: rewriting a note smaller gave its room back before Redis confirmed the SET,
 * so an unknown reply left the old, larger note kept but counted as the smaller one. Now the room of the larger of the
 * two is taken first and the slot set to the new size only after an exact "OK"; the counted slot is read exactly too.
 *
 * Real code over the memory Redis stub; only the targeted reply is replaced, and the targeted command is then not
 * run. Synthetic data only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NextRequest } from "next/server";
import * as storeLib from "@/lib/store";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { UnknownReplyError } from "@/lib/redis-reply";
import { dataUsed } from "@/lib/store-data";
import { deletePhoto, readPhoto } from "@/lib/store-photo";
import { readThanksNote, writeThanksNote } from "@/lib/thanks-note-store";
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
    if (mode === "transport") throw new Error("SYNTHETIC_FOLLOWUP_TRANSPORT");
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

/** Counts the commands sent with this verb while `task` runs. */
async function counted<T>(verb: string, task: () => Promise<T>): Promise<{ out: T; sent: number }> {
  let sent = 0;
  redis.pipeline = async (commands: Cmd[]) => {
    sent += commands.filter((c) => c[0] === verb).length;
    return original.call(redis, commands);
  };
  try {
    return { out: await task(), sent };
  } finally {
    redis.pipeline = original;
  }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const PNG64 = Buffer.from(PNG).toString("base64");
const photoOwner = "photo-followup@example.test";
const noteOwner = "note-followup@example.test";
const fixture = (async () => {
  redis.clear();
  assert.equal((await claimHandle(photoOwner, "photofollowup", "Fictional photo", "")).ok, true);
  assert.equal((await claimHandle(noteOwner, "notefollowup", "Fictional notes", "")).ok, true);
  await ensureStatsId(noteOwner);
  const noteStore = (await storeForEmail(noteOwner))!;
  assert.ok(noteStore.statsId);
  const session = await openSession(photoOwner);
  const call = async (body: Record<string, unknown>) => {
    const r = await photoRoute(new NextRequest("https://marktmorgen.com/api/store/photo", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { call, noteStore, statsId: noteStore.statsId };
})();

// ---- LOW 1: the page photo -------------------------------------------------------------------------------------

type Shown = (email: string, photoId: string | null) => Promise<string | null>;
/** lib/store.ts's shownPhotoId, read through the module so this file still runs (and fails) where it is missing. */
const shownPhotoId: Shown = (email, photoId) => {
  const fn = (storeLib as Record<string, unknown>).shownPhotoId;
  if (typeof fn !== "function") throw new Error("shownPhotoId is missing from lib/store.ts");
  return (fn as Shown)(email, photoId);
};
const pointsAt = async () => (await storeForEmail(photoOwner))?.photoId ?? null;
const photoKeyOf = (id: string) => `nl:store:photo:${id}`;
const isOn = (verb: string, id: string) => (c: Cmd) => c[0] === verb && c[1] === photoKeyOf(id);

async function photoOn(): Promise<string> {
  const r = await (await fixture).call({ photo: PNG64 });
  assert.deepEqual([r.status, r.body.ok], [200, true]);
  return r.body.photoId as string;
}
async function photoOff(): Promise<void> {
  const r = await (await fixture).call({ remove: true });
  assert.deepEqual([r.status, r.body.ok, await pointsAt()], [200, true, null]);
}
/** The state LOW 1 found: the photo's DEL confirmed, the page still pointing at it. */
async function dangling(): Promise<string> {
  const id = await photoOn();
  await deletePhoto(id);
  assert.deepEqual([await pointsAt(), await readPhoto(id)], [id, null]);
  return id;
}

const EXISTS_UNKNOWN: [string, Mode][] = [
  ["no value", { slot: undefined }],
  ["null", { slot: null }],
  ["a count as text", { slot: "0" }],
  ["true", { slot: true }],
  ["a list", { slot: [0] }],
  ["more than one key", { slot: 2 }],
  ["a negative count", { slot: -1 }],
  ["a fraction", { slot: 0.5 }],
  ["no reply for it", "short"],
];

test("healthy: a kept photo is shown as it is, and the store is not written", async () => {
  const id = await photoOn();
  const { out, sent } = await counted("EXISTS", () => shownPhotoId(photoOwner, id));
  assert.deepEqual([out, sent, await pointsAt()], [id, 1, id]);
  assert.equal(await shownPhotoId(photoOwner, null), null);
  await photoOff();
});

test("a pointer to a photo Redis confirms gone (EXISTS 0): shown as no photo and cleared", async () => {
  const id = await dangling();
  assert.equal(await shownPhotoId(photoOwner, id), null);
  assert.equal(await pointsAt(), null);
  // And the studio can put a new one on as usual.
  const next = await photoOn();
  assert.equal(await shownPhotoId(photoOwner, next), next);
  await photoOff();
});

test("the photo changed since the store was read: a newer photo the store points at is never cleared", async () => {
  const gone = await dangling();
  const newer = await photoOn();
  assert.equal(await shownPhotoId(photoOwner, gone), null);
  assert.equal(await pointsAt(), newer);
  await photoOff();
});

for (const [name, mode] of EXISTS_UNKNOWN) {
  test(`EXISTS answers ${name}: unknown, never "no photo"; the pointer kept`, async () => {
    const id = await dangling();
    const { hits } = await tampered(isOn("EXISTS", id), mode, () => assert.rejects(shownPhotoId(photoOwner, id), UnknownReplyError));
    assert.equal(hits, 1);
    assert.equal(await pointsAt(), id);
    await photoOff();
  });
}

test("a request that fails on the EXISTS: thrown, the pointer kept", async () => {
  const id = await dangling();
  await tampered(isOn("EXISTS", id), "transport", () => assert.rejects(shownPhotoId(photoOwner, id)));
  assert.equal(await pointsAt(), id);
  await photoOff();
});

test("the studio's home shows the photo through shownPhotoId, and keeps the pointer on an unknown reply", () => {
  const page = readFileSync(join(process.cwd(), "app/studio/page.tsx"), "utf8");
  assert.match(page, /photoId=\{await shownPhotoId\(ref, store\.photoId\)\.catch\(\(\) => store\.photoId\)\}/);
});

const GET_UNKNOWN: [string, Mode][] = [
  ["no value", { slot: undefined }],
  ["a number", { slot: 5 }],
  ["true", { slot: true }],
  ["a list", { slot: ["image/png;AAAA"] }],
  ["a text with no type", { slot: "x" }],
  ["a type that is not kept", { slot: "image/gif;R0lGOD" }],
  ["no reply for it", "short"],
];

test("readPhoto: null is no photo, a kept photo is read as before", async () => {
  const id = await photoOn();
  assert.equal((await readPhoto(id))?.type, "image/png");
  await photoOff();
  assert.equal(await readPhoto(id), null);
  assert.equal(await readPhoto("not an id"), null);
});

for (const [name, mode] of GET_UNKNOWN) {
  test(`readPhoto's GET answers ${name}: unknown, never "no photo"`, async () => {
    const id = await photoOn();
    const { hits } = await tampered(isOn("GET", id), mode, () => assert.rejects(readPhoto(id), UnknownReplyError));
    assert.equal(hits, 1);
    await photoOff();
  });
}

// ---- LOW 2: a note after paying rewritten smaller ---------------------------------------------------------------

const BIG = { heading: "Start here", body: "A fictional welcome for a fictional buyer. ".repeat(40).trim(), video: null, button: null };
const SMALL = { heading: "Hi", body: "A short fictional line.", video: null, button: null };
let made = 0;
async function product(): Promise<string> {
  made += 1;
  const p = await addProduct(noteOwner, `Fictional guide ${made}`, "", "12", null);
  assert.ok(p.ok);
  return p.product.id;
}
const used = async () => (await dataUsed((await fixture).noteStore))!.used;
const noteKey = async (id: string) => `nl:product:note:${(await fixture).statsId}:${id}`;
const isNoteSet = (key: string) => (c: Cmd) => c[0] === "SET" && c[1] === key;
const isSlotRead = (id: string) => (c: Cmd) => c[0] === "HGET" && c[2] === `tn:${id}`;

/** What one note of this shape adds to the room, written on a fresh product. */
async function weightOf(note: typeof SMALL): Promise<number> {
  const { noteStore, statsId } = await fixture;
  const id = await product();
  const before = await used();
  await writeThanksNote(statsId, id, note, noteStore);
  const after = await used();
  await writeThanksNote(statsId, id, null, noteStore);
  return after - before;
}

const SET_UNKNOWN: [string, Mode][] = [
  ["no value", { slot: undefined }],
  ["null", { slot: null }],
  ["lowercase ok", { slot: "ok" }],
  ["a count", { slot: 1 }],
  ["a list", { slot: ["OK"] }],
  ["no reply for it", "short"],
];

test("healthy: a note rewritten smaller is counted at its new size; larger, at its new size", async () => {
  const { noteStore, statsId } = await fixture;
  const small = await weightOf(SMALL);
  const big = await weightOf(BIG);
  assert.equal(big > small, true);
  const id = await product();
  const before = await used();
  await writeThanksNote(statsId, id, BIG, noteStore);
  assert.equal(await used(), before + big);
  await writeThanksNote(statsId, id, SMALL, noteStore);
  assert.deepEqual([await used(), (await readThanksNote(statsId, id))?.heading], [before + small, SMALL.heading]);
  await writeThanksNote(statsId, id, BIG, noteStore);
  assert.equal(await used(), before + big);
  await writeThanksNote(statsId, id, null, noteStore);
  assert.equal(await used(), before);
});

for (const [name, mode] of [...SET_UNKNOWN, ["a request that fails", "transport"] as [string, Mode]]) {
  test(`rewritten smaller, the SET answers ${name}: the old note's room stays counted`, async () => {
    const { noteStore, statsId } = await fixture;
    const id = await product();
    const before = await used();
    await writeThanksNote(statsId, id, BIG, noteStore);
    const kept = await used();
    const { hits } = await tampered(isNoteSet(await noteKey(id)), mode, () => assert.rejects(writeThanksNote(statsId, id, SMALL, noteStore)));
    assert.equal(hits, 1);
    assert.equal((await readThanksNote(statsId, id))?.heading, BIG.heading);
    assert.equal(await used(), kept);
    // The next good write counts what is kept again.
    await writeThanksNote(statsId, id, SMALL, noteStore);
    assert.equal(await used(), before + (await weightOf(SMALL)));
    await writeThanksNote(statsId, id, null, noteStore);
  });

  test(`rewritten larger, the SET answers ${name}: the larger room stays counted, as before`, async () => {
    const { noteStore, statsId } = await fixture;
    const id = await product();
    const before = await used();
    await writeThanksNote(statsId, id, SMALL, noteStore);
    await tampered(isNoteSet(await noteKey(id)), mode, () => assert.rejects(writeThanksNote(statsId, id, BIG, noteStore)));
    assert.equal(await used(), before + (await weightOf(BIG)));
    await writeThanksNote(statsId, id, null, noteStore);
  });
}

const SLOT_UNKNOWN: [string, Mode][] = [
  ["no value", { slot: undefined }],
  ["a number", { slot: 120 }],
  ["a negative count as text", { slot: "-5" }],
  ["a fraction as text", { slot: "1.5" }],
  ["a text", { slot: "x" }],
  ["a list", { slot: ["120"] }],
  ["no reply for it", "short"],
];

for (const [name, mode] of SLOT_UNKNOWN) {
  test(`the note's counted room answers ${name}: nothing written, nothing counted differently`, async () => {
    const { noteStore, statsId } = await fixture;
    const id = await product();
    await writeThanksNote(statsId, id, BIG, noteStore);
    const kept = await used();
    const key = await noteKey(id);
    let sets = 0;
    const { hits } = await tampered(isSlotRead(id), mode, async () => {
      const inner = redis.pipeline;
      redis.pipeline = async (commands: Cmd[]) => {
        sets += commands.filter(isNoteSet(key)).length;
        return inner.call(redis, commands);
      };
      try {
        await assert.rejects(writeThanksNote(statsId, id, SMALL, noteStore), UnknownReplyError);
      } finally {
        redis.pipeline = inner;
      }
    });
    assert.deepEqual([hits, sets], [1, 0]);
    assert.equal((await readThanksNote(statsId, id))?.heading, BIG.heading);
    assert.equal(await used(), kept);
    await writeThanksNote(statsId, id, null, noteStore);
  });
}
