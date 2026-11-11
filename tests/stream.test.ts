/**
 * A lesson's video kept by the video service (lib/stream.ts): from the door
 * the studio asks for to the player a student is shown, and everything that
 * can go wrong between.
 *
 * The service is somebody else's, so it is stood in for here, faithfully
 * enough to be slow, to fail, to be unreachable and to announce things: the
 * numbers it gives a video are its own (its API's VideoModelStatus), and the
 * two signatures are worked out the way its own pages say. What no test here
 * can hold is the service itself; that is for a real video in a real
 * library, once there is one.
 */
import { createHash, createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as hook } from "@/app/api/stream/hook/route";
import { dynamicPolicy } from "@/lib/csp";
import { folderFromPathname } from "@/lib/delivery";
import {
  PLAYER_SECONDS,
  addCaption,
  believed,
  claimUpload,
  dropCaption,
  dropStream,
  heard,
  isStreamConfigured,
  lookAt,
  openUpload,
  playerFor,
  streamCaptions,
  streamHeld,
  streamRecord,
  streamStates,
  sweep,
} from "@/lib/stream";
import {
  ABANDONED_AFTER_MS,
  GIVE_UP_AFTER_MS,
  MOST_KEPT_BYTES,
  STREAM_API_ORIGIN,
  STREAM_PLAYER_ORIGIN,
  UPLOAD_WINDOW_SECONDS,
  isStreamPath,
  nextLook,
  readStreamPath,
  shapeOf,
  stateFrom,
  streamPath,
  viewingBytes,
} from "@/lib/stream-rules";
import { MAX_CAPTION_BYTES, MAX_CAPTION_TRACKS, CAPTION_LANGUAGES } from "@/lib/captions";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeFolder } from "@/lib/store";
import { addStoreCaption } from "@/lib/store-caption";
import { paidPeriod } from "./billing-period-fixture";

const LIBRARY = "4242";
const API_KEY = "a-stand-in-library-key-for-tests-only";
const TOKEN_KEY = "a-stand-in-token-key-for-tests-only";
const READ_KEY = "a-stand-in-read-key-for-tests-only";
const FOLDER = "0123456789abcdef0123456789abcdef";
const OTHER_FOLDER = "fedcba9876543210fedcba9876543210";
const LESSON = "abcdefghij12";

type Video = {
  guid: string;
  title: string;
  collectionId: string;
  status: number;
  availableResolutions: string;
  length: number;
  width: number;
  height: number;
  rotation: number | null;
  storageSize: number;
};
const videos = new Map<string, Video>();
/** The captions the service holds, by video and language: the label, and the file as it was sent. */
const captions = new Map<string, { label: string; file: string }>();
const collections = new Map<string, string>();
const asked: string[] = [];
/** The service as a whole: there, busy, or not answering. */
let service: "up" | "busy" | "down" = "up";
let failDeletes = false;
let made = 0;
const guid = () => {
  made += 1;
  return `00000000-0000-4000-8000-${String(made).padStart(12, "0")}`;
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.origin !== STREAM_API_ORIGIN) return json({}, 404);
  asked.push(`${method} ${url.pathname}`);
  if (service === "down") throw new TypeError("fetch failed");
  if (service === "busy" || (failDeletes && method === "DELETE")) return json({ message: "busy" }, 503);
  if ((init?.headers as Record<string, string>).AccessKey !== API_KEY) return json({}, 401);
  const path = url.pathname.replace(`/library/${LIBRARY}`, "");
  if (method === "POST" && path === "/collections") {
    const id = guid();
    collections.set(id, (JSON.parse(String(init?.body)) as { name: string }).name);
    return json({ guid: id, name: collections.get(id), videoCount: 0, totalSize: 0 });
  }
  const collection = path.match(/^\/collections\/([0-9a-f-]+)$/);
  if (collection) {
    if (!collections.has(collection[1])) return json({}, 404);
    if (method === "DELETE") {
      collections.delete(collection[1]);
      return json({ success: true });
    }
    const held = [...videos.values()].filter((v) => v.collectionId === collection[1]);
    return json({ guid: collection[1], videoCount: held.length, totalSize: held.reduce((n, v) => n + v.storageSize, 0) });
  }
  if (method === "POST" && path === "/videos") {
    const body = JSON.parse(String(init?.body)) as { title: string; collectionId: string };
    const video: Video = { guid: guid(), title: body.title, collectionId: body.collectionId, status: 0, availableResolutions: "", length: 0, width: 0, height: 0, rotation: null, storageSize: 0 };
    videos.set(video.guid, video);
    return json(video);
  }
  const caption = path.match(/^\/videos\/([0-9a-f-]+)\/captions\/([a-z-]+)$/);
  if (caption) {
    if (!videos.has(caption[1])) return json({}, 404);
    const key = `${caption[1]}/${caption[2]}`;
    if (method === "DELETE") {
      captions.delete(key);
      return json({ success: true });
    }
    const sent = JSON.parse(String(init?.body)) as { label: string; captionsFile: string };
    const file = Buffer.from(sent.captionsFile, "base64").toString("utf8");
    // The service reads the file too, and says no to one it cannot.
    if (!file.startsWith("WEBVTT")) return json({ valid: false, errorList: ["not WebVTT"] }, 400);
    captions.set(key, { label: sent.label, file });
    return json({ valid: true, errorList: [] });
  }
  const one = path.match(/^\/videos\/([0-9a-f-]+)$/);
  if (one) {
    const video = videos.get(one[1]);
    if (!video) return json({}, 404);
    if (method === "DELETE") {
      videos.delete(one[1]);
      return json({ success: true });
    }
    return json(video);
  }
  return json({}, 404);
}) as typeof fetch;

/** The service's announcement about a video, signed the way its "Webhooks" page says. */
function announce(body: string, key = READ_KEY, extra: Record<string, string> = {}): Promise<Response> {
  const signature = createHmac("sha256", key).update(body, "utf8").digest("hex");
  return hook(
    new NextRequest("https://marktmorgen.com/api/stream/hook", {
      method: "POST",
      headers: {
        host: "marktmorgen.com",
        "content-length": String(Buffer.byteLength(body)),
        "x-bunnystream-signature-version": "v1",
        "x-bunnystream-signature-algorithm": "hmac-sha256",
        "x-bunnystream-signature": signature,
        ...extra,
      },
      body,
    }),
  );
}

function setUp(on: boolean): void {
  for (const [name, value] of [
    ["BUNNY_STREAM_LIBRARY_ID", LIBRARY],
    ["BUNNY_STREAM_API_KEY", API_KEY],
    ["BUNNY_STREAM_TOKEN_KEY", TOKEN_KEY],
    ["BUNNY_STREAM_READ_KEY", READ_KEY],
  ]) {
    if (on) process.env[name] = value;
    else delete process.env[name];
  }
}

const input = { folder: FOLDER, lessonId: LESSON, name: "Lesson one.mp4", bytes: 800_000_000, type: "video/mp4" };
// The test's clock starts at the hour now: the service's announcements are
// read at the real time (lib/stream.ts, heard), and a fixed day here grew a
// week older than the videos it made, which the code rightly treats as given up on.
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const MINUTE = 60_000;

async function main() {
  part("The path a lesson keeps for such a video");
  const sample = streamPath(FOLDER, LESSON, "00000000-0000-4000-8000-000000000abc");
  is("it reads back as the folder, the lesson and the id it was made from", readStreamPath(sample), { folder: FOLDER, lessonId: LESSON, id: "00000000-0000-4000-8000-000000000abc" });
  is("a file in the file store is not one", isStreamPath(`stores/${FOLDER}/${LESSON}/lesson.mp4`), false);
  is("nor is a path with a folder inside it", isStreamPath(`${sample}/more`), false);
  is("nor one that climbs out", isStreamPath(`stream/${FOLDER}/../${LESSON}/00000000-0000-4000-8000-000000000abc`), false);
  is("nor one whose id is not an id", isStreamPath(`stream/${FOLDER}/${LESSON}/latest`), false);
  is("the store it belongs to is read from it, for the month's delivery", folderFromPathname(sample), FOLDER);

  part("What the service's own numbers mean");
  is("made, with no file yet", stateFrom({ status: 0, availableResolutions: "" }), "upload");
  is("the file arrived", stateFrom({ status: 1, availableResolutions: "" }), "working");
  is("being turned into its sizes, none done", stateFrom({ status: 3, availableResolutions: "" }), "working");
  is("one size done, the rest still coming: it can be played", stateFrom({ status: 3, availableResolutions: "360p" }), "ready");
  is("finished", stateFrom({ status: 4, availableResolutions: "360p,720p,1080p" }), "ready");
  is("could not be read", stateFrom({ status: 5, availableResolutions: "" }), "failed");
  is("the upload failed", stateFrom({ status: 6, availableResolutions: "" }), "failed");

  part("What one viewing is counted as");
  is("ten minutes at 1080p", viewingBytes(600, 1080, 5_000_000_000), Math.round((600 * 5_500_000) / 8));
  is("a 4K file is counted at the tallest size kept, not at its own", viewingBytes(600, 2160, 5_000_000_000), viewingBytes(600, 1080, 5_000_000_000));
  is("a small one at its own size", viewingBytes(600, 480, 5_000_000_000), Math.round((600 * 1_700_000) / 8));
  is("never more than the file as it was uploaded", viewingBytes(3600, 1080, 100_000_000), 100_000_000);
  is("a video whose length is not known yet is counted as the whole file", viewingBytes(0, 1080, 100_000_000), 100_000_000);

  part("The shape the player takes");
  is("a video filmed wide", shapeOf(1920, 1080, 0), { width: 1920, height: 1080 });
  is("one filmed upright and stored turned a quarter", shapeOf(1920, 1080, 90), { width: 1080, height: 1920 });
  is("one the service has not measured yet", shapeOf(0, 0, null), { width: 16, height: 9 });

  part("Nothing runs until the service is set up");
  setUp(false);
  is("it is off", isStreamConfigured(), false);
  is("no door is opened", await openUpload(input, NOW), { ok: false, reason: "off" });
  is("the service was not asked anything", asked.length, 0);
  process.env.BUNNY_STREAM_LIBRARY_ID = LIBRARY;
  process.env.BUNNY_STREAM_API_KEY = API_KEY;
  is("nor with a library and no token key: a library without one plays to anybody", isStreamConfigured(), false);
  setUp(true);
  is("with them it is on", isStreamConfigured(), true);

  part("The studio asks for a door");
  const opened = await openUpload(input, NOW);
  is("it is given one", opened.ok, true);
  if (!opened.ok) return done();
  const { door } = opened;
  is("for a video made in the store's own collection", collections.get(videos.get(door.id)?.collectionId ?? ""), FOLDER);
  is("named after the store and the lesson, not the creator", videos.get(door.id)?.title, `${FOLDER}/${LESSON}`);
  is("good for a day", door.expires, Math.floor(NOW / 1000) + UPLOAD_WINDOW_SECONDS);
  is(
    "signed the way the service's own page says: library, key, the second it ends, the video",
    door.signature,
    createHash("sha256").update(`${LIBRARY}${API_KEY}${door.expires}${door.id}`).digest("hex"),
  );
  is("and the path to tell the lesson is that store's, that lesson's", readStreamPath(door.pathname), { folder: FOLDER, lessonId: LESSON, id: door.id });
  is("written down as an upload still to come", (await streamRecord(door.pathname))?.state, "upload");
  const second = await openUpload({ ...input, name: "Lesson two.mp4" }, NOW);
  is("a second video of the store goes in the same collection", collections.size, 1);

  part("The lesson is told its video");
  is("not a video whose door was opened for another store", await claimUpload(door.pathname, OTHER_FOLDER, LESSON, NOW), null);
  is("not for another lesson", await claimUpload(door.pathname, FOLDER, "zzzzzzzzzz99", NOW), null);
  is("not a path nothing is known about", await claimUpload(streamPath(FOLDER, LESSON, "00000000-0000-4000-8000-00000000ffff"), FOLDER, LESSON, NOW), null);
  is("not a file in the file store", await claimUpload(`stores/${FOLDER}/${LESSON}/lesson.mp4`, FOLDER, LESSON, NOW), null);
  videos.get(door.id)!.status = 1;
  const claimed = await claimUpload(door.pathname, FOLDER, LESSON, NOW + MINUTE);
  is("the one that was opened for it, yes: the file is there and no size is ready", claimed?.state, "working");
  is("what it is called and how big come from what was written down, not from the browser", [claimed?.name, claimed?.bytes, claimed?.type], ["Lesson one.mp4", 800_000_000, "video/mp4"]);

  part("An unconfirmed peek claim never asks the video provider");
  const realPipeline = redis.pipeline;
  try {
    for (const receipt of [[], ["OK", "extra"], [undefined], [false], [0], [1], [true], ["ok"], [{}], "OK", null]) {
      let claims = 0;
      redis.pipeline = async (commands) => {
        if (commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === `nl:stream:peek:${door.id}`) {
          claims += 1;
          return receipt as unknown as unknown[];
        }
        return realPipeline(commands);
      };
      const beforePeek = asked.length;
      const waiting = await playerFor(door.pathname, NOW + 2 * MINUTE);
      is(`unconfirmed claim ${JSON.stringify(receipt)} keeps preparation without provider request or retry`, [waiting?.state, waiting?.src, asked.length - beforePeek, claims], ["working", null, 0, 1]);
    }
  } finally {
    redis.pipeline = realPipeline;
  }

  part("A student opens the lesson while it is being prepared");
  let player = await playerFor(door.pathname, NOW + 2 * MINUTE);
  is("there is nothing to play yet, and the page says so", [player?.state, player?.src], ["working", null]);
  const before = asked.length;
  await playerFor(door.pathname, NOW + 2 * MINUTE + 5_000);
  is("a second student seconds later does not ask the service again", asked.length, before);

  part("The service says a size is ready");
  // Its smallest size, made before the service has written down the file's
  // length and shape: what a real library did with the first real video.
  Object.assign(videos.get(door.id)!, { status: 3, availableResolutions: "360p", storageSize: 30_000_000 });
  const announcement = JSON.stringify({ VideoLibraryId: Number(LIBRARY), VideoGuid: door.id, Status: 4 });
  is("an announcement signed with another key is not believed", (await announce(announcement, "somebody-elses-key")).status, 401);
  is("nor one whose body was changed after it was signed", believed(`${announcement} `, { version: "v1", algorithm: "hmac-sha256", signature: createHmac("sha256", READ_KEY).update(announcement).digest("hex") }, READ_KEY), false);
  is("nor one that names another way of signing", believed(announcement, { version: "v2", algorithm: "hmac-sha256", signature: createHmac("sha256", READ_KEY).update(announcement).digest("hex") }, READ_KEY), false);
  is("the video is still being prepared, as far as anybody is told", (await streamRecord(door.pathname))?.state, "working");
  const heardIt = await announce(announcement);
  is("the service's own is taken", [heardIt.status, await heardIt.json()], [200, { ok: true, result: "looked" }]);
  let ready = await streamRecord(door.pathname);
  is("and the video is ready: there is a size to play", ready?.state, "ready");
  is("its length and shape are not known yet, and nobody pretends they are", [ready?.seconds, ready?.width, ready?.height, ready?.settled], [0, 0, 0, false]);
  is("an announcement about a video that is not ours is let go", await heard({ VideoLibraryId: Number(LIBRARY), VideoGuid: "00000000-0000-4000-8000-00000000eeee", Status: 3 }), "ignored");
  is("and one from another library", await heard({ VideoLibraryId: 1, VideoGuid: door.id, Status: 3 }), "ignored");

  part("A video that plays before the service has finished with it");
  advance(31_000);
  player = await playerFor(door.pathname, NOW + 5 * MINUTE);
  is("it plays meanwhile, in the usual shape", [player?.state, typeof player?.src, player?.width, player?.height], ["ready", "string", 16, 9]);
  is("and a viewing is counted as the whole file, at the tallest size, not at a shape that is only a guess", viewingBytes(player?.record.seconds ?? -1, player?.record.height ?? -1, 800_000_000), 800_000_000);
  Object.assign(videos.get(door.id)!, { availableResolutions: "360p,720p", length: 600, width: 1920, height: 1080, rotation: 90, storageSize: 60_000_000 });
  const askedBefore = asked.length;
  player = await playerFor(door.pathname, NOW + 5 * MINUTE + 5_000);
  is("a student seconds later does not ask the service again", [asked.length, player?.width], [askedBefore, 16]);
  advance(31_000);
  player = await playerFor(door.pathname, NOW + 6 * MINUTE);
  is("the next one, once the service has measured it, sees it in its own shape: filmed upright, it is upright", [player?.width, player?.height], [1080, 1920]);
  ready = await streamRecord(door.pathname);
  is("its length is written down, and it is still being asked about: the larger sizes are coming", [ready?.seconds, ready?.settled], [600, false]);
  advance(31_000);
  const askedMeasured = asked.length;
  await playerFor(door.pathname, NOW + 7 * MINUTE);
  is("a student's page no longer asks: what it needed, it has", asked.length, askedMeasured);
  let later = await sweep(Date.now() + 5_000, NOW + 6 * MINUTE + nextLook(6 * MINUTE) + 1);
  is("the five-minute job does, and the video goes on playing", [later.looked, later.ready, (await streamRecord(door.pathname))?.settled], [1, 1, false]);
  Object.assign(videos.get(door.id)!, { status: 4, availableResolutions: "360p,720p,1080p", storageSize: 90_000_000 });
  const finished = await lookAt(door.id, NOW + 30 * MINUTE);
  is("when the service says it has finished, what it weighs is the whole of it", [finished?.state, finished?.bytes, finished?.settled], ["ready", 90_000_000, true]);
  const askedSettled = asked.length;
  later = await sweep(Date.now() + 5_000, NOW + 3 * 60 * MINUTE);
  is("and it is not asked about again", [later.looked, asked.length], [0, askedSettled]);

  part("The player a student is shown");
  player = await playerFor(door.pathname, NOW + 10 * MINUTE);
  const src = new URL(player?.src ?? "https://none.invalid");
  const expires = Math.floor((NOW + 10 * MINUTE) / 1000) + PLAYER_SECONDS;
  is("it is the service's own, for that video", `${src.origin}${src.pathname}`, `${STREAM_PLAYER_ORIGIN}/embed/${LIBRARY}/${door.id}`);
  is("good for a few hours", src.searchParams.get("expires"), String(expires));
  is(
    "with a token made the way the service's own page says: token key, video, the second it ends",
    src.searchParams.get("token"),
    createHash("sha256").update(`${TOKEN_KEY}${door.id}${expires}`).digest("hex"),
  );
  is("it does not start by itself, and goes on from where the student stopped", [src.searchParams.get("autoplay"), src.searchParams.get("rememberPosition")], ["false", "true"]);
  is("the studio is told it is ready", await streamStates([door.pathname, `stores/${FOLDER}/${LESSON}/a.mp4`]), { [door.pathname]: "ready" });
  is("a store page may frame that player", dynamicPolicy("n").includes(STREAM_PLAYER_ORIGIN), true);
  is("the studio, which shows no lesson, may not", /frame-src[^;]*mediadelivery/.test(dynamicPolicy("n", { store: false })), false);
  is("and the studio may send a video's pieces to the service", /connect-src[^;]*video\.bunnycdn\.com/.test(dynamicPolicy("n", { store: false })), true);

  part("How much a store keeps there is the service's own count");
  is("every size of every video", await streamHeld(FOLDER), 90_000_000);
  is("a store with nothing there keeps nothing", await streamHeld(OTHER_FOLDER), 0);
  const collectionKey=`nl:stream:col:${FOLDER}`;
  const collection=redis.run(["GET",collectionKey]);
  redis.run(["SET",collectionKey,"invalid-id"]);
  is("invalid collection reference is unknown, not empty",await streamHeld(FOLDER),null);
  if(typeof collection==="string") redis.run(["SET",collectionKey,collection]);
  service = "down";
  is("and a count that cannot be read is said to be unknown, not zero", await streamHeld(FOLDER), null);
  service = "up";

  part("A door nothing came through");
  if (!second.ok) return done();
  let counts = await sweep(Date.now() + 5_000, NOW + ABANDONED_AFTER_MS - MINUTE);
  is("is left alone for two days: an upload cut off may still go on", [counts.looked, videos.has(second.door.id)], [0, true]);
  // The browser sent every piece and then never told the lesson.
  videos.get(second.door.id)!.status = 4;
  counts = await sweep(Date.now() + 5_000, NOW + ABANDONED_AFTER_MS + 2 * MINUTE);
  is("then what was made for it is taken away at the service", videos.has(second.door.id), false);
  is("and here, whatever the service had made of it: no lesson has it", await streamRecord(second.door.pathname), null);
  is("the video a lesson has is not touched", videos.has(door.id), true);

  part("The service is busy, or not there");
  const third = await openUpload({ ...input, name: "Lesson three.mov", type: "video/quicktime" }, NOW);
  if (!third.ok) return done();
  service = "down";
  const kept = await claimUpload(third.door.pathname, FOLDER, LESSON, NOW + MINUTE);
  is("a lesson told its video while the service cannot be reached still has it", kept?.state, "working");
  service = "busy";
  counts = await sweep(Date.now() + 5_000, NOW + MINUTE + nextLook(MINUTE) + 1);
  is("the five-minute job asks, learns nothing, and changes nothing", [counts.looked, (await streamRecord(third.door.pathname))?.state], [1, "working"]);
  service = "up";
  videos.get(third.door.id)!.status = 5;
  counts = await sweep(Date.now() + 5_000, NOW + 2 * MINUTE + 2 * nextLook(MINUTE) + 2);
  is("when the service is back and says the file could not be read, the video has failed", [counts.failed, (await streamRecord(third.door.pathname))?.state], [1, "failed"]);
  is("what could not be made into a video is not kept there, or paid for", videos.has(third.door.id), false);
  is("a student is told it could not be prepared, and shown nothing", [(await playerFor(third.door.pathname, NOW))?.state, (await playerFor(third.door.pathname, NOW))?.src], ["failed", null]);

  part("A file the service never finishes");
  const fourth = await openUpload({ ...input, name: "Lesson four.webm", type: "video/webm" }, NOW);
  if (!fourth.ok) return done();
  videos.get(fourth.door.id)!.status = 2;
  await claimUpload(fourth.door.pathname, FOLDER, LESSON, NOW + MINUTE);
  await lookAt(fourth.door.id, NOW + GIVE_UP_AFTER_MS - MINUTE);
  is("is waited for, for a week", (await streamRecord(fourth.door.pathname))?.state, "working");
  await lookAt(fourth.door.id, NOW + GIVE_UP_AFTER_MS + MINUTE);
  is("and then given up on, so the creator is told to upload it again", (await streamRecord(fourth.door.pathname))?.state, "failed");

  part("A file far larger than the studio lets through");
  const huge = await openUpload({ ...input, name: "Not from the studio.mp4" }, NOW);
  if (!huge.ok) return done();
  Object.assign(videos.get(huge.door.id)!, { status: 4, availableResolutions: "1080p", storageSize: MOST_KEPT_BYTES + 1 });
  const refused = await claimUpload(huge.door.pathname, FOLDER, LESSON, NOW + MINUTE);
  is("is not kept, whatever the service made of it", [refused?.state, videos.has(huge.door.id)], ["failed", false]);

  part("A video that plays, and what the service says of it afterward");
  const playing = async (name: string) => {
    const one = await openUpload({ ...input, name }, NOW);
    if (!one.ok) throw new Error("no door");
    Object.assign(videos.get(one.door.id)!, { status: 3, availableResolutions: "240p", length: 60, width: 1280, height: 720, storageSize: 5_000_000 });
    const record = await claimUpload(one.door.pathname, FOLDER, LESSON, NOW + MINUTE);
    is(`${name}: told to the lesson with one size made, it plays`, [record?.state, record?.settled], ["ready", false]);
    return one.door;
  };
  const sixth = await playing("Lesson six.mp4");
  // A later size could not be made. The ones that play are still there.
  videos.get(sixth.id)!.status = 5;
  const worried = await lookAt(sixth.id, NOW + 20 * MINUTE);
  is("a later size that could not be made does not take away a video that plays", [worried?.state, videos.has(sixth.id)], ["ready", true]);
  is("and it is left alone from then on", worried?.settled, true);
  const seventh = await playing("Lesson seven.mp4");
  service = "down";
  is("the service not answering changes nothing about it", (await claimUpload(seventh.pathname, FOLDER, LESSON, NOW + 2 * MINUTE))?.state, "ready");
  service = "up";
  videos.delete(seventh.id);
  is("one that is no longer at the service is said to have failed, not shown as a player with nothing in it", (await lookAt(seventh.id, NOW + 20 * MINUTE))?.state, "failed");
  const eighth = await playing("Lesson eight.mp4");
  videos.get(eighth.id)!.storageSize = MOST_KEPT_BYTES + 1;
  const grown = await lookAt(eighth.id, NOW + 20 * MINUTE);
  is("one that grows past what may be kept, as its larger sizes are made, is not kept either", [grown?.state, videos.has(eighth.id)], ["failed", false]);
  const ninth = await playing("Lesson nine.mp4");
  const waited = await lookAt(ninth.id, NOW + GIVE_UP_AFTER_MS + MINUTE);
  is("one the service never says it has finished is asked about for a week, and then left as it is: playing", [waited?.state, waited?.settled], ["ready", true]);

  part("Captions a creator uploads");
  const SRT = "1\n00:00:01,000 --> 00:00:03,500\nWelcome to the course.\n\n2\n00:00:04,000 --> 00:00:06,000\nLet us begin.\n";
  let said = await addCaption(door.pathname, "en", SRT);
  is("a subtitle file is taken, and the video has captions in that language", said, { ok: true, captions: [{ lang: "en", label: "English" }] });
  is("what the service was sent is WebVTT made here, not the file as it came", captions.get(`${door.id}/en`), {
    label: "English",
    file: "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nWelcome to the course.\n\n00:00:04.000 --> 00:00:06.000\nLet us begin.\n",
  });
  said = await addCaption(door.pathname, "pt", "WEBVTT\n\n00:01.000 --> 00:03.000\nBem-vindo ao curso.\n");
  is("a second language sits beside the first, in the order the names are read in", said, { ok: true, captions: [{ lang: "en", label: "English" }, { lang: "pt", label: "Português" }] });
  await addCaption(door.pathname, "en", "WEBVTT\n\n00:01.000 --> 00:02.000\nWelcome, again.\n");
  is("a second file in a language takes the place of the first", [captions.get(`${door.id}/en`)?.file.includes("again"), (await streamCaptions([door.pathname]))[door.pathname]?.length], [true, 2]);
  is("the studio is told which videos have captions, and only those", Object.keys(await streamCaptions([door.pathname, sixth.pathname, `stores/${FOLDER}/${LESSON}/a.mp4`])), [door.pathname]);
  is("a file that is not captions is refused, and nothing is sent", [await addCaption(door.pathname, "fr", "Just some notes about the lesson."), captions.has(`${door.id}/fr`)], [{ ok: false, reason: "format" }, false]);
  is("so is one over the size a captions file may be", await addCaption(door.pathname, "fr", `WEBVTT\n\n00:01.000 --> 00:02.000\n${"a".repeat(MAX_CAPTION_BYTES)}\n`), { ok: false, reason: "too_big" });
  is("and a language that is not on the list", await addCaption(door.pathname, "xx", SRT), { ok: false, reason: "language" });
  is("a video that could not be made has none", await addCaption(third.door.pathname, "en", SRT), { ok: false, reason: "not_ready" });
  is("nor has a path nothing is known about", await addCaption(streamPath(FOLDER, LESSON, "00000000-0000-4000-8000-00000000ffff"), "en", SRT), { ok: false, reason: "unknown" });
  service = "down";
  is("with the service not there, the language is not listed: the player would not offer it", [await addCaption(door.pathname, "de", SRT), (await streamCaptions([door.pathname]))[door.pathname]?.length], [{ ok: false, reason: "unavailable" }, 2]);
  is("and one that cannot be taken away there stays listed here", [await dropCaption(door.pathname, "pt"), (await streamCaptions([door.pathname]))[door.pathname]?.length], [{ ok: false, reason: "unavailable" }, 2]);
  service = "up";
  for (const language of CAPTION_LANGUAGES.slice(0, MAX_CAPTION_TRACKS + 1)) await addCaption(door.pathname, language.code, SRT);
  const many = (await streamCaptions([door.pathname]))[door.pathname] ?? [];
  is(`a video holds captions in ${MAX_CAPTION_TRACKS} languages and no more`, [many.length, await addCaption(door.pathname, "zh", SRT)], [MAX_CAPTION_TRACKS, { ok: false, reason: "many" }]);
  is("though one of those it has can still be replaced", (await addCaption(door.pathname, "en", SRT)).ok, true);
  // The cap is read exactly (rule 24): HEXISTS and HLEN answered cut short or in another shape are not "room for one
  // more", so nothing is sent to the service for a language the video may not take.
  {
    const realPipeline = redis.pipeline;
    for (const [label, reply] of [
      ["no replies", []],
      ["one reply short", [0]],
      ["a count missing", [0, null]],
      ["a count as text", [0, "3"]],
      ["objects", [{}, {}]],
    ] as [string, unknown[]][]) {
      redis.pipeline = async (commands) => (commands.length === 2 && commands[0][0] === "HEXISTS" && commands[1][0] === "HLEN" ? reply : realPipeline(commands));
      const answer = await addCaption(door.pathname, "zh", SRT);
      redis.pipeline = realPipeline;
      is(`the cap read as ${label}: nothing sent to the service`, [answer, captions.has(`${door.id}/zh`)], [{ ok: false, reason: "unavailable" }, false]);
    }
  }
  said = await dropCaption(door.pathname, "pt");
  is("taken away, a language is gone from the service and from the list", [captions.has(`${door.id}/pt`), said.ok && said.captions.some((track) => track.lang === "pt")], [false, false]);

  part("A creator removes the video");
  is("a file in the file store is not this file's to delete", await dropStream(`stores/${FOLDER}/${LESSON}/lesson.mp4`), false);
  is("the video is taken away", await dropStream(door.pathname), true);
  is("at the service", videos.has(door.id), false);
  is("and here", await streamRecord(door.pathname), null);
  is("with the list of its captions", await streamCaptions([door.pathname]), {});
  is("a student who still has the page is shown nothing", await playerFor(door.pathname, NOW), null);
  const fifth = await openUpload(input, NOW);
  if (!fifth.ok) return done();
  service = "down";
  await dropStream(fifth.door.pathname);
  is("removed while the service cannot be reached, it is gone here at once", await streamRecord(fifth.door.pathname), null);
  is("and still there", videos.has(fifth.door.id), true);
  service = "up";
  counts = await sweep(Date.now() + 5_000, NOW + 10 * MINUTE);
  is("until the five-minute job tries again, so nothing is kept, and paid for, because of one bad minute", [counts.deleted, videos.has(fifth.door.id)], [1, false]);

  part("Deletion failures retain durable cleanup intent");
  const abandoned = await openUpload(input, NOW);
  const broken = await openUpload(input, NOW);
  if (!abandoned.ok || !broken.ok) throw new Error("no test door");
  videos.get(broken.door.id)!.status = 5;
  failDeletes = true;
  await lookAt(abandoned.door.id, NOW + ABANDONED_AFTER_MS + MINUTE);
  await claimUpload(broken.door.pathname, FOLDER, LESSON, NOW + MINUTE);
  is("an abandoned upload is detached locally", await streamRecord(abandoned.door.pathname), null);
  is("both failed deletions remain queued", (redis.run(["SMEMBERS", "nl:stream:gone"]) as string[]).sort(), [abandoned.door.id, broken.door.id].sort());
  is("both still exist at the provider", [videos.has(abandoned.door.id), videos.has(broken.door.id)], [true, true]);
  await sweep(Date.now() + 5_000, NOW + ABANDONED_AFTER_MS + 2 * MINUTE);
  is("a repeated outage retains both cleanup entries", (redis.run(["SMEMBERS", "nl:stream:gone"]) as string[]).length, 2);
  failDeletes = false;
  const recovered = await sweep(Date.now() + 5_000, NOW + ABANDONED_AFTER_MS + 3 * MINUTE);
  is("the job deletes both after provider recovery", recovered.deleted, 2);
  is("neither remains stored", [videos.has(abandoned.door.id), videos.has(broken.door.id)], [false, false]);
  is("confirmed deletion clears the queue", redis.run(["SMEMBERS", "nl:stream:gone"]), []);

  part("Unconfirmed cleanup persistence cannot discard a video");
  const uncertain = await openUpload(input, NOW);
  if (!uncertain.ok) throw new Error("no test door");
  const originalPipeline = redis.pipeline;
  redis.pipeline = async (commands) => commands.some((command) => command[0] === "SADD" && command[1] === "nl:stream:gone")
    ? [undefined]
    : originalPipeline(commands);
  const askedBeforeUnknownQueue = asked.length;
  let refusedCleanup = false;
  try {
    await dropStream(uncertain.door.pathname);
  } catch {
    refusedCleanup = true;
  } finally {
    redis.pipeline = originalPipeline;
  }
  is("unconfirmed queue persistence refuses cleanup", refusedCleanup, true);
  is("the video remains discoverable locally", (await streamRecord(uncertain.door.pathname))?.id, uncertain.door.id);
  is("no provider deletion was attempted", asked.length, askedBeforeUnknownQueue);
  await dropStream(uncertain.door.pathname);

  part("A new upload needs confirmed tracking before receiving its signature");
  redis.pipeline = async (commands) => {
    const result = await originalPipeline(commands);
    return commands.some((command) => command[0] === "SET" && String(command[1]).startsWith("nl:stream:v:"))
      ? [undefined, undefined] : result;
  };
  const storedBeforeUnconfirmedDoor = videos.size;
  let unconfirmedDoor;
  try {
    unconfirmedDoor = await openUpload(input, NOW);
  } finally {
    redis.pipeline = originalPipeline;
  }
  is("missing tracking acknowledgement never publishes an upload signature", unconfirmedDoor, { ok: false, reason: "unavailable" });
  is("the empty provider video is removed", videos.size, storedBeforeUnconfirmedDoor);

  part("A new manual caption is bound to its funded owner before provider work");
  await claimHandle("funded-caption@example.com", "funded-caption-shop", "Funded Caption Shop", "");
  await ensureStatsId("funded-caption@example.com");
  const captionPeriod = paidPeriod();
  await setSubscription("funded-caption@example.com", { customerId: "cus_CaptionFund001", subscriptionId: "sub_CaptionFund001", active: true, period: captionPeriod });
  const captionOwner = (await storeForEmail("funded-caption@example.com"))!;
  const captionFolder = await storeFolder("funded-caption@example.com");
  const captionDoor = await openUpload({ ...input, folder: captionFolder }, NOW);
  if (!captionDoor.ok) throw new Error("no synthetic caption door");
  videos.get(captionDoor.door.id)!.status = 1;
  await claimUpload(captionDoor.door.pathname, captionFolder, LESSON, NOW);
  is("the owner wrapper still adds captions on an unmarked period", (await addStoreCaption(captionOwner, captionDoor.door.pathname, "en", SRT)).ok, true);
  await setSubscription("funded-caption@example.com", { active: true, period: { ...captionPeriod, funded: true } });
  const fundedCaptionOwner = (await storeForEmail("funded-caption@example.com"))!;
  const captionRequests = asked.length;
  const originalCaption = captions.get(`${captionDoor.door.id}/en`)?.file;
  is("a new manual caption needs financial approval", await addStoreCaption(fundedCaptionOwner, captionDoor.door.pathname, "en", "WEBVTT\n\n00:01.000 --> 00:02.000\nChanged.\n"), { ok: false, reason: "unavailable" });
  is("a foreign video's folder is refused", await addStoreCaption(fundedCaptionOwner, door.pathname, "en", SRT), { ok: false, reason: "unknown" });
  is("no provider request or caption replacement", [asked.length, captions.get(`${captionDoor.door.id}/en`)?.file], [captionRequests, originalCaption]);
  is("the existing caption can still be removed", (await dropCaption(captionDoor.door.pathname, "en")).ok, true);
  is("the existing language is gone after provider cleanup", captions.has(`${captionDoor.door.id}/en`), false);
  await dropStream(captionDoor.door.pathname);

  part("The announcements' address does not exist without the key they are signed with");
  delete process.env.BUNNY_STREAM_READ_KEY;
  is("not found", (await announce(announcement)).status, 404);

  // The peek at the service is held for thirty seconds by the store's own clock.
  advance(31_000);
  void redis;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
