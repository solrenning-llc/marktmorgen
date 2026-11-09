/**
 * A plan's lesson video hours are a ceiling, not a figure read after the fact
 * (owner's margin rule MR, 27 October 2026: a ceiling before every expense).
 *
 * The meter (lib/watch.ts) reads what the video service counted by the hour,
 * after the watching. Before this, a lesson page compared that figure with the
 * plan and, under it, handed out a player token good for four hours that nothing
 * can take back: with one second of a Store plan's four hours left, two hundred
 * opens were two hundred tokens, eight hundred hours of playback let out.
 *
 * Now the time a token lets anyone watch is reserved against the window's room
 * (the plan's seconds less those measured less those still reserved) before the
 * token is signed, in one step that never lets two openings take the same room;
 * the token is good for exactly what was reserved; and the hourly reading gives
 * back what a token reserved once it has run out, so the creator's students never
 * lose hours they did not watch. A reply that cannot be read signs no token
 * (CX-123 rule 24): unknown is never room.
 */
import { lessonVideo } from "@/lib/learn";
import { STREAM_API_ORIGIN, streamPath } from "@/lib/stream-rules";
import { PAID_VIDEO_HOURS } from "@/lib/video-admission-rules";
import { measure } from "@/lib/watch";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LIBRARY = "12345";
const API_KEY = "bunny-api-key-only-a-stand-in";
process.env.BUNNY_STREAM_LIBRARY_ID = LIBRARY;
process.env.BUNNY_STREAM_API_KEY = API_KEY;
process.env.BUNNY_STREAM_TOKEN_KEY = "bunny-token-key-only-a-stand-in";

const FOLDER = "a".repeat(32);
const COLLECTION = "11111111-2222-4333-8444-555555555555";
const VIDEO = "0b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const PATH = streamPath(FOLDER, "lesson000001", VIDEO);
const WINDOW = "2026-11";
const HOLDS = `nl:watch:hold:${FOLDER}`;
const file = { pathname: PATH, name: "a.mp4", bytes: 1, contentType: "video/mp4", addedAt: "2026-11-01T00:00:00.000Z" };

/** What the video service says each video was watched, in seconds. */
let watchedAtService = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.origin === STREAM_API_ORIGIN && url.pathname === `/library/${LIBRARY}/videos` && (init?.method ?? "GET") === "GET") {
    if ((init?.headers as Record<string, string>).AccessKey !== API_KEY) return json({}, 401);
    const items = url.searchParams.get("collection") === COLLECTION ? [{ guid: VIDEO, collectionId: COLLECTION, totalWatchTime: watchedAtService }] : [];
    return json({ totalItems: items.length, currentPage: Number(url.searchParams.get("page") ?? "1"), itemsPerPage: 1000, items });
  }
  return json({}, 404);
}) as typeof fetch;

/** A ready lesson video `seconds` long, and a window in which `watched` seconds were measured. */
async function fresh(seconds: number, watched: number | null): Promise<void> {
  redis.clear();
  watchedAtService = 0;
  await redis.pipeline([
    ["SET", `nl:stream:v:${VIDEO}`, JSON.stringify({ id: VIDEO, path: PATH, name: "a.mp4", type: "video/mp4", bytes: 1, state: "ready", at: Date.now(), seconds, width: 1920, height: 1080, settled: true })],
    ["SET", `nl:stream:col:${FOLDER}`, COLLECTION],
  ]);
  if (watched !== null) await redis.pipeline([["SET", `nl:watch:sec:${FOLDER}:${WINDOW}`, String(watched)]]);
}

/** Opens the lesson `times` times; the seconds each token signed is good for (0 for none) and what each open showed. */
async function openings(times: number, limit: number, together = false): Promise<{ lives: number[]; kinds: (string | null)[] }> {
  const one = async () => {
    const before = Math.floor(Date.now() / 1000);
    const video = await lessonVideo(file as never, limit, WINDOW);
    if (video?.kind !== "stream") return { life: 0, kind: video?.kind ?? null };
    const expires = Number(new URL(video.src).searchParams.get("expires"));
    return { life: expires - before, kind: "stream" };
  };
  const got = together ? await Promise.all(Array.from({ length: times }, one)) : await (async () => {
    const out: { life: number; kind: string | null }[] = [];
    for (let i = 0; i < times; i += 1) out.push(await one());
    return out;
  })();
  return { lives: got.map((g) => g.life), kinds: got.map((g) => g.kind) };
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const STORE_LIMIT = PAID_VIDEO_HOURS.creator * 3600;

async function main(): Promise<void> {
  part("one second of a Store plan's four hours left: no token at all");
  {
    await fresh(3600, STORE_LIMIT - 1);
    const { lives, kinds } = await openings(200, STORE_LIMIT);
    is("200 opens sign no player token", lives.filter((l) => l > 0).length, 0);
    is("each says the video is paused for the hours used", [...new Set(kinds)], ["paused"]);
  }

  part("an hour left and a ten-minute lesson: the tokens together never outlast the hour");
  {
    await fresh(600, STORE_LIMIT - 3600);
    const { lives, kinds } = await openings(10, STORE_LIMIT);
    is("at least one opening plays", lives.some((l) => l > 0), true);
    is("the playback the tokens allow is within the hour left", sum(lives) <= 3600, true);
    is("no token is good for longer than the lesson and its pauses (25 minutes)", Math.max(...lives) <= 25 * 60, true);
    is("once the room is reserved, the page waits on the room rather than saying the hours are used", kinds.at(-1), null);
    const scores = (await redis.pipeline([["ZRANGEBYSCORE", HOLDS, "-inf", "+inf", "WITHSCORES"]]))[0] as string[];
    const latest = Math.max(0, ...scores.filter((_, i) => i % 2 === 1).map(Number));
    is("every token's time is held in the store's reservations, held at least as long as the token lasts", latest >= (Date.now() + Math.max(...lives) * 1000) - 2_000, true);
  }

  part("thirty opens at the same moment, with an hour left: never more than the hour");
  {
    await fresh(600, STORE_LIMIT - 3600);
    const { lives } = await openings(30, STORE_LIMIT, true);
    is("together, still within the hour left", sum(lives) <= 3600, true);
    is("and some of them play", lives.some((l) => l > 0), true);
  }

  part("the hourly reading gives back what a token held and nobody watched");
  {
    await fresh(600, STORE_LIMIT - 3600);
    const first = await openings(10, STORE_LIMIT);
    const held = sum(first.lives);
    // Ten minutes were watched; the reading is made well after every token ran out.
    watchedAtService = 600;
    const later = Date.now() + 3 * 3600 * 1000;
    is("the reading adds the ten minutes watched", await measure(FOLDER, later), 600);
    const room = 3600 - 600;
    const again = await openings(20, STORE_LIMIT);
    is("the tokens reserved before held more than was watched", held > 600, true);
    is("after the reading, the room left is what was not watched: tokens again, within it", sum(again.lives) > 0 && sum(again.lives) <= room, true);
  }

  part("unknown is never room (rule 24)");
  {
    await fresh(600, STORE_LIMIT - 3600);
    const pipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await pipeline(commands);
      return commands.map((c, i) => (c[0] === "ZCARD" ? "not a count" : replies[i]));
    }) as typeof redis.pipeline;
    const unread = await lessonVideo(file as never, STORE_LIMIT, WINDOW);
    redis.pipeline = (async () => {
      throw new Error("Redis request failed with status 503");
    }) as typeof redis.pipeline;
    const down = await lessonVideo(file as never, STORE_LIMIT, WINDOW);
    redis.pipeline = pipeline;
    is("a count of the reservations that cannot be read signs no token", unread?.kind ?? null, null);
    is("a database that cannot be reached signs no token", down?.kind ?? null, null);
  }

  part("controls: a store with room plays; one with its hours measured is paused");
  {
    await fresh(600, 0);
    is("plenty of room: the lesson plays", (await lessonVideo(file as never, STORE_LIMIT, WINDOW))?.kind, "stream");
    await fresh(600, STORE_LIMIT);
    is("all hours measured: paused", (await lessonVideo(file as never, STORE_LIMIT, WINDOW))?.kind, "paused");
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
