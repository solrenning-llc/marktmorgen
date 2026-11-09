/**
 * The picture door's sweep deletes only a picture proven to be unused (Claude 2 on #3347, @6fe4790aa4; owner
 * decision DONO-8, 9 November 2026: leftover pictures are cleaned only when proven to have no reference, after a
 * grace of 30 days, and an unknown reference never deletes).
 *
 *   - a late note for a name an attach already took is refused, and the sweep never deletes that picture;
 *   - the sweep checks the file itself: one stored before its note, or whose check cannot be read, is never deleted;
 *   - the grace is 30 days: a picture a day old is kept;
 *   - a store note left behind once its picture was taken or swept no longer counts against the store's cap, and the
 *     store's list has an expiry, so such notes can never keep the upload door shut;
 *   - an untaken note still waiting for the sweep keeps counting (the cap still bounds what the file store keeps);
 *   - a picture taken off its store's list only (by the code before the list of unclaimed pictures, after a rollback;
 *     Claude 2 on #3347 @1eef9e91e1) is never deleted: the sweep deletes only while the store's note is still there,
 *     and a store note read in another shape keeps the file and puts it back;
 *   - the refusal says unused pictures go "about" 30 days after upload: the grace counts from the door.
 *
 * Synthetic files in a file store held in memory (tests/failure-cleanup-world.ts) and the real door, attach routes and
 * sweep.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, imageFolder, setProductImage, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import * as door from "@/lib/picture-door";
import { POST as upload } from "@/app/api/store/image/upload/route";
import { POST as productImage } from "@/app/api/store/image/route";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { store as redis } from "./redis-stub";
import { files } from "./failure-cleanup-world";
import { done, is, part } from "./check";

const OWNER = "door.guard@example.com";
const ORIGIN = "https://marktmorgen.com";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const UNCLAIMED = "nl:pictures:unclaimed";

type Look = (path: string) => Promise<{ uploadedAt: Date }>;
type Sweep = (remove: (paths: string[]) => Promise<void>, now?: number, limit?: number, look?: Look) => Promise<string[]>;
const sweep = door.sweepPictureDoors as unknown as Sweep;
const run = async (now: number, look?: Look): Promise<string[] | string> => {
  try {
    return await sweep(async (paths) => { for (const path of paths) files.delete(path); }, now, undefined, look);
  } catch {
    return "throws";
  }
};

/** Runs once, just before the pipeline it matches is sent: the moment another request's work lands in between. */
let before: { match: (commands: (string | number)[][]) => boolean; then: () => Promise<void> } | null = null;
/** Runs once, on the replies of the pipeline it matches: an answer that comes back in another shape. */
let after: { match: (commands: (string | number)[][]) => boolean; change: (replies: unknown[]) => unknown } | null = null;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const hook = before;
  if (hook && hook.match(commands)) {
    before = null;
    await hook.then();
  }
  const replies = await realPipeline(commands);
  const swap = after;
  if (swap && swap.match(commands)) {
    after = null;
    return swap.change(replies as unknown[]);
  }
  return replies;
}) as typeof redis.pipeline;

const post = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const answer = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, "doorguard", "Guard Shop", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Guide", "", "19", null);
  if (!made.ok) throw new Error("setup");
  const productId = made.product.id;
  const session = await openSession(OWNER);
  const folder = await imageFolder(OWNER);
  const doors = `nl:pictures:doors:${folder}`;
  let n = 0;
  const name = () => `images/${folder}/${(++n).toString(16).padStart(32, "a")}.jpg`;
  const ask = (pathname: string) =>
    upload(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: JSON.stringify({ productId }), multipart: false } }));
  const attach = (path: string) => productImage(post("/api/store/image", session, { action: "attach", id: productId, path, width: 1200, height: 800 })).then(answer);
  const onStore = (path: string) => redis.run(["ZSCORE", doors, path]) !== null;
  const onList = (path: string) => redis.run(["ZSCORE", UNCLAIMED, path]) !== null;
  const shown = async () => (await readListing((await storeForEmail(OWNER))!, productId))?.image?.path;

  part("Two doors for one name: a late note after the attach took it is refused, and the sweep never deletes the picture");
  const raced = name();
  is("the first door opens", await answer(await ask(raced)), [200, "ok"]);
  // The second door has checked the file store (no file yet); before its note lands, the first upload is stored and
  // attached, which takes the picture off the list.
  let attached: unknown[] = [];
  before = {
    match: (commands) => commands.some((c) => c[0] === "ZADD" && c[1] === UNCLAIMED && c.includes(raced)),
    then: async () => {
      files.set(raced, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() - 5 });
      attached = await attach(raced);
    },
  };
  const second = await answer(await ask(raced));
  before = null;
  is("the attach in between put the picture on the product", attached, [200, "ok"]);
  is("the product shows it", await shown(), raced);
  is("the late second door is not opened", second[0] === 200, false);
  is("and the taken name is not written back on the list of unclaimed pictures", onList(raced), false);
  is("nor on the store's list", onStore(raced), false);
  is("a direct late note for the taken name is refused too", await door.notePictureDoor(raced), false);
  is("and still not on the list", onList(raced), false);
  is("a sweep 31 days on deletes nothing", await run(Date.now() + 31 * DAY), []);
  is("the product's picture is still in the file store", files.has(raced), true);
  is("and still on the product", await shown(), raced);

  part("A picture taken off its store's list only (the code before this list, after a rollback) is never deleted");
  // The door of this code notes the name on both lists; the code before it takes a picture from the store's list
  // only (ZSCORE and ZREM there, nothing on the list of unclaimed pictures), as main did before this change.
  const rolled = name();
  is("the door opens", await answer(await ask(rolled)), [200, "ok"]);
  files.set(rolled, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
  is("the earlier code's take finds the store's note", redis.run(["ZSCORE", doors, rolled]) !== null, true);
  redis.run(["ZREM", doors, rolled]);
  const put = await setProductImage(OWNER, productId, { path: rolled, width: 1200, height: 800, alt: "", bytes: JPEG.length, small: null });
  is("and puts the picture on the product", put.ok, true);
  is("the product shows it", await shown(), rolled);
  is("it is still on the list of unclaimed pictures (the earlier code never touches it)", onList(rolled), true);
  is("a sweep 31 days on deletes nothing", await run(Date.now() + 31 * DAY), []);
  is("the product's picture is still in the file store", files.has(rolled), true);
  is("and still on the product", await shown(), rolled);
  is("it is not looked at again", onList(rolled), false);
  // A store note read in another shape: unknown, never "no note" nor "noted".
  const odd = name();
  is("another door opens", await answer(await ask(odd)), [200, "ok"]);
  files.set(odd, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
  after = {
    match: (commands) => commands.some((c) => c[0] === "ZSCORE" && c[1] === doors && c[2] === odd),
    change: (replies) => replies.map(() => "soon"),
  };
  is("a store note answered in another shape deletes nothing", await run(Date.now() + 31 * DAY), []);
  after = null;
  is("the file is kept", files.has(odd), true);
  is("it is put back for the next run", onList(odd), true);
  is("and its store note still counts", onStore(odd), true);
  after = { match: (commands) => commands.some((c) => c[0] === "ZSCORE" && c[1] === doors && c[2] === odd), change: () => null };
  is("a store note read with no reply at all deletes nothing", await run(Date.now() + 31 * DAY), []);
  after = null;
  is("the file is still kept and put back", [files.has(odd), onList(odd), onStore(odd)], [true, true, true]);
  is("the next healthy run deletes it (its store note is there, stored after it, past the grace)", await run(Date.now() + 31 * DAY), [odd]);
  is("and both notes go", [onStore(odd), onList(odd)], [false, false]);

  part("The sweep checks the file itself before deleting");
  // A note on a file stored before it (as a late note whose undo was lost would leave): never this note's upload.
  const older = name();
  const at = Date.now() - 40 * DAY;
  files.set(older, { bytes: JPEG, contentType: "image/jpeg", at });
  redis.run(["ZADD", doors, at + 60_000, older]);
  redis.run(["ZADD", UNCLAIMED, at + 60_000, older]);
  is("a file stored before its note is not deleted", await run(Date.now()), []);
  is("it is kept", files.has(older), true);
  is("both notes are dropped, so it is not looked at again", [onStore(older), onList(older)], [false, false]);
  // A check of the file that cannot be read: unknown, never "unused".
  const unsure = name();
  files.set(unsure, { bytes: JPEG, contentType: "image/jpeg", at: at + 120_000 });
  redis.run(["ZADD", doors, at + 60_000, unsure]);
  redis.run(["ZADD", UNCLAIMED, at + 60_000, unsure]);
  is("a file check that fails deletes nothing", await run(Date.now(), async () => { throw new Error("file store unavailable"); }), []);
  is("the file is kept", files.has(unsure), true);
  is("it is put back for the next run", onList(unsure), true);
  is("and still counts against the store", onStore(unsure), true);
  is("a check answered in another shape deletes nothing", await run(Date.now(), async () => ({ uploadedAt: new Date("soon") })), []);
  is("the file is still kept", files.has(unsure), true);
  is("the next healthy run deletes it (stored after its note, never taken, past the grace)", await run(Date.now()), [unsure]);
  is("and both notes go", [onStore(unsure), onList(unsure)], [false, false]);
  // A note with no file at all (a door whose upload never came): nothing to delete, its notes go.
  const empty = name();
  redis.run(["ZADD", doors, at, empty]);
  redis.run(["ZADD", UNCLAIMED, at, empty]);
  is("a note with no file deletes nothing", await run(Date.now()), []);
  is("its notes go", [onStore(empty), onList(empty)], [false, false]);

  part("The grace is 30 days (DONO-8)");
  is("PICTURE_SWEEP_AFTER_SECONDS is 30 days", door.PICTURE_SWEEP_AFTER_SECONDS, 30 * 24 * 60 * 60);
  const young = name();
  is("a door opens", await answer(await ask(young)), [200, "ok"]);
  files.set(young, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
  is("a sweep 26 hours on keeps it", await run(Date.now() + 26 * HOUR), []);
  is("the file is kept", files.has(young), true);
  is("a sweep 30 days and an hour on deletes it", await run(Date.now() + 30 * DAY + HOUR), [young]);
  // The grace counts from the door, and the upload comes up to minutes after it; the daily run can come later still.
  is("the refusal's sentence says unused pictures are deleted about 30 days after upload", /about 30 days after upload/.test(STUDIO_MESSAGES.pictures_waiting ?? ""), true);
  is("and no longer says a day", /more than a day are deleted/.test(STUDIO_MESSAGES.pictures_waiting ?? ""), false);

  part("Store notes left behind once their picture is gone never keep the door shut");
  redis.run(["DEL", UNCLAIMED, doors]);
  const old = Date.now() - 2 * DAY;
  // PICTURE_DOOR_MAX store notes whose pictures were taken or swept while the store's own removal was lost: on the
  // store's list only, not on the list of unclaimed pictures.
  for (let i = 0; i < door.PICTURE_DOOR_MAX; i += 1) redis.run(["ZADD", doors, old + i, name()]);
  const reopened = name();
  is("the door still opens", await answer(await ask(reopened)), [200, "ok"]);
  is("it is noted on both lists", [onStore(reopened), onList(reopened)], [true, true]);
  is("left-behind notes were dropped from the store's list", (redis.run(["ZCARD", doors]) as number) <= door.PICTURE_DOOR_MAX, true);
  const ttl = redis.run(["TTL", doors]) as number;
  is("the store's list has an expiry", ttl > 0, true);
  is("no longer than the grace and the days kept after it", ttl <= (door as unknown as { PICTURE_DOORS_KEPT_SECONDS: number }).PICTURE_DOORS_KEPT_SECONDS, true);

  part("Untaken notes still waiting for the sweep keep counting");
  redis.run(["DEL", UNCLAIMED, doors]);
  for (let i = 0; i < door.PICTURE_DOOR_MAX; i += 1) {
    const path = name();
    redis.run(["ZADD", doors, old + i, path]);
    redis.run(["ZADD", UNCLAIMED, old + i, path]);
  }
  const waiting = name();
  is("a store holding PICTURE_DOOR_MAX untaken pictures is still refused", await answer(await ask(waiting)), [429, "pictures_waiting"]);
  is("nothing is noted for it", [onStore(waiting), onList(waiting)], [false, false]);
  is("and no untaken note was dropped", redis.run(["ZCARD", doors]), door.PICTURE_DOOR_MAX);

  part("The course job says a sweep that could not run, never \"0 swept\"");
  const cron = readFileSync(join(process.cwd(), "app/api/cron/courses/route.ts"), "utf8");
  is("the studio sweep's failure is said in the answer", /studioPicturesFailed/.test(cron), true);

  done();
}

main().catch((error) => {
  redis.pipeline = realPipeline;
  console.error(error);
  process.exit(1);
});
