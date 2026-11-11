/**
 * The studio's picture door (app/api/store/image/upload) is capped before it signs (owner rule MR: a ceiling before
 * every spend; rule 24 inventory item A1, 8 November 2026).
 *
 * Every door it opens is a file-store write of up to MAX_IMAGE_BYTES, and a picture uploaded and never put on
 * anything stays in the file store. Before this, PICTURE_DOOR_MAX only trimmed the oldest notes of a store's list
 * (ZREMRANGEBYRANK) and the door kept opening. Each check sends the real route a real request from the creator's own
 * session, with synthetic files in a file store held in memory (tests/failure-cleanup-world.ts), and reads the list:
 *
 *   - a store already holding PICTURE_DOOR_MAX fresh doors nothing has taken is refused (429, pictures_waiting), with
 *     nothing noted and none of its notes pushed out; notes past the day do not count, and another store is not held;
 *   - a store past its hourly count of doors is refused (429, pictures_hourly), counted before anything is signed;
 *   - a count that cannot be read (the hourly counter's reply, or the list's own count, in any other shape) refuses
 *     (503, pictures_unavailable), never opens;
 *   - each refusal has a plain sentence among the studio's messages.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, imageFolder } from "@/lib/store";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { PICTURE_DOOR_MAX, PICTURE_DOOR_SECONDS } from "@/lib/picture-door";
import { POST as door } from "@/app/api/store/image/upload/route";
import { store as redis } from "./redis-stub";
import { files } from "./failure-cleanup-world";
import { done, is, part } from "./check";

const OWNER = "door.ceiling@example.com";
const OTHER = "door.ceiling.other@example.com";
const ORIGIN = "https://marktmorgen.com";

type Bend = (commands: (string | number)[][], replies: unknown[]) => unknown;
let bend: Bend | null = null;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await realPipeline(commands);
  return bend ? bend(commands, replies) : replies;
}) as typeof redis.pipeline;

const post = (session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}/api/store/image/upload`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const answer = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];
const hourKey = (folder: string) => `nl:rl:picture-door:${createHash("sha256").update(`nimbus-picture-door:${folder}`).digest("hex").slice(0, 32)}`;

async function setUp(email: string, handle: string) {
  await claimHandle(email, handle, "Door Shop", "");
  await ensureStatsId(email);
  const made = await addProduct(email, "Guide", "", "19", null);
  if (!made.ok) throw new Error("setup");
  const session = await openSession(email);
  const folder = await imageFolder(email);
  const doors = `nl:pictures:doors:${folder}`;
  let n = 0;
  const fresh = () => `images/${folder}/${(n++).toString(16).padStart(32, "0")}.jpg`;
  const ask = (pathname: string) =>
    door(post(session, { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: JSON.stringify({ productId: made.product.id }), multipart: false } }));
  const card = () => redis.run(["ZCARD", doors]) as number;
  return { folder, doors, fresh, ask, card };
}

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  const shop = await setUp(OWNER, "doorceiling");
  const other = await setUp(OTHER, "doorceilingtwo");

  part("A healthy door opens and is noted");
  const first = shop.fresh();
  is("the door opens", await answer(await shop.ask(first)), [200, "ok"]);
  is("and the upload is noted", redis.run(["ZSCORE", shop.doors, first]) !== null, true);

  part("A store already holding PICTURE_DOOR_MAX fresh doors is refused, and nothing it holds is pushed out");
  const now = Date.now();
  const oldest = `images/${shop.folder}/${"e".repeat(32)}.jpg`;
  redis.run(["ZADD", shop.doors, now - 60_000, oldest]);
  for (let i = shop.card(); i < PICTURE_DOOR_MAX; i += 1) redis.run(["ZADD", shop.doors, now - 1_000 + (i % 500), shop.fresh()]);
  is("the store holds exactly PICTURE_DOOR_MAX fresh notes", shop.card(), PICTURE_DOOR_MAX);
  const refused = shop.fresh();
  is("one more door is refused as waiting pictures", await answer(await shop.ask(refused)), [429, "pictures_waiting"]);
  is("nothing is noted for it", redis.run(["ZSCORE", shop.doors, refused]), null);
  is("the store still holds PICTURE_DOOR_MAX notes", shop.card(), PICTURE_DOOR_MAX);
  is("and its oldest fresh note is not pushed out", redis.run(["ZSCORE", shop.doors, oldest]) !== null, true);
  is("another store's door still opens", await answer(await other.ask(other.fresh())), [200, "ok"]);

  part("Notes past the day are not counted");
  redis.run(["DEL", shop.doors]);
  const stale = now - (PICTURE_DOOR_SECONDS + 60) * 1000;
  for (let i = 0; i < PICTURE_DOOR_MAX; i += 1) redis.run(["ZADD", shop.doors, stale, shop.fresh()]);
  is("a store whose notes are all past the day opens a door", await answer(await shop.ask(shop.fresh())), [200, "ok"]);
  is("and the stale notes went with it", shop.card(), 1);

  part("A store past its hourly doors is refused before anything is signed");
  redis.run(["SET", hourKey(shop.folder), "100000", "EX", 3600]);
  const hourly = shop.fresh();
  is("refused as hourly", await answer(await shop.ask(hourly)), [429, "pictures_hourly"]);
  is("and nothing is noted", redis.run(["ZSCORE", shop.doors, hourly]), null);
  is("another store's door still opens", await answer(await other.ask(other.fresh())), [200, "ok"]);
  redis.run(["DEL", hourKey(shop.folder)]);
  is("the hour over, the door opens again", await answer(await shop.ask(shop.fresh())), [200, "ok"]);

  part("A count that cannot be read never opens the door");
  bend = (commands, replies) => (commands.some((c) => String(c[1] ?? "").startsWith("nl:rl:picture-door:")) ? ["OK", "1"] : replies);
  const unread = shop.fresh();
  is("an hourly count in another shape: refused as unavailable", await answer(await shop.ask(unread)), [503, "pictures_unavailable"]);
  is("and nothing is noted", redis.run(["ZSCORE", shop.doors, unread]), null);
  bend = (commands, replies) => (commands.some((c) => c[0] === "ZADD" && String(c[1]).startsWith("nl:pictures:doors:")) ? replies.map((r, i) => (commands[i][0] === "ZCARD" ? String(r) : r)) : replies);
  is("a list count in another shape: refused as unavailable", await answer(await shop.ask(shop.fresh())), [503, "pictures_unavailable"]);
  bend = (commands, replies) => (commands.some((c) => c[0] === "ZADD" && String(c[1]).startsWith("nl:pictures:doors:")) ? replies.slice(0, 2) : replies);
  is("a short list reply: refused as unavailable", await answer(await shop.ask(shop.fresh())), [503, "pictures_unavailable"]);
  bend = null;
  is("healthy again, the door opens", await answer(await shop.ask(shop.fresh())), [200, "ok"]);

  part("Each refusal says why in plain words");
  for (const code of ["pictures_waiting", "pictures_hourly", "pictures_unavailable"]) {
    const sentence = STUDIO_MESSAGES[code] ?? "";
    is(`${code} has a sentence that ends with a period`, sentence.length > 20 && sentence.endsWith("."), true);
  }

  done();
}

main().catch((error) => {
  redis.pipeline = realPipeline;
  console.error(error);
  process.exit(1);
});
