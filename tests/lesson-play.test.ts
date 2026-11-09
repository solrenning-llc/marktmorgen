/**
 * A lesson video's playback is held when somebody presses Play, never when a
 * page is drawn (pre-review of claude5/video-hours-ceiling, 9 November 2026).
 *
 * The hold (lib/watch.ts, holdPlayback) made a plan's video hours a ceiling,
 * but it ran on every draw of a lesson page, and a free preview lesson is open
 * to anyone: 26 anonymous page loads of a one-hour preview held all 32 hours
 * of a Studio plan, nothing watched, and the store's paying students got no
 * player for five or six hours, again and again. Now:
 *
 *   - the page draws a "Play lesson" button and holds nothing; the press is a
 *     POST (app/api/store/course/play/route.ts) that checks the lesson is open
 *     to the one pressing it, paces them and the store's anonymous previews,
 *     and only then holds and signs; the frame is drawn after it;
 *   - an anonymous preview never takes the window below PREVIEW_KEEP_BPS of
 *     what it has left by what was measured, so visitors who are not students,
 *     however many, hold at most half of it;
 *   - a partial grant's units are scored with the moment its token really
 *     runs out, not the time first asked for, so they go back on time;
 *   - a press refused because other viewers hold the time says so, with the
 *     hours within which unused time comes back, never "Refresh the page in a
 *     moment" (VR 2);
 *   - the hold reads the measured figure after its own units are added and
 *     counted, and the reading adds what was watched before it lets units go,
 *     so no interleaving of the two pipelines lets a token past the ceiling;
 *   - the reading's own hold commands are priced (tests/plan-cost-registry.ts).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as learn from "@/lib/learn";
import { lessonVideo } from "@/lib/learn";
import { STREAM_API_ORIGIN, streamPath } from "@/lib/stream-rules";
import { PAID_VIDEO_HOURS } from "@/lib/video-admission-rules";
import { measure } from "@/lib/watch";
import * as rules from "@/lib/watch-rules";
import { coursesWords, COURSES_WORDS } from "@/lib/buyer-words/courses";
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
const SECONDS = `nl:watch:sec:${FOLDER}:${WINDOW}`;
const file = { pathname: PATH, name: "a.mp4", bytes: 1, contentType: "video/mp4", addedAt: "2026-11-01T00:00:00.000Z" };
const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

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

async function fresh(seconds: number, watched: number | null): Promise<void> {
  redis.clear();
  watchedAtService = 0;
  await redis.pipeline([
    ["SET", `nl:stream:v:${VIDEO}`, JSON.stringify({ id: VIDEO, path: PATH, name: "a.mp4", type: "video/mp4", bytes: 1, state: "ready", at: Date.now(), seconds, width: 1920, height: 1080, settled: true })],
    ["SET", `nl:stream:col:${FOLDER}`, COLLECTION],
  ]);
  if (watched !== null) await redis.pipeline([["SET", SECONDS, String(watched)]]);
}

const lifeOf = (video: unknown) => {
  const v = video as { kind?: string; src?: string } | null;
  return v?.kind === "stream" && v.src ? Number(new URL(v.src).searchParams.get("expires")) - Math.floor(Date.now() / 1000) : 0;
};
const held = async () => (await redis.pipeline([["ZCARD", HOLDS]]))[0] as number;
const STORE_LIMIT = PAID_VIDEO_HOURS.creator * 3600;
const STUDIO_LIMIT = PAID_VIDEO_HOURS.pro * 3600;
const H = 3600 * 1000;
type PageVideo = (file: unknown, limit: number | null, window: string | null) => Promise<{ kind: string } | null>;
type Play = (file: unknown, limit: number | null, window: string | null, store?: unknown, how?: { anonymous?: boolean }) => Promise<{ kind: string; until?: number } | null>;
const play = lessonVideo as unknown as Play;

async function main(): Promise<void> {
  part("ALTO: drawing a lesson page holds nothing; Play is a POST that holds");
  {
    const page = read("app/[handle]/course/[product]/[lesson]/page.tsx");
    is("the lesson page never calls the holding lessonVideo(", /\blessonVideo\(/.test(page), false);
    is("it calls lessonPageVideo(, which holds nothing", /\blessonPageVideo\(/.test(page), true);
    is("its Play lesson button posts to the play route", page.includes('action="/api/store/course/play"') && page.includes('method="post"'), true);
    const routePath = "app/api/store/course/play/route.ts";
    is("the play route exists", existsSync(join(root, routePath)), true);
    const route = existsSync(join(root, routePath)) ? read(routePath) : "";
    is("it paces the connection, the person and the store's anonymous previews before any hold", ["\"lesson-play-ip\"", "\"lesson-play-learner\"", "\"lesson-play-preview\""].every((scope) => route.includes(scope)), true);
    is("it takes the store's public requests before the hold", route.indexOf("takePublicRequest(") > 0 && route.indexOf("takePublicRequest(") < route.indexOf("lessonVideo("), true);

    const onPage = (learn as Record<string, unknown>).lessonPageVideo as PageVideo | undefined;
    is("lib/learn.ts exports lessonPageVideo", typeof onPage, "function");
    if (onPage) {
      await fresh(3600, 0);
      const kinds = new Set<string | null>();
      for (let i = 0; i < 1000; i += 1) kinds.add((await onPage(file, STUDIO_LIMIT, WINDOW))?.kind ?? null);
      is("1,000 draws of a one-hour preview lesson: a Play button each time", [...kinds], ["ready"]);
      is("and nothing at all is held", await held(), 0);
      is("a paying student's press of Play then plays", (await play(file, STUDIO_LIMIT, WINDOW))?.kind, "stream");
      await fresh(600, STORE_LIMIT);
      is("a store whose hours are measured shows the pause, not a button", (await onPage(file, STORE_LIMIT, WINDOW))?.kind, "paused");
    }
  }

  part("ALTO: anonymous previews, however many presses, hold at most half of what is left");
  {
    await fresh(3600, 0);
    let plays = 0;
    let last: { kind: string } | null = null;
    for (let i = 0; i < 1000; i += 1) {
      last = await play(file, STUDIO_LIMIT, WINDOW, undefined, { anonymous: true });
      if (last?.kind === "stream") plays += 1;
      else break;
    }
    is("anonymous presses stop before half the Studio's 32 hours are held", (await held()) * rules.HOLD_UNIT_SECONDS <= STUDIO_LIMIT / 2, true);
    is("the next anonymous press is told the rest is kept for students", last?.kind, "kept");
    is("a paying student still plays at once", (await play(file, STUDIO_LIMIT, WINDOW))?.kind, "stream");
    console.log(`anonymous presses that played: ${plays}`);

    await fresh(3 * 3600 + 45 * 60, 0);
    const first = await play(file, STORE_LIMIT, WINDOW, undefined, { anonymous: true });
    is("Store, 4 h: an anonymous press of a 3 h 45 min preview plays", first?.kind, "stream");
    is("for at most half the hours left (2 h)", lifeOf(first) > 0 && lifeOf(first) <= 2 * 3600, true);
    is("a paying student then still plays", (await play(file, STORE_LIMIT, WINDOW))?.kind, "stream");
  }

  part("MEDIO: a partial grant's units run out with its token");
  {
    await fresh(3 * 3600 + 45 * 60, STORE_LIMIT - 30 * 60);
    const v = await play(file, STORE_LIMIT, WINDOW);
    const life = lifeOf(v);
    is("a 30-minute token", life <= 30 * 60 && life > 29 * 60, true);
    const scores = (await redis.pipeline([["ZRANGEBYSCORE", HOLDS, "-inf", "+inf", "WITHSCORES"]]))[0] as string[];
    const latest = Math.max(...scores.filter((_, i) => i % 2 === 1).map(Number));
    is("its units are scored at the token's end, not four hours on", latest - Date.now() <= 30 * 60 * 1000 + 2_000 && latest * 1 >= Date.now() + life * 1000 - 2_000, true);
    is("a reading 1 h after the token ran out gives them back", await measure(FOLDER, Date.now() + 1.6 * H), 0);
    is("nothing stays held", await held(), 0);
  }

  part("MEDIO (VR 2): a press refused because others hold the time says when unused time comes back");
  {
    await fresh(600, STORE_LIMIT - 3600);
    for (let i = 0; i < 10; i += 1) await play(file, STORE_LIMIT, WINDOW);
    const busy = await play(file, STORE_LIMIT, WINDOW);
    is("the refusal is its own kind, busy", busy?.kind, "busy");
    const scores = (await redis.pipeline([["ZRANGEBYSCORE", HOLDS, "-inf", "+inf", "WITHSCORES"]]))[0] as string[];
    const earliest = Math.min(...scores.filter((_, i) => i % 2 === 1).map(Number));
    const until = busy?.until ?? 0;
    is("with the moment unused time is back by: the earliest token's end, the settling interval, a reading's interval and the job's margin", until, earliest + rules.HOLD_SETTLE_MS + rules.MEASURE_EVERY_MS + rules.MEASURE_SOON_MS);
    const words = coursesWords("en") as unknown as Record<string, unknown>;
    is("the words say other viewers hold the time and when it comes back", typeof words.playBusyRest === "function" ? (words.playBusyRest as (h: number) => string)(3) : null,
      "Other viewers are using this store's video time right now. Time they do not use comes back within about 3 hours; then press Play lesson again.");
    for (const [code, set] of Object.entries(COURSES_WORDS)) {
      const own = set as unknown as Record<string, unknown>;
      is(`${code}: every new sentence is there`, ["playLesson", "playWaitStrong", "playBusyRest", "playKeptRest", "playManyRest", "playPreviewsRest"].every((k) => own[k] !== undefined), true);
    }
    is("the page draws the busy words, not videoNotLoaded, for a busy press", read("app/[handle]/course/[product]/[lesson]/page.tsx").includes("w.playBusyRest("), true);
  }

  part("LEVE: no interleaving of the hold with the reading's write step lets a token past the ceiling");
  {
    // The reading's write step, as measure sends it: captured from the code, so a reorder there is what is tested.
    await fresh(600, 3 * 3600);
    const past = Date.now() - 3 * H;
    await redis.pipeline([["ZADD", HOLDS, ...Array.from({ length: 12 }, (_, i) => [past, `old:${i}`]).flat()]]);
    watchedAtService = 3600;
    const real = redis.pipeline.bind(redis);
    let step: (string | number)[][] = [];
    (redis as unknown as { pipeline: typeof real }).pipeline = async (commands) => {
      if (commands.some((c) => c[0] === "ZREMRANGEBYSCORE")) {
        step = commands.filter((c) => c[0] === "INCRBY" || c[0] === "ZREMRANGEBYSCORE");
        return commands.map(() => 0);
      }
      return real(commands);
    };
    await measure(FOLDER, Date.now());
    (redis as unknown as { pipeline: typeof real }).pipeline = real;
    is("the reading adds what was watched before it lets units go", step.map((c) => c[0]), ["INCRBY", "ZREMRANGEBYSCORE"]);

    // 3 h measured; 1 h of tokens ran out long ago and was watched (the service counts it, not read yet): room 0.
    // Every split of the hold's pipeline, with every split of the reading's step put into it.
    let signed = 0;
    let splits = 0;
    for (let k = 0; k <= 4; k += 1) {
      for (let j = 0; j <= step.length; j += 1) {
        await fresh(600, 3 * 3600);
        await redis.pipeline([["ZADD", HOLDS, ...Array.from({ length: 12 }, (_, i) => [past, `old:${i}`]).flat()]]);
        let injected = false;
        (redis as unknown as { pipeline: typeof real }).pipeline = async (commands) => {
          if (!injected && commands.some((c) => c[0] === "ZADD" && c[1] === HOLDS)) {
            injected = true;
            const at = Math.min(k, commands.length);
            const head = at ? await real(commands.slice(0, at)) : [];
            if (j) await real(step.slice(0, j));
            const tail = at < commands.length ? await real(commands.slice(at)) : [];
            if (j < step.length) await real(step.slice(j));
            return [...head, ...tail];
          }
          return real(commands);
        };
        const v = await play(file, STORE_LIMIT, WINDOW);
        (redis as unknown as { pipeline: typeof real }).pipeline = real;
        splits += 1;
        if (lifeOf(v) > 0) signed += 1;
      }
    }
    is(`no token is signed in any of the ${splits} interleavings`, signed, 0);
  }

  part("LEVE: the reading's own hold commands are priced");
  {
    const registry = read("tests/plan-cost-registry.ts");
    is("the registry prices the reading's ZCARD (measureDue) and ZREMRANGEBYSCORE (measure)", /VIDEO_READING_HOLD_COMMANDS\s*=\s*2\b/.test(registry) && registry.includes("VIDEO_READING_HOLD_COMMANDS * COMMAND"), true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
