/**
 * Pictures let in through the studio's picture door and never put on anything are deleted once their door is past
 * its grace (30 days, owner decision DONO-8) (owner rule MR: a ceiling before every spend; rule 24 inventory A1b, 8 November 2026).
 *
 * Before this, such a picture stayed in the file store for good once its note expired: nothing could put it on a
 * record any more (every attach takes a fresh note, lib/picture-door.ts), and nothing deleted it. Each check uses the
 * real door and attach routes from the creator's own session, with synthetic files in a file store held in memory
 * (tests/failure-cleanup-world.ts), and the real sweep (sweepPictureDoors):
 *
 *   - every door is also written on the company's list of unclaimed pictures, at the same time as the store's note;
 *   - a picture past its grace that nothing took is deleted, both notes go, and a fresh one is kept;
 *   - a picture put on a product, a link or a page is off the list and never deleted by the sweep;
 *   - a note past its day can never be taken: the attach is refused and both notes stay for the sweep;
 *   - the sweep and an attach can never both win one picture (the list's ZREM decides);
 *   - an unknown reply keeps the file; a failed delete puts the picture back for the next run; a run has a cap;
 *   - a store's untaken pictures count against PICTURE_DOOR_MAX until the sweep deletes them;
 *   - the course job runs the sweep; the registry says what bounds what the door keeps (its cost line waits for the
 *     owner: it does not fit under the first year given back's ceiling with every figure counted).
 * tests/picture-door-sweep-guard.test.ts holds what makes a picture proven unused (Claude 2 on #3347).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, addStoreLink, claimHandle, ensureStatsId, imageFolder } from "@/lib/store";
import * as door from "@/lib/picture-door";
import { POST as upload } from "@/app/api/store/image/upload/route";
import { POST as productImage } from "@/app/api/store/image/route";
import { POST as linkImage } from "@/app/api/store/link-image/route";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { store as redis } from "./redis-stub";
import { files } from "./failure-cleanup-world";
import { COST_LINES, NOT_A_COST } from "./plan-cost-registry";
import { done, is, part } from "./check";

const OWNER = "door.sweep@example.com";
const ORIGIN = "https://marktmorgen.com";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const DAY = 24 * 60 * 60 * 1000;
/** The sweep's grace (owner decision DONO-8): 30 days after the door. */
const GRACE = 30 * DAY;
const UNCLAIMED = "nl:pictures:unclaimed";

type Sweep = (remove: (paths: string[]) => Promise<void>, now?: number, limit?: number) => Promise<string[]>;
const sweep = (door as unknown as { sweepPictureDoors?: Sweep }).sweepPictureDoors;
const run = async (now: number, limit?: number, remove?: (paths: string[]) => Promise<void>): Promise<string[] | string> => {
  if (!sweep) return "no sweep";
  try {
    return await sweep(remove ?? (async (paths) => { for (const path of paths) files.delete(path); }), now, limit);
  } catch {
    return "throws";
  }
};

type Bend = (commands: (string | number)[][], replies: unknown[]) => unknown;
let bend: Bend | null = null;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await realPipeline(commands);
  return bend ? bend(commands, replies) : replies;
}) as typeof redis.pipeline;

const post = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const answer = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, "doorsweep", "Sweep Shop", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Guide", "", "19", null);
  const linked = await addStoreLink(OWNER, "My podcast", "https://example.com/pod");
  if (!made.ok || !linked.ok) throw new Error("setup");
  const productId = made.product.id;
  const linkId = linked.store.links[0].id;
  const session = await openSession(OWNER);
  const folder = await imageFolder(OWNER);
  const doors = `nl:pictures:doors:${folder}`;
  let n = 0;
  const name = () => `images/${folder}/${(++n).toString(16).padStart(32, "0")}.jpg`;
  /** A picture let in through the door and stored just after, as the studio's editors do it. */
  const uploaded = async (payload: Record<string, string> = { productId }) => {
    const pathname = name();
    const asked = await upload(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: JSON.stringify(payload), multipart: false } }));
    if (asked.status !== 200) throw new Error(`door ${asked.status}`);
    files.set(pathname, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
    return pathname;
  };
  const attach = (path: string) => productImage(post("/api/store/image", session, { action: "attach", id: productId, path, width: 1200, height: 800 })).then(answer);
  const linkAttach = (path: string) => linkImage(post("/api/store/link-image", session, { action: "attach", id: linkId, path, width: 320, height: 180 })).then(answer);
  const onStore = (path: string) => redis.run(["ZSCORE", doors, path]) !== null;
  const onList = (path: string) => redis.run(["ZSCORE", UNCLAIMED, path]) !== null;
  /** Both notes moved back in time, as if the door had been opened `ago` ms before now. */
  const age = (path: string, ago: number) => {
    redis.run(["ZADD", doors, Date.now() - ago, path]);
    redis.run(["ZADD", UNCLAIMED, Date.now() - ago, path]);
  };

  part("Every door is written on the list of unclaimed pictures with the store's note");
  const kept = await uploaded();
  is("the store's note is there", onStore(kept), true);
  is("and so is the list's, at the same time", redis.run(["ZSCORE", UNCLAIMED, kept]), redis.run(["ZSCORE", doors, kept]));

  part("A picture past its grace that nothing took is deleted; a fresh one is kept");
  const left = await uploaded();
  age(left, GRACE + 2 * 60 * 60 * 1000);
  is("the sweep deletes exactly the stale one", await run(Date.now()), [left]);
  is("its file is gone", files.has(left), false);
  is("its list entry is gone", onList(left), false);
  is("and its store note, so it no longer counts against the store", onStore(left), false);
  is("the fresh one's file is kept", files.has(kept), true);
  is("and it is still on both lists", [onStore(kept), onList(kept)], [true, true]);
  is("a second run finds nothing", await run(Date.now()), []);

  part("A picture put on a product or a link leaves the list and is never swept");
  const shown = await uploaded();
  is("put on the product", await attach(shown), [200, "ok"]);
  is("it is off the list", onList(shown), false);
  const linkPicture = await uploaded({ linkId });
  is("put on the link", await linkAttach(linkPicture), [200, "ok"]);
  is("it is off the list", onList(linkPicture), false);
  is("a sweep past the grace deletes neither", await run(Date.now() + GRACE + 2 * DAY), [kept]);
  is("the product's picture is kept", files.has(shown), true);
  is("the link's picture is kept", files.has(linkPicture), true);

  part("A note past its day can never be taken: the attach is refused and both notes stay for the sweep");
  const late = await uploaded();
  age(late, DAY + 60_000);
  is("attaching it a day on is refused", await attach(late), [400, "in_use"]);
  is("its store note stays", onStore(late), true);
  is("its list entry stays", onList(late), true);
  age(late, GRACE + 60_000);
  is("and the sweep past the grace deletes it", await run(Date.now()), [late]);
  is("its file is gone", files.has(late), false);

  part("The sweep and an attach never both win one picture");
  const raced = await uploaded();
  age(raced, GRACE + 2 * 60 * 60 * 1000);
  // An attach takes the picture between the sweep's read of the list and its removal.
  bend = (commands, replies) => {
    if (commands[0][0] === "ZRANGEBYSCORE" && commands[0][1] === UNCLAIMED) redis.run(["ZREM", UNCLAIMED, raced]);
    return replies;
  };
  is("the sweep that lost the removal deletes nothing", await run(Date.now()), []);
  bend = null;
  is("the file is kept", files.has(raced), true);
  const unlisted = name();
  files.set(unlisted, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
  redis.run(["ZADD", doors, Date.now(), unlisted]);
  is("a fresh store note with no entry on the list is not taken: refused", await attach(unlisted), [400, "in_use"]);
  const swept = await uploaded();
  age(swept, GRACE + 2 * 60 * 60 * 1000);
  is("swept first", await run(Date.now()), [swept]);
  redis.run(["ZADD", doors, Date.now(), swept]);
  is("an attach after the sweep won is refused, even with a fresh store note", await attach(swept), [400, "in_use"]);

  part("An unknown reply keeps the file");
  const unsure = await uploaded();
  age(unsure, GRACE + 2 * 60 * 60 * 1000);
  bend = (commands, replies) => (commands[0][0] === "ZRANGEBYSCORE" ? ["soon"] : replies);
  is("a list read in another shape throws", await run(Date.now()), "throws");
  bend = (commands, replies) => (commands.every((c) => c[0] === "ZREM" && c[1] === UNCLAIMED) ? replies.map(() => "1") : replies);
  is("a removal answered \"1\" deletes nothing", await run(Date.now()), []);
  bend = null;
  is("the file is kept", files.has(unsure), true);
  age(unsure, GRACE + 2 * 60 * 60 * 1000);
  bend = (commands, replies) => (commands.every((c) => c[0] === "ZREM" && c[1] === UNCLAIMED) ? replies.slice(1) : replies);
  is("a short removal reply deletes nothing", await run(Date.now()), []);
  bend = null;
  is("the file is still kept", files.has(unsure), true);
  const unsureTake = await uploaded();
  bend = (commands, replies) => (commands.some((c) => c[0] === "ZREM" && c[1] === UNCLAIMED) ? replies.map((r, i) => (commands[i][1] === UNCLAIMED ? "1" : r)) : replies);
  is("an attach whose removal from the list is answered \"1\" is refused as unknown", await attach(unsureTake), [500, "server_error"]);
  bend = null;

  part("A failed delete puts the picture back for the next run");
  const stuck = await uploaded();
  age(stuck, GRACE + 2 * 60 * 60 * 1000);
  is("the delete fails: nothing reported deleted", await run(Date.now(), undefined, async () => { throw new Error("file store down"); }), []);
  is("the file is kept", files.has(stuck), true);
  is("it is back on the list", onList(stuck), true);
  is("its store note stays", onStore(stuck), true);
  is("the next run deletes it", await run(Date.now()), [stuck]);
  is("and its store note goes", onStore(stuck), false);

  part("A run deletes at most its cap, oldest first");
  redis.run(["DEL", UNCLAIMED, doors]);
  const many: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const path = name();
    files.set(path, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() - GRACE - 3 * DAY + i + 1 });
    redis.run(["ZADD", doors, Date.now() - GRACE - 3 * DAY + i, path]);
    redis.run(["ZADD", UNCLAIMED, Date.now() - GRACE - 3 * DAY + i, path]);
    many.push(path);
  }
  is("a run with a cap of five deletes the five oldest", await run(Date.now(), 5), many.slice(0, 5));
  is("seven are left", many.filter((path) => files.has(path)).length, 7);
  is("the per-run cap is exported", typeof (door as unknown as Record<string, unknown>).PICTURE_SWEEP_PER_RUN, "number");

  part("A store's untaken pictures count against its cap until the sweep deletes them");
  redis.run(["DEL", UNCLAIMED, doors]);
  const old = Date.now() - DAY - 60_000;
  for (let i = 0; i < door.PICTURE_DOOR_MAX; i += 1) {
    const path = name();
    redis.run(["ZADD", doors, old, path]);
    redis.run(["ZADD", UNCLAIMED, old, path]);
  }
  const waiting = name();
  const asked = await upload(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname: waiting, clientPayload: JSON.stringify({ productId }), multipart: false } }));
  is("a store holding PICTURE_DOOR_MAX untaken pictures past the day is still refused", await answer(asked), [429, "pictures_waiting"]);
  is("nothing is noted for it on either list", [onStore(waiting), onList(waiting)], [false, false]);
  await run(Date.now() + GRACE, door.PICTURE_DOOR_MAX);
  is("after the sweep the store's list is empty", redis.run(["ZCARD", doors]), 0);
  const reopened = await upload(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname: waiting, clientPayload: JSON.stringify({ productId }), multipart: false } }));
  is("and the door opens again", await answer(reopened), [200, "ok"]);
  is("the refusal's sentence no longer says the pictures are from the last day", /last day/.test(STUDIO_MESSAGES.pictures_waiting ?? ""), false);

  part("The course job runs the sweep, and the registry says what the door keeps");
  const cron = readFileSync(join(process.cwd(), "app/api/cron/courses/route.ts"), "utf8");
  is("the course job calls sweepPictureDoors with the file store's delete", /sweepPictureDoors\(del\)/.test(cron), true);
  is("the sweep waits past the door's day", door.PICTURE_SWEEP_AFTER_SECONDS > door.PICTURE_DOOR_SECONDS, true);
  // The cost line itself waits for the owner: at its drafted ceilings it takes the first year given back past US$ 65.
  const said = NOT_A_COST.PICTURE_DOORS_PER_HOUR ?? "";
  is("NOT_A_COST no longer says untaken pictures are kept for good", /is not deleted once its note is a day old/.test(said), false);
  is("it names the sweep and the cap that bound what is kept", /sweepPictureDoors/.test(said) && /PICTURE_DOOR_MAX/.test(said), true);
  is("and no line prices it yet: not certified, never zero", !COST_LINES.some((line) => line.id === "picture-doors") && /never zero/.test(said), true);

  done();
}

main().catch((error) => {
  redis.pipeline = realPipeline;
  console.error(error);
  process.exit(1);
});
