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
import { measure, measureDue } from "@/lib/watch";
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
    // Rule 23 (9 November 2026, pre-review finding 3): was null, said as "Refresh the page in a moment", which is false
    // when the wait is hours. A press refused because other tokens hold the room is its own kind, "busy".
    is("once the room is reserved, the page waits on the room rather than saying the hours are used", kinds.at(-1), "busy");
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
    // Only the hold's own step fails, the video's record having been read.
    const only = (fails: (commands: (string | number)[][]) => boolean, reply: (commands: (string | number)[][], replies: unknown[]) => unknown[] | never) => {
      redis.pipeline = (async (commands: (string | number)[][]) => {
        const replies = await pipeline(commands);
        return fails(commands) ? reply(commands, replies) : replies;
      }) as typeof redis.pipeline;
    };
    const holding = (commands: (string | number)[][]) => commands.some((c) => c[0] === "ZADD" && c[1] === HOLDS);
    only(holding, () => { throw new Error("The operation was aborted due to timeout"); });
    const lost = await lessonVideo(file as never, STORE_LIMIT, WINDOW);
    only(holding, (commands, replies) => commands.map((c, i) => (c[0] === "GET" ? "12.5" : replies[i])));
    const measuredUnread = await lessonVideo(file as never, STORE_LIMIT, WINDOW);
    redis.pipeline = pipeline;
    is("a hold whose answer was lost signs no token", lost?.kind ?? null, null);
    is("a measured figure that is not a whole number signs no token", measuredUnread?.kind ?? null, null);
    only((commands) => commands.some((c) => c[0] === "ZADD" && c[1] === "nl:watch:due"), () => { throw new Error("The operation was aborted due to timeout"); });
    const notInLine = await lessonVideo(file as never, STORE_LIMIT, WINDOW);
    redis.pipeline = pipeline;
    is("a hold whose store was not put in line for certain signs no token", notInLine?.kind ?? null, null);
    const held = (await redis.pipeline([["ZCARD", HOLDS]]))[0] as number;
    is("what may have been written stays held until a reading (never given back on an unknown)", held > 0, true);
    // Room left but the hold's give-back answer is lost: the excess stays held, and no token on it.
    // 2,000 seconds: the first token holds 1,500, the second fits 500 of its 1,500 and gives the rest back.
    await fresh(600, STORE_LIMIT - 2000);
    is("a first token takes the room", (await lessonVideo(file as never, STORE_LIMIT, WINDOW))?.kind, "stream");
    only((commands) => commands.some((c) => c[0] === "ZREM" && c[1] === HOLDS), (commands) => commands.map(() => "OK"));
    const giveBackLost = await lessonVideo(file as never, STORE_LIMIT, WINDOW);
    redis.pipeline = pipeline;
    is("an excess whose give-back answer cannot be read signs no token", giveBackLost?.kind ?? null, null);
    await fresh(600, STORE_LIMIT - 2000);
    await lessonVideo(file as never, STORE_LIMIT, WINDOW);
    is("control: with the give-back answered, the second token is the 500 seconds left", (await openings(1, STORE_LIMIT)).lives[0] <= 500 && (await redis.pipeline([["ZCARD", HOLDS]]))[0] === 7, true);
  }

  part("a reading made before a token ran out gives nothing back");
  {
    await fresh(600, STORE_LIMIT - 3600);
    const first = await openings(5, STORE_LIMIT);
    // Rule 23 (9 November 2026, pre-review finding 3): was null; busy is its own kind now.
    is("the room is held", first.kinds.at(-1), "busy");
    is("ten minutes on, nothing watched yet", await measure(FOLDER, Date.now() + 10 * 60 * 1000), 0);
    // Rule 23 (9 November 2026, pre-review finding 3): was [null]; busy is its own kind now.
    is("the tokens still out keep their room", (await openings(1, STORE_LIMIT)).kinds, ["busy"]);
  }

  part("a store with playback held stays in line to be read until it is given back");
  {
    await fresh(600, STORE_LIMIT - 3600);
    await openings(1, STORE_LIMIT);
    const due = async () => typeof (await redis.pipeline([["ZSCORE", "nl:watch:due", FOLDER]]))[0] === "string";
    is("an opening puts the store in line, right after its hold", await due(), true);
    const start = Date.now();
    await measureDue(Date.now() + 60_000, start + 11 * 60 * 1000);
    is("read before its token ran out: still in line, the hold kept", [await due(), (await redis.pipeline([["ZCARD", HOLDS]]))[0]], [true, 5]);
    await measureDue(Date.now() + 60_000, start + 3 * 3600 * 1000);
    is("read an interval after it ran out: given back, and out of line", [await due(), (await redis.pipeline([["ZCARD", HOLDS]]))[0]], [false, 0]);
    // A count of what is held that cannot be read keeps the store in line (rule 24), never takes it out.
    await redis.pipeline([["ZADD", "nl:watch:due", 0, FOLDER]]);
    const pipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await pipeline(commands);
      return commands.map((c, i) => (c[0] === "ZCARD" && c[1] === HOLDS ? "not a count" : replies[i]));
    }) as typeof redis.pipeline;
    await measureDue(Date.now() + 60_000, start + 3 * 3600 * 1000);
    redis.pipeline = pipeline;
    is("a count of what is held that cannot be read keeps the store in line", await due(), true);
  }

  part("a lesson's token: its length and the pauses, never past a press's block");
  {
    await fresh(600, 0);
    is("a ten-minute lesson: 25 minutes", (await openings(1, STORE_LIMIT)).lives[0] <= 25 * 60, true);
    await fresh(3 * 3600, 0);
    const long = (await openings(1, STORE_LIMIT)).lives[0];
    // Rule 23 (the owner's decision 16, 9 November 2026): was "three hours and a quarter" (long > 3 h, <= 3 h 15 min).
    // A press holds and signs a block of PLAY_BLOCK_SECONDS at most; the next press goes on (tests/lesson-play.test.ts).
    is("a three-hour lesson: a block of half an hour", long > 29 * 60 && long <= 30 * 60, true);
    await fresh(0, 0);
    is("a length not known yet: half an hour", (await openings(1, STORE_LIMIT)).lives[0] <= 30 * 60, true);
    await fresh(600, STORE_LIMIT - 90);
    is("a minute and a half left: a token of that much, and no more", (await openings(1, STORE_LIMIT)).lives[0] <= 90, true);
  }

  part("controls: a store with room plays; one with its hours measured is paused");
  {
    await fresh(600, 0);
    is("plenty of room: the lesson plays", (await lessonVideo(file as never, STORE_LIMIT, WINDOW))?.kind, "stream");
    await fresh(600, STORE_LIMIT);
    is("all hours measured: paused", (await lessonVideo(file as never, STORE_LIMIT, WINDOW))?.kind, "paused");
    const after = await redis.pipeline([["ZCARD", HOLDS], ["ZSCORE", "nl:watch:due", FOLDER]]);
    is("and nothing is left held, nor the store put in line to be read for it", after, [0, null]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
