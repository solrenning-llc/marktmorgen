/**
 * Lesson video that plays the way a video site plays it: the service.
 *
 * lib/stream-rules.ts says why a lesson's video is kept in several sizes.
 * Making and serving them is Bunny Stream's job (bunny.net). It was chosen
 * on October 6, 2026 against the two others a site like this would use,
 * from each one's own price page that day:
 *
 *   Bunny Stream       turning a file into its sizes is free; keeping them
 *                      is $0.01 a gigabyte a month in each region they are
 *                      kept in; sending them is $0.005 a gigabyte on its
 *                      volume network, $0.01 on its standard one in Europe
 *                      and North America
 *   Cloudflare Stream  $5 a month for each 1,000 minutes kept, $1 for each
 *                      1,000 minutes watched
 *   Mux                $0.0024 a minute a month kept, $0.0008 to $0.001 a
 *                      minute watched
 *
 * A course is watched by the hour. A thousand minutes of video at the
 * tallest size kept here is about forty gigabytes: forty cents sent by the
 * first, a dollar by either of the others. What decides whether a $29 store
 * pays for itself is that line, so it was the one compared; what a plan
 * covers of it, and what is charged past that, is in lib/watch-rules.ts.
 *
 * How a video gets there, and what is kept here about it:
 *
 *   1. The studio asks for a door (app/api/store/stream). A video is made
 *      at the service, empty, in the store's own collection, and the browser
 *      is handed a signature good for that one video for a day. The file
 *      goes from the browser straight to the service, in pieces, and an
 *      upload cut off halfway goes on from where it stopped
 *      (lib/tus-upload.ts). It never passes through this site.
 *   2. The lesson is told its video (app/api/store/course), by the path
 *      `stream/<folder>/<lesson>/<id>`. Nothing typed by the browser is
 *      believed: the path has to be the one this file wrote down when it
 *      opened the door, for that store and that lesson.
 *   3. The service turns the file into its sizes. It says when one is
 *      done (app/api/stream/hook), and it is asked every few minutes in any
 *      case (app/api/cron/stream), so nothing depends on an announcement
 *      arriving.
 *   4. A student's lesson page frames the service's player, with a token
 *      made here for that video, good for a few hours. Without one the
 *      player shows nothing, so the address of a lesson's video is worth
 *      nothing to somebody who did not buy the course.
 *
 * The library, as it was set up on October 6, 2026, and what this file
 * counts on it being:
 *
 *   - files kept in two regions, Frankfurt and New York ($0.02 a gigabyte a
 *     month together), sent over the volume network ($0.005 a gigabyte);
 *   - sizes from 240p to 1080p, made by the free encoder, which finishes
 *     when it finishes: until the first size is done the lesson page says
 *     the video is being prepared;
 *   - "direct play" off, and both token authentications on, the player's
 *     and the files': a video plays only in a player given a token made
 *     here. The service's own encryption of the files ("MediaCage Basic")
 *     cannot be on at the same time as token authentication, by the
 *     service's rule, and the token is the one that says who bought.
 *   - the player goes on from where a viewer stopped.
 *
 * Nothing here runs until the four settings are there:
 *
 *   BUNNY_STREAM_LIBRARY_ID  the library's number
 *   BUNNY_STREAM_API_KEY     the library's own key, which makes and deletes
 *   BUNNY_STREAM_TOKEN_KEY   the key a player's token is made with
 *   BUNNY_STREAM_READ_KEY    the library's read-only key: the service signs
 *                            its announcements with it. Optional; without it
 *                            announcements are not believed, and step 3 is
 *                            the asking alone.
 *
 * Without them a lesson's video is what it was before: the file as
 * uploaded, in the private store, played from a signed link (lib/learn.ts).
 * A video uploaded that way goes on playing that way.
 *
 *   nl:stream:v:<id>      what is known about one video
 *   nl:stream:due         which videos to ask the service about, and when
 *   nl:stream:col:<folder> the store's collection at the service
 *   nl:stream:gone        videos to delete there that could not be reached
 *   nl:stream:peek:<id>   a student's page asked about this one just now
 *   nl:stream:cap:<id>    the languages a video has captions in
 *
 * How long a store's videos have been watched is read from the service too
 * (streamWatched), and what is done with it is in lib/watch.ts.
 */
import { VIDEO_RECORD_BYTES } from "@/lib/stream-rules";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { STREAM_PEEK_TIMEOUT_MS, STREAM_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { type DataStore, giveData } from "@/lib/store-data";
import { type CaptionProblem, type CaptionTrack, MAX_CAPTION_TRACKS, captionLabel, toVtt } from "@/lib/captions";
import {
  ABANDONED_AFTER_MS,
  GIVE_UP_AFTER_MS,
  MOST_KEPT_BYTES,
  STREAM_API_ORIGIN,
  STREAM_ID_PATTERN,
  STREAM_PLAYER_ORIGIN,
  type StreamState,
  UPLOAD_WINDOW_SECONDS,
  nextLook,
  readStreamPath,
  shapeOf,
  stateFrom,
  streamPath,
} from "@/lib/stream-rules";

const API = STREAM_API_ORIGIN;
/** Where the browser sends a video's pieces. */
export const UPLOAD_ENDPOINT = `${API}/tusupload`;
/** How long a player's token is good for: a long lesson, watched with breaks. */
export const PLAYER_SECONDS = 4 * 60 * 60;

type Config = { library: string; key: string; tokenKey: string; readKey: string };

export function streamConfig(): Config | null {
  const library = (process.env.BUNNY_STREAM_LIBRARY_ID ?? "").trim();
  const key = (process.env.BUNNY_STREAM_API_KEY ?? "").trim();
  const tokenKey = (process.env.BUNNY_STREAM_TOKEN_KEY ?? "").trim();
  const readKey = (process.env.BUNNY_STREAM_READ_KEY ?? "").trim();
  // The token key is not optional: a library without one plays any video to
  // anybody who has its id.
  if (!/^\d{1,12}$/.test(library) || key.length < 20 || tokenKey.length < 20) return null;
  return { library, key, tokenKey, readKey };
}

export function isStreamConfigured(): boolean {
  return streamConfig() !== null && isRedisConfigured();
}

/** What is known about one video. */
export type StreamRecord = {
  id: string;
  /** The path the lesson keeps for it (lib/stream-rules.ts). */
  path: string;
  /** What the creator called the file. */
  name: string;
  type: string;
  /** The file's size as the studio gave it, then the service's own figure for all it keeps. */
  bytes: number;
  state: StreamState;
  /** When the door was opened, in ms. */
  at: number;
  /** Its length, and the shape it plays in. Zero until the service has read the file. */
  seconds: number;
  width: number;
  height: number;
  /**
   * Nothing more is to be learned about it. A video is ready from its first
   * size, which the service may have before it has measured the file or made
   * the rest; it is settled when the service says it has finished.
   */
  settled: boolean;
};

const recordKey = (id: string) => `nl:stream:v:${id}`;
const collectionKey = (folder: string) => `nl:stream:col:${folder}`;
const peekKey = (id: string) => `nl:stream:peek:${id}`;
const captionsKey = (id: string) => `nl:stream:cap:${id}`;
const DUE = "nl:stream:due";
const GONE = "nl:stream:gone";

/** Persist deletion intent before contacting the provider or forgetting local records. */
async function removeProviderVideo(config: Config, id: string, ms = STREAM_TIMEOUT_MS): Promise<void> {
  const [queued] = await redisPipeline([["SADD", GONE, id]]);
  if (queued !== 0 && queued !== 1) throw new Error("Video deletion could not be queued");
  const answer = await ask(config, "DELETE", `/videos/${id}`, undefined, ms);
  if (answer.status === 200 || answer.status === 404) await redisPipeline([["SREM", GONE, id]]);
}

function parseRecord(raw: unknown): StreamRecord | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<StreamRecord>;
    if (typeof value.id !== "string" || !STREAM_ID_PATTERN.test(value.id)) return null;
    if (typeof value.path !== "string" || readStreamPath(value.path)?.id !== value.id) return null;
    const state = value.state;
    if (state !== "upload" && state !== "working" && state !== "ready" && state !== "failed") return null;
    const number = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
    return {
      id: value.id,
      path: value.path,
      name: typeof value.name === "string" && value.name ? value.name : "video",
      type: typeof value.type === "string" ? value.type : "",
      bytes: number(value.bytes),
      state,
      at: number(value.at),
      seconds: number(value.seconds),
      width: number(value.width),
      height: number(value.height),
      settled: value.settled === true,
    };
  } catch {
    return null;
  }
}

/** What is known about the video a path names; null for any other path, or one nothing is known about. */
export async function streamRecord(pathname: string): Promise<StreamRecord | null> {
  const parts = readStreamPath(pathname);
  if (!parts || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", recordKey(parts.id)]]);
  const record = parseRecord(raw);
  return record && record.path === pathname ? record : null;
}

/** Where each of these videos stands, by its path, for the studio to say. Paths nothing is known about are left out. */
export async function streamStates(pathnames: string[]): Promise<Record<string, StreamState>> {
  const wanted = pathnames.flatMap((path) => {
    const parts = readStreamPath(path);
    return parts ? [{ path, id: parts.id }] : [];
  });
  if (!wanted.length || !isRedisConfigured()) return {};
  const rows = await redisPipeline(wanted.map(({ id }) => ["GET", recordKey(id)]));
  const out: Record<string, StreamState> = {};
  wanted.forEach(({ path }, i) => {
    const record = parseRecord(rows[i]);
    if (record && record.path === path) out[path] = record.state;
  });
  return out;
}

type Answer = { status: number; data: unknown };

/** One question to the service. A status of 0 is a service that could not be reached. */
async function ask(config: Config, method: string, path: string, body?: unknown, ms = STREAM_TIMEOUT_MS): Promise<Answer> {
  try {
    return await timed(ms, async (signal) => {
      const response = await fetch(`${API}/library/${config.library}${path}`, {
        method,
        headers: { AccessKey: config.key, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        cache: "no-store",
      });
      const text = await response.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      return { status: response.status, data };
    });
  } catch {
    return { status: 0, data: null };
  }
}

const field = (data: unknown, name: string): unknown => (data && typeof data === "object" ? (data as Record<string, unknown>)[name] : undefined);

/**
 * The store's own collection at the service, made the first time it is
 * needed. A store's videos are kept together so that how much it holds can
 * be read from the service itself (streamHeld), which cannot drift the way
 * a count kept here would.
 */
async function collectionFor(config: Config, folder: string): Promise<string | null> {
  const [known] = await redisPipeline([["GET", collectionKey(folder)]]);
  if (typeof known === "string" && STREAM_ID_PATTERN.test(known)) return known;
  const made = await ask(config, "POST", "/collections", { name: folder });
  const id = field(made.data, "guid");
  if (made.status !== 200 || typeof id !== "string" || !STREAM_ID_PATTERN.test(id)) return null;
  // Two uploads starting at once would each make one: the first written is
  // kept, and the other is taken away again. Read exactly (CX-123 rule 24):
  // "OK" is ours and nil is the other's; any other answer is read back, and
  // ours is used only when the key holds it.
  const first = await redisPipeline([["SET", collectionKey(folder), id, "NX"]]).then(
    (reply) => repliesFor(reply, 1),
    () => null,
  );
  if (first && first[0] === "OK") return id;
  const lost = first !== null && first[0] === null;
  if (lost) await ask(config, "DELETE", `/collections/${id}`);
  const read = await redisPipeline([["GET", collectionKey(folder)]]).then(
    (reply) => repliesFor(reply, 1),
    () => null,
  );
  const kept = read ? read[0] : undefined;
  if (kept === id) return id;
  if (typeof kept !== "string" || !STREAM_ID_PATTERN.test(kept)) {
    // Unreadable: no upload now. Ours is kept when it may be the one written;
    // nothing is put in it while that cannot be told.
    return null;
  }
  // Another upload's is the one kept: ours goes, if it has not gone already.
  if (!lost) await ask(config, "DELETE", `/collections/${id}`);
  return kept;
}

/**
 * How many bytes the service keeps for a store, by its own count: every
 * size of every video, and the files as they were uploaded. Null when it
 * cannot be read.
 */
export async function streamHeld(folder: string): Promise<number | null> {
  if (!isRedisConfigured()) return null;
  const [known] = await redisPipeline([["GET", collectionKey(folder)]]);
  if (known === null) return 0;
  const config = streamConfig();
  if (!config || typeof known !== "string" || !STREAM_ID_PATTERN.test(known)) return null;
  const answer = await ask(config, "GET", "/collections/" + known);
  if (answer.status === 404) return 0;
  const size = field(answer.data, "totalSize");
  return answer.status === 200 && typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : null;
}

/** How many pages of a store's videos are read: a thousand to a page. */
const WATCH_PAGES = 20;

/**
 * How long each of a store's videos has been watched, in seconds, since it
 * was put there: the service's own count, kept by its player. Null when it
 * cannot be read, which is not the same as nothing watched.
 *
 * Read a store at a time, from the list of its collection, so a store with
 * three hundred lessons is one question and not three hundred. What a plan
 * covers and what is charged past it are worked out from this
 * (lib/watch.ts): time watched, which no page view of ours can inflate.
 */
export async function streamWatched(folder: string): Promise<{ id: string; seconds: number }[] | null> {
  if (!isRedisConfigured()) return null;
  const [known] = await redisPipeline([["GET", collectionKey(folder)]]);
  if (known === null) return [];
  const config = streamConfig();
  if (!config || typeof known !== "string" || !STREAM_ID_PATTERN.test(known)) return null;
  const out: { id: string; seconds: number }[] = [];
  const seen = new Set<string>();
  let expected: number | undefined;
  let pageSize: number | undefined;
  for (let page = 1; page <= WATCH_PAGES; page += 1) {
    const answer = await ask(config, "GET", "/videos?collection=" + known + "&page=" + page + "&itemsPerPage=1000&orderBy=date");
    const items = field(answer.data, "items");
    const total = field(answer.data, "totalItems");
    const currentPage = field(answer.data, "currentPage");
    const declaredSize = field(answer.data, "itemsPerPage");
    const size = declaredSize === undefined ? 1000 : declaredSize;
    if (answer.status !== 200 || !Array.isArray(items) ||
      typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 ||
      typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > 1000 ||
      (currentPage !== undefined && currentPage !== page) ||
      (expected !== undefined && expected !== total) ||
      (pageSize !== undefined && pageSize !== size) || items.length > size) return null;
    expected = total;
    pageSize = size;
    for (const item of items) {
      const id = field(item, "guid");
      const seconds = field(item, "totalWatchTime");
      if (typeof id !== "string" || !STREAM_ID_PATTERN.test(id.toLowerCase()) ||
        field(item, "collectionId") !== known ||
        typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 0) return null;
      const normalized = id.toLowerCase();
      if (seen.has(normalized)) return null;
      seen.add(normalized);
      out.push({ id: normalized, seconds });
    }
    if (out.length > total) return null;
    if (out.length === total) return out;
    if (items.length < size) return null;
  }
  // A bounded scan that did not reach the declared total is unavailable.
  return null;
}

/**
 * Takes away every video a store has at the service, the ones no lesson
 * names any more among them, and forgets them here. Answers how many went;
 * null when the service could not be read, and then nothing was touched.
 *
 * For a store whose plan ended long enough ago that what it keeps is
 * removed (lib/plan-closing.ts). One the service could not delete just now
 * is kept in line, as a single video is (dropStream). Past `until` it stops
 * and answers null as well: a store with hundreds of videos is more than
 * one run can take away.
 */
export async function dropAllStreams(folder: string, until = Number.POSITIVE_INFINITY): Promise<number | null> {
  const videos = await streamWatched(folder);
  if (videos === null) return null;
  if (!videos.length) return 0;
  const config = streamConfig();
  if (!config) return null;
  for (const { id } of videos) {
    // Out of time: not seen through, and said so. The rest is there to be
    // listed the next time.
    if (Date.now() > until) return null;
    await removeProviderVideo(config, id);
    await redisPipeline([["DEL", recordKey(id), captionsKey(id)], ["ZREM", DUE, id]]);
  }
  return videos.length;
}

export type UploadDoor = {
  /** Where the pieces go, and the four values the service wants with each of them. */
  endpoint: string;
  library: string;
  id: string;
  expires: number;
  signature: string;
  /** The path to give the lesson once the last piece is in. */
  pathname: string;
};

/**
 * Opens the door for one video of one lesson.
 *
 * The signature is the service's own recipe (its "TUS resumable uploads"
 * page): SHA-256 of the library, the library's key, the hour it stops being
 * good and the video's id, in that order with nothing between. It lets its
 * holder send that one video and nothing else.
 */
export async function openUpload(
  input: { folder: string; lessonId: string; name: string; bytes: number; type: string },
  now = Date.now(),
): Promise<{ ok: true; door: UploadDoor } | { ok: false; reason: "off" | "unavailable" }> {
  const config = streamConfig();
  if (!config || !isRedisConfigured()) return { ok: false, reason: "off" };
  const collection = await collectionFor(config, input.folder);
  if (!collection) return { ok: false, reason: "unavailable" };
  const made = await ask(config, "POST", "/videos", { title: `${input.folder}/${input.lessonId}`, collectionId: collection });
  const id = field(made.data, "guid");
  if (made.status !== 200 || typeof id !== "string" || !STREAM_ID_PATTERN.test(id)) return { ok: false, reason: "unavailable" };

  const pathname = streamPath(input.folder, input.lessonId, id);
  if (!readStreamPath(pathname)) {
    await removeProviderVideo(config, id);
    return { ok: false, reason: "unavailable" };
  }
  const record: StreamRecord = {
    id,
    path: pathname,
    name: input.name,
    type: input.type,
    bytes: input.bytes,
    state: "upload",
    at: now,
    seconds: 0,
    width: 0,
    height: 0,
    settled: false,
  };
  const [saved, scheduled] = await redisPipeline([
    ["SET", recordKey(id), JSON.stringify(record)],
    // Looked at again only to be taken away, if no lesson is told of it.
    ["ZADD", DUE, now + ABANDONED_AFTER_MS + 60_000, id],
  ]);
  if (saved !== "OK" || (scheduled !== 0 && scheduled !== 1)) {
    await removeProviderVideo(config, id);
    return { ok: false, reason: "unavailable" };
  }
  const expires = Math.floor(now / 1000) + UPLOAD_WINDOW_SECONDS;
  const signature = createHash("sha256").update(`${config.library}${config.key}${expires}${id}`).digest("hex");
  return { ok: true, door: { endpoint: UPLOAD_ENDPOINT, library: config.library, id, expires, signature, pathname } };
}

/**
 * Asks the service about one video and writes down what it says. Returns
 * the record as it stands afterward; null when there is none.
 *
 * This is the only place a video's state changes, whoever is asking: the
 * lesson being told its video (`claim`), the service's announcement, the
 * five-minute job, a student's page waiting on one.
 *
 * A video no lesson has been told yet stays as it is, "upload", whatever the
 * service says of it: the browser may have sent every piece and then failed
 * to tell the lesson, and a video nobody can reach is not one to keep. Two
 * days after its door was opened it is taken away. Once a lesson has it, it
 * is never taken away from here: it works, is ready, or has failed.
 *
 * Ready is not the end of it. The service says a video can be played as soon
 * as its smallest size is made, and that may be before it has written down
 * the file's length and shape, and is before the larger sizes exist. So a
 * ready video is asked about until the service says it has finished, and
 * only then left alone; until then its length, its shape and what it weighs
 * are filled in as they come. One that plays is never un-readied by a later
 * word about the sizes still being made: only its being gone from the
 * service, or its growing past what may be kept, takes it away.
 */
export async function lookAt(id: string, now = Date.now(), ms = STREAM_TIMEOUT_MS, claim = false): Promise<StreamRecord | null> {
  const config = streamConfig();
  if (!config || !isRedisConfigured() || !STREAM_ID_PATTERN.test(id)) return null;
  const [raw] = await redisPipeline([["GET", recordKey(id)]]);
  const record = parseRecord(raw);
  if (!record) {
    await redisPipeline([["ZREM", DUE, id]]);
    return null;
  }
  if (record.state === "failed" || (record.state === "ready" && record.settled)) {
    await redisPipeline([["ZREM", DUE, id]]);
    return record;
  }
  const played = record.state === "ready";
  const age = now - record.at;
  const unclaimed = record.state === "upload" && !claim;
  if (unclaimed && age <= ABANDONED_AFTER_MS) {
    await redisPipeline([["ZADD", DUE, record.at + ABANDONED_AFTER_MS + 60_000, id]]);
    return record;
  }
  if (unclaimed) {
    await removeProviderVideo(config, id, ms);
    await redisPipeline([["DEL", recordKey(id), captionsKey(id)], ["ZREM", DUE, id]]);
    return null;
  }

  const answer = await ask(config, "GET", `/videos/${id}`, undefined, ms);
  if (answer.status !== 200 && answer.status !== 404) {
    // Not reached, or busy: nothing is learned. A lesson being told its
    // video still has it written down as its own, to be asked about later.
    const taken = claim && !played;
    const kept: StreamRecord = taken ? { ...record, state: "working" } : record;
    await redisPipeline([
      ...(taken ? [["SET", recordKey(id), JSON.stringify(kept)]] : []),
      ["ZADD", DUE, now + nextLook(age), id],
    ]);
    return kept;
  }

  const status = field(answer.data, "status");
  const sizes = field(answer.data, "availableResolutions");
  const said: StreamState =
    answer.status === 404
      ? "failed"
      : stateFrom({ status: typeof status === "number" ? status : -1, availableResolutions: typeof sizes === "string" ? sizes : "" });
  // The service still waiting for the file, of a video a lesson has: the
  // last piece is in and it has not caught up, or it never will. Time tells.
  let state: StreamState = said === "upload" ? "working" : said;
  if (played && answer.status === 200) state = "ready";
  if (state === "working" && age > GIVE_UP_AFTER_MS) state = "failed";
  const kept = field(answer.data, "storageSize");
  if (typeof kept === "number" && kept > MOST_KEPT_BYTES) state = "failed";
  // Finished by the service's own word; or it played and the service now
  // says something else of it, or has said nothing new for a week: there is
  // nothing more to wait for.
  const settled = state === "ready" && (status === 4 || (played && said !== "ready") || age > GIVE_UP_AFTER_MS);

  const number = (name: string) => {
    const value = field(answer.data, name);
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  };
  const rotation = field(answer.data, "rotation");
  const shape = shapeOf(number("width"), number("height"), typeof rotation === "number" ? rotation : null);
  const next: StreamRecord = {
    ...record,
    state,
    settled,
    seconds: number("length") || record.seconds,
    width: number("width") ? shape.width : record.width,
    height: number("height") ? shape.height : record.height,
    bytes: number("storageSize") || record.bytes,
  };
  if (state === "failed" && answer.status !== 404) {
    // What could not be made into a video is not kept, or paid for.
    await removeProviderVideo(config, id, ms);
  }
  await redisPipeline([
    ["SET", recordKey(id), JSON.stringify(next)],
    state === "failed" || settled ? ["ZREM", DUE, id] : ["ZADD", DUE, now + nextLook(age), id],
  ]);
  return next;
}

/**
 * The record a lesson may take as its video: the one this file wrote when it
 * opened the door for that store and that lesson, and nothing else. Looked
 * at once on the way, so a short video is often playable by the time the
 * studio has drawn the lesson again.
 */
export async function claimUpload(pathname: string, folder: string, lessonId: string, now = Date.now()): Promise<StreamRecord | null> {
  const parts = readStreamPath(pathname);
  if (!parts || parts.folder !== folder || parts.lessonId !== lessonId) return null;
  const record = await streamRecord(pathname);
  if (!record) return null;
  return lookAt(record.id, now, STREAM_TIMEOUT_MS, true);
}

/**
 * Whether an announcement is the service's own (its "Webhooks" page): the
 * version and the algorithm it names, and an HMAC-SHA256 of the body exactly
 * as it arrived, keyed with the library's read-only key, in lower-case hex.
 */
export function believed(rawBody: string, headers: { version: string | null; algorithm: string | null; signature: string | null }, readKey: string): boolean {
  if (!readKey || headers.version !== "v1" || headers.algorithm !== "hmac-sha256") return false;
  const given = headers.signature ?? "";
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = createHmac("sha256", readKey).update(rawBody, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(given, "utf8"));
}

/**
 * The service's announcement that something happened to a video. Nothing in
 * it is taken as fact: it names a video, and the service is asked about that
 * video (lookAt). "ignored" is a video that is not one of ours.
 */
export async function heard(body: unknown, now = Date.now()): Promise<"looked" | "ignored"> {
  const config = streamConfig();
  if (!config) return "ignored";
  const library = field(body, "VideoLibraryId");
  const id = field(body, "VideoGuid");
  if (String(library) !== config.library || typeof id !== "string" || !STREAM_ID_PATTERN.test(id.toLowerCase())) return "ignored";
  return (await lookAt(id.toLowerCase(), now)) ? "looked" : "ignored";
}

export type Player = {
  state: StreamState;
  /** The address to frame, when there is something to play. */
  src: string | null;
  width: number;
  height: number;
  record: StreamRecord;
};

/**
 * The player for a lesson's video, for somebody who may watch it. The
 * caller has already decided that; nothing here does.
 *
 * The token is the service's own recipe (its "Token authentication" page):
 * SHA-256 of the token key, the video's id and the second it stops being
 * good, in that order with nothing between.
 *
 * A video still being prepared is asked about on the way, at most once in
 * thirty seconds whoever is waiting, so the first student to open a lesson
 * is not the one who has to wait for the five-minute job. So is one that
 * plays and has not been measured yet, so it is not shown in a shape that is
 * not its own for longer than that.
 */
export async function playerFor(pathname: string, now = Date.now()): Promise<Player | null> {
  const config = streamConfig();
  if (!config) return null;
  let record = await streamRecord(pathname);
  if (!record) return null;
  const unmeasured = record.state === "ready" && !record.settled && !(record.width > 0 && record.height > 0);
  if (record.state === "working" || unmeasured) {
    const receipt = await redisPipeline([["SET", peekKey(record.id), "1", "NX", "EX", 30]]);
    // Only a confirmed cooldown claim authorizes a provider request.
    if (Array.isArray(receipt) && receipt.length === 1 && receipt[0] === "OK") {
      record = (await lookAt(record.id, now, STREAM_PEEK_TIMEOUT_MS)) ?? record;
    }
  }
  const shape = shapeOf(record.width, record.height, null);
  if (record.state !== "ready") return { state: record.state, src: null, ...shape, record };
  const expires = Math.floor(now / 1000) + PLAYER_SECONDS;
  const token = createHash("sha256").update(`${config.tokenKey}${record.id}${expires}`).digest("hex");
  const query = new URLSearchParams({
    token,
    expires: String(expires),
    autoplay: "false",
    preload: "true",
    playsinline: "true",
    showSpeed: "true",
    rememberPosition: "true",
  });
  return { state: "ready", src: `${STREAM_PLAYER_ORIGIN}/embed/${config.library}/${record.id}?${query}`, ...shape, record };
}

/**
 * Takes a video away, at the service and here. For a path that is not one
 * of these it does nothing and says so, so a caller with a mixed list of
 * files can ask about each.
 *
 * A service that cannot be reached is not waited for: the id is kept, and
 * the five-minute job goes on trying, so a deleted lesson's video is not
 * kept, and paid for, because of one bad minute.
 */


export async function dropStream(pathname: string, room?: DataStore): Promise<boolean> {
  const parts = readStreamPath(pathname);
  if (!parts) return false;
  if (room) await giveData(room, [{ slot: "sv", bytes: VIDEO_RECORD_BYTES }]);
  if (!isRedisConfigured()) return true;
  const config = streamConfig();
  if (config) await removeProviderVideo(config, parts.id);
  else {
    const [queued] = await redisPipeline([["SADD", GONE, parts.id]]);
    if (queued !== 0 && queued !== 1) throw new Error("Video deletion could not be queued");
  }
  await redisPipeline([["DEL", recordKey(parts.id), captionsKey(parts.id)], ["ZREM", DUE, parts.id]]);
  return true;
}

function tracksFrom(flat: unknown): CaptionTrack[] {
  const out: CaptionTrack[] = [];
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const lang = flat[i];
    const label = typeof lang === "string" ? captionLabel(lang) : null;
    if (typeof lang === "string" && label) out.push({ lang, label });
  }
  // In the order the languages are offered in, so the list does not jump about.
  return out.sort((a, b) => a.label.localeCompare(b.label, "en"));
}

function exactTracksFrom(flat: unknown): CaptionTrack[] | null {
  const fields = stringList(flat);
  if (!fields || fields.length % 2 !== 0) return null;
  const out: CaptionTrack[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const lang = fields[i];
    const label = captionLabel(lang);
    if (!label) return null;
    out.push({ lang, label });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, "en"));
}

/**
 * One request to the video service about this library, for the captions it
 * writes itself (lib/auto-captions.ts). `status` 0 when it was not reached,
 * or nothing here is set up.
 */
export async function askStream(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const config = streamConfig();
  if (!config) return { status: 0, data: null };
  return ask(config, method, path, body);
}

/** Writes down languages the service now has captions in for a video, so the studio and the lesson list them. */
export async function noteCaptionLanguages(id: string, langs: string[]): Promise<void> {
  const known = langs.flatMap((lang) => {
    const label = captionLabel(lang);
    return label ? [lang, label] : [];
  });
  if (!known.length || !isRedisConfigured() || !STREAM_ID_PATTERN.test(id)) return;
  await redisPipeline([["HSET", captionsKey(id), ...known]]);
}

/** The languages each of these videos has captions in, by its path. Videos with none are left out. */
export async function streamCaptions(pathnames: string[]): Promise<Record<string, CaptionTrack[]>> {
  const wanted = pathnames.flatMap((path) => {
    const parts = readStreamPath(path);
    return parts ? [{ path, id: parts.id }] : [];
  });
  if (!wanted.length || !isRedisConfigured()) return {};
  const rows = repliesFor(
    await redisPipeline(wanted.map(({ id }) => ["HGETALL", captionsKey(id)])),
    wanted.length,
  );
  if (!rows) throw new UnknownReplyError("stored captions");
  const out: Record<string, CaptionTrack[]> = {};
  wanted.forEach(({ path }, i) => {
    // Fail the whole read if any video's stored language is unsupported.
    // A stale/unknown language is not evidence of an empty caption list;
    // callers must not act on a partial batch as if it were complete.
    const tracks = exactTracksFrom(rows[i]);
    if (!tracks) throw new UnknownReplyError("stored captions");
    if (tracks.length) out[path] = tracks;
  });
  return out;
}

export type CaptionAnswer =
  | { ok: true; captions: CaptionTrack[] }
  | { ok: false; reason: CaptionProblem | "off" | "unknown" | "language" | "many" | "not_ready" | "unavailable" };

/**
 * Gives a lesson's video captions in one language, from a file the creator
 * wrote or had written (lib/captions.ts). A second file in the same
 * language takes the place of the first.
 *
 * What goes to the service is the WebVTT made here from the file, never the
 * file itself. The language is written down only once the service has said
 * it took the captions, so the studio never lists a language the player
 * does not offer.
 */
export async function addCaption(pathname: string, lang: string, file: unknown): Promise<CaptionAnswer> {
  const config = streamConfig();
  if (!config || !isRedisConfigured()) return { ok: false, reason: "off" };
  const label = captionLabel(lang);
  if (!label) return { ok: false, reason: "language" };
  const record = await streamRecord(pathname);
  if (!record) return { ok: false, reason: "unknown" };
  // The service has no video to put captions on until the file is there.
  if (record.state !== "ready" && record.state !== "working") return { ok: false, reason: "not_ready" };
  const read = toVtt(file);
  if (!read.ok) return { ok: false, reason: read.reason };

  const [has, count] = await redisPipeline([
    ["HEXISTS", captionsKey(record.id), lang],
    ["HLEN", captionsKey(record.id)],
  ]);
  if (Number(has) !== 1 && Number(count) >= MAX_CAPTION_TRACKS) return { ok: false, reason: "many" };

  const answer = await ask(config, "POST", `/videos/${record.id}/captions/${lang}`, {
    srclang: lang,
    label,
    captionsFile: Buffer.from(read.vtt, "utf8").toString("base64"),
  });
  if (answer.status === 400) return { ok: false, reason: "format" };
  if (answer.status === 404) return { ok: false, reason: "not_ready" };
  if (answer.status !== 200) return { ok: false, reason: "unavailable" };
  const [, flat] = await redisPipeline([
    ["HSET", captionsKey(record.id), lang, label],
    ["HGETALL", captionsKey(record.id)],
  ]);
  return { ok: true, captions: tracksFrom(flat) };
}

/** Takes a video's captions in one language away, at the service and here. */
export async function dropCaption(pathname: string, lang: string): Promise<CaptionAnswer> {
  const config = streamConfig();
  if (!config || !isRedisConfigured()) return { ok: false, reason: "off" };
  if (!captionLabel(lang)) return { ok: false, reason: "language" };
  const record = await streamRecord(pathname);
  if (!record) return { ok: false, reason: "unknown" };
  const answer = await ask(config, "DELETE", `/videos/${record.id}/captions/${lang}`);
  // Gone there already is gone: anything else, and the language stays listed
  // here, because the player still offers it.
  if (answer.status !== 200 && answer.status !== 404) return { ok: false, reason: "unavailable" };
  const [, flat] = await redisPipeline([
    ["HDEL", captionsKey(record.id), lang],
    ["HGETALL", captionsKey(record.id)],
  ]);
  return { ok: true, captions: tracksFrom(flat) };
}

/**
 * The five-minute job's work: asks about each video that is due, oldest
 * first, and tries again to delete the ones that could not be. Stops at
 * `deadline`; what is left is due still, and is first in line next time.
 */
export async function sweep(deadline: number, now = Date.now()): Promise<{ looked: number; ready: number; failed: number; deleted: number }> {
  const counts = { looked: 0, ready: 0, failed: 0, deleted: 0 };
  const config = streamConfig();
  if (!config || !isRedisConfigured()) return counts;
  const [due] = await redisPipeline([["ZRANGEBYSCORE", DUE, 0, now, "LIMIT", 0, 40]]);
  for (const id of Array.isArray(due) ? due : []) {
    if (Date.now() > deadline) return counts;
    if (typeof id !== "string") continue;
    const record = await lookAt(id, now);
    counts.looked += 1;
    if (record?.state === "ready") counts.ready += 1;
    if (record?.state === "failed") counts.failed += 1;
  }
  const [gone] = await redisPipeline([["SMEMBERS", GONE]]);
  for (const id of (Array.isArray(gone) ? gone : []).slice(0, 40)) {
    if (Date.now() > deadline) return counts;
    if (typeof id !== "string") continue;
    const answer = STREAM_ID_PATTERN.test(id) ? await ask(config, "DELETE", `/videos/${id}`) : { status: 404, data: null };
    if (answer.status === 200 || answer.status === 404) {
      await redisPipeline([["SREM", GONE, id]]);
      counts.deleted += 1;
    }
  }
  return counts;
}

export { VIDEO_RECORD_BYTES };
