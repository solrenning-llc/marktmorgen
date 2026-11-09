/**
 * AI captions: what the video service says it delivered is read exactly, and
 * one look that fails never stops the others (lib/auto-captions.ts,
 * app/api/cron/stream; inventory of money calls, finding 9, rule 24).
 *
 *   - an answer about a video in a shape that is not the service's (no
 *     `captions`, a list of another type, an entry without a language) is
 *     unknown, never "nothing delivered": no refund is asked for on it, the
 *     languages already listed stay listed, and the request is looked at
 *     again; past GIVE_UP_HOURS it is still never refunded on an unknown
 *     answer (it may have been delivered): it is kept, longer than the usual
 *     record, looked at further apart, and after the last automatic look kept
 *     for a person, reported, never dropped;
 *   - an answer that is not a 200 past GIVE_UP_HOURS keeps the record alive
 *     the same way, so the refund owed is not lost when the record would run
 *     out;
 *   - a known answer after it settles exactly as before (what never came is
 *     refunded, once);
 *   - the sweep looks at each due video on its own: one that fails is
 *     counted, left due for the next run, and the rest are looked at; a list
 *     of due videos in an unknown shape is unknown, never an empty queue;
 *   - the five-minute job runs the video sweep, the captions sweep and the
 *     watch reading each on its own: one failing never skips another, the
 *     answer says which failed, and the lock is let go;
 *   - an unknown look past GIVE_UP_HOURS only extends the life of the record
 *     there now: one settled and deleted during the look stays gone (and is
 *     never asked to refund again), one changed during it (a refund owed, a
 *     language listed) keeps the change, and the EXPIRE reply is read exactly
 *     (rule 24): anything but 1 or 0 is unknown and nothing else is written;
 *   - a look that keeps failing moves behind the videos due before it, so it
 *     never holds the head of the queue.
 *
 * Synthetic data only; the healthy and confirmed-empty answers work as before.
 */
import { GET as streamJob } from "@/app/api/cron/stream/route";
import { GIVE_UP_HOURS } from "@/lib/auto-captions-rules";
import { autoRefundsOwed, sweepAutoCaptions, syncAutoCaptions } from "@/lib/auto-captions";
import { UnknownReplyError } from "@/lib/redis-reply";
import { streamPath } from "@/lib/stream-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const VIDEO = "4d7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const OTHER = "5e7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const FOLDER = "d".repeat(32);
const PATH = streamPath(FOLDER, "lesson000004", VIDEO);
const OTHER_PATH = streamPath(FOLDER, "lesson000005", OTHER);
const KEY = `nl:stream:auto:${VIDEO}`;
const QUEUE = "nl:stream:autoq";
const PI = "pi_Captions000004";
const PRICE = 12000;
const HOUR = 3_600_000;
const WEEK_SECONDS = 7 * 86_400;

/** What the video service answers about a video: its status and body, or a thrown fetch. */
let video: { status: number; body: unknown } | "throws" = { status: 200, body: { guid: VIDEO, status: 4, captions: [] } };
/** What happens elsewhere (the service's hook) while the video service is being asked. */
let during: () => void = () => {};
const refundsAsked: URLSearchParams[] = [];
const errors: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]) => {
  errors.push(args.map(String).join(" "));
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "video.bunnycdn.com") {
    during();
    if (video === "throws") throw new Error("the service could not be reached");
    return video.body === undefined ? new Response("", { status: video.status }) : json(video.body, video.status);
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const body = new URLSearchParams(String(init?.body ?? ""));
  if (path === "/refunds" && method === "POST") {
    refundsAsked.push(body);
    const amount = body.has("amount") ? Number(body.get("amount")) : PRICE;
    return json({ object: "refund", id: `re_Captions${String(refundsAsked.length).padStart(6, "0")}`, status: "succeeded", payment_intent: body.get("payment_intent"), currency: "usd", amount });
  }
  if (path === "/refunds") return json({ object: "list", has_more: false, data: [] });
  if (path.startsWith("/payment_intents/")) return json({ object: "payment_intent", id: decodeURIComponent(path.slice("/payment_intents/".length)), currency: "usd", amount_received: PRICE });
  return json({});
}) as typeof fetch;

const realPipeline = redis.pipeline.bind(redis);
/** Commands that throw instead of being answered, and replies put in place of Redis's own. */
let throwsOn: (command: (string | number)[]) => boolean = () => false;
let replyFor: (commands: (string | number)[][]) => unknown[] | null = () => null;
let seen: (string | number)[][] = [];
redis.pipeline = (async (commands: (string | number)[][]) => {
  seen.push(...commands);
  if (commands.some((c) => throwsOn(c))) throw new Error("redis could not be reached");
  const replaced = replyFor(commands);
  if (replaced) return replaced;
  return realPipeline(commands);
}) as typeof redis.pipeline;

type Pending = { langs: string[]; got: string[]; at: number; cents: number; pi: string; path: string };
const T = Date.now();

function seed(id = VIDEO, path = PATH, got: string[] = []): void {
  const pending: Pending = { langs: ["en", "es"], got, at: T, cents: PRICE, pi: PI, path };
  redis.run(["SET", `nl:stream:auto:${id}`, JSON.stringify(pending), "EX", WEEK_SECONDS]);
  redis.run(["ZADD", QUEUE, T + 3 * 60_000, id]);
}

function reset(): void {
  redis.clear();
  refundsAsked.length = 0;
  errors.length = 0;
  throwsOn = () => false;
  replyFor = () => null;
  seen = [];
  during = () => {};
  video = { status: 200, body: { guid: VIDEO, status: 4, captions: [] } };
}

const record = (): Pending | null => {
  const raw = redis.run(["GET", KEY]);
  return typeof raw === "string" ? (JSON.parse(raw) as Pending) : null;
};
const queuedAt = (id = VIDEO): number | null => {
  const score = redis.run(["ZSCORE", QUEUE, id]);
  return score === null || score === undefined ? null : Number(score);
};
const ttl = (): number => Number(redis.run(["TTL", KEY]));

async function look(at: number): Promise<string> {
  try {
    return await syncAutoCaptions(VIDEO, at);
  } catch (error) {
    return `threw ${(error as Error).name}`;
  }
}

/** Bodies the service never answers with for a video it knows: none of them says what was delivered. */
const UNKNOWN: [string, unknown][] = [
  ["no captions field", { guid: VIDEO, status: 4 }],
  ["captions null", { guid: VIDEO, status: 4, captions: null }],
  ["captions a string", { guid: VIDEO, status: 4, captions: "en,es" }],
  ["captions an object", { guid: VIDEO, status: 4, captions: { en: true } }],
  ["an entry that is null", { guid: VIDEO, status: 4, captions: [{ srclang: "en" }, null] }],
  ["an entry without a language", { guid: VIDEO, status: 4, captions: [{ srclang: "en" }, { label: "Spanish" }] }],
  ["an entry whose language is a number", { guid: VIDEO, status: 4, captions: [{ srclang: "en" }, { srclang: 5 }] }],
  ["an entry whose language is empty", { guid: VIDEO, status: 4, captions: [{ srclang: "en" }, { srclang: "" }] }],
  ["a body that is a list", [{ srclang: "en" }, { srclang: "es" }]],
  ["a body that is not JSON", undefined],
];

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_captions_only_a_stand_in";
  process.env.BUNNY_STREAM_LIBRARY_ID = "12345";
  process.env.BUNNY_STREAM_API_KEY = "bunny-api-key-only-a-stand-in";
  process.env.BUNNY_STREAM_TOKEN_KEY = "bunny-token-key-only-a-stand-in";
  delete process.env.CRON_SECRET;
  const late = T + (GIVE_UP_HOURS + 1) * HOUR;

  part("Healthy controls: a known answer settles as before");
  reset();
  seed();
  is("none delivered, past the give-up: refunded in full, once, and done", [await look(late), refundsAsked.length, refundsAsked[0]?.has("amount"), record()], ["done", 1, false, null]);
  reset();
  seed();
  video = { status: 200, body: { guid: VIDEO, status: 4, captions: [{ srclang: "en", label: "English" }] } };
  is("one of two delivered, past the give-up: half refunded", [await look(late), refundsAsked.map((b) => b.get("amount"))], ["done", ["6000"]]);
  reset();
  seed();
  video = { status: 200, body: { guid: VIDEO, status: 4, captions: [{ srclang: "EN", label: "English" }, { srclang: "es-ES", label: "Spanish" }] } };
  is("both delivered: nothing refunded, done", [await look(T + HOUR), refundsAsked.length, record()], ["done", 0, null]);
  reset();
  seed();
  video = { status: 404, body: { message: "not found" } };
  is("the video is gone: what never came is refunded", [await look(T + HOUR), refundsAsked.length], ["done", 1]);

  part("An answer in a shape that is not the service's is unknown, never nothing delivered");
  for (const [name, body] of UNKNOWN) {
    reset();
    seed();
    video = { status: 200, body };
    const answer = await look(late);
    const kept = record();
    is(`${name}, past the give-up: no refund asked for, the record kept and looked at again`, [answer, refundsAsked.length, kept !== null, (queuedAt() ?? 0) > late], ["waiting", 0, true, true]);
    is(`${name}: kept longer than the usual record, so what may be owed is never lost`, ttl() > WEEK_SECONDS, true);
    is(`${name}: and said so`, errors.some((line) => line.includes(VIDEO)), true);
  }

  part("Before the give-up, an unknown answer never undoes what was listed");
  reset();
  seed(VIDEO, PATH, ["en"]);
  video = { status: 200, body: { guid: VIDEO, status: 4 } };
  is("English stays listed, nothing refunded, looked at again", [await look(T + HOUR), record()?.got, refundsAsked.length, (queuedAt() ?? 0) > T + HOUR], ["waiting", ["en"], 0, true]);
  video = { status: 200, body: { guid: VIDEO, status: 4, captions: [{ srclang: "en" }] } };
  is("then a known answer past the give-up: only Spanish is refunded, once", [await look(late), refundsAsked.map((b) => b.get("amount")), record()], ["done", ["6000"], null]);

  part("Past the give-up, an unknown answer is looked at further apart, then kept for a person");
  reset();
  seed();
  video = { status: 200, body: { guid: VIDEO, status: 4 } };
  await look(late);
  const next = queuedAt() ?? 0;
  is("looked at again, not at once", next > late, true);
  const longAfter = T + (GIVE_UP_HOURS + 24 * 15) * HOUR;
  is("after every automatic look: never refunded, never dropped, out of the queue, kept for a person and said so", [await look(longAfter), refundsAsked.length, record() !== null, queuedAt(), ttl() > WEEK_SECONDS, errors.some((line) => line.includes("person") && line.includes(VIDEO))], ["waiting", 0, true, null, true, true]);

  part("An answer that is not a 200 past the give-up keeps the record alive too");
  for (const [name, answer] of [["a 500", { status: 500, body: { message: "down" } }], ["a 429", { status: 429, body: {} }], ["no answer at all", "throws"]] as const) {
    reset();
    seed();
    video = answer;
    is(`${name}: no refund, kept, looked at again, kept past the usual record`, [await look(late), refundsAsked.length, record() !== null, (queuedAt() ?? 0) > late, ttl() > WEEK_SECONDS], ["waiting", 0, true, true, true]);
  }

  part("The sweep looks at each video on its own");
  reset();
  seed(VIDEO, PATH);
  seed(OTHER, OTHER_PATH);
  redis.run(["ZADD", QUEUE, T - 2_000, VIDEO]);
  redis.run(["ZADD", QUEUE, T - 1_000, OTHER]);
  video = { status: 200, body: { guid: OTHER, status: 4, captions: [{ srclang: "en" }, { srclang: "es" }] } };
  throwsOn = (c) => c[0] === "GET" && c[1] === KEY;
  let swept: unknown;
  try {
    swept = await sweepAutoCaptions(Date.now() + 8_000, T);
  } catch (error) {
    swept = `threw ${(error as Error).message}`;
  }
  throwsOn = () => false;
  is("one video failing: the next is still looked at and settled, and the failure counted", swept, { looked: 2, done: 1, failed: 1 });
  is("the one that failed is still due for the next run, moved behind the videos due before it", [queuedAt(VIDEO), redis.run(["GET", `nl:stream:auto:${OTHER}`])], [T, null]);
  is("and said so", errors.some((line) => line.includes(VIDEO)), true);

  part("A list of due videos in an unknown shape is unknown, never an empty queue");
  for (const [name, reply] of [["no reply", []], ["an object", [{}]], ["a member that is a number", [[VIDEO, 7]]], ["two replies", [[], []]]] as const) {
    reset();
    replyFor = (commands) => (commands.length === 1 && commands[0][0] === "ZRANGEBYSCORE" && commands[0][1] === QUEUE ? (reply as unknown as unknown[]) : null);
    let threw = "";
    try {
      await sweepAutoCaptions(Date.now() + 8_000, T);
    } catch (error) {
      threw = error instanceof UnknownReplyError ? "unknown" : (error as Error).message;
    }
    is(`${name}: unknown`, threw, "unknown");
  }
  reset();
  is("a queue confirmed empty: nothing looked at", await sweepAutoCaptions(Date.now() + 8_000, T), { looked: 0, done: 0, failed: 0 });

  part("The five-minute job runs each part on its own");
  const request = { headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/stream") } as unknown as Parameters<typeof streamJob>[0];
  const ranOn = (key: string) => seen.some((c) => c[0] === "ZRANGEBYSCORE" && c[1] === key);
  const run = async () => {
    seen = [];
    let status = -1;
    let body: Record<string, unknown> = {};
    try {
      const response = await streamJob(request);
      status = response.status;
      body = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      body = { threw: (error as Error).message };
    }
    return {
      status,
      ok: body.ok,
      failed: body.failedParts ?? [],
      videos: ranOn("nl:stream:due"),
      captions: ranOn(QUEUE),
      watch: ranOn("nl:watch:due"),
      letGo: seen.some((c) => c[0] === "DEL" && c[1] === "nl:stream:lock"),
    };
  };
  reset();
  is("healthy: every part runs, ok", await run(), { status: 200, ok: true, failed: [], videos: true, captions: true, watch: true, letGo: true });
  for (const [part_, key] of [["videos", "nl:stream:due"], ["captions", QUEUE], ["watch", "nl:watch:due"]] as const) {
    reset();
    throwsOn = (c) => c[0] === "ZRANGEBYSCORE" && c[1] === key;
    is(`the ${part_} part failing: the others still run, the job says which failed, the lock is let go`, await run(), {
      status: 500,
      ok: false,
      failed: [part_],
      videos: true,
      captions: true,
      watch: true,
      letGo: true,
    });
  }
  reset();
  seed();
  redis.run(["ZADD", QUEUE, T - 2_000, VIDEO]);
  throwsOn = (c) => c[0] === "GET" && c[1] === KEY;
  is("one captions look failing: the job runs every part and does not say it all went well", await run(), { status: 500, ok: false, failed: ["captions"], videos: true, captions: true, watch: true, letGo: true });

  part("An unknown look past the give-up never writes back the copy it read before asking");
  const OWED_KEY = `nl:stream:autoowed:${FOLDER}`;
  const REFUND_KEY = `nl-captions:${VIDEO}:${T}:refund`;
  const branches = [
    ["looked at again", late],
    ["kept for a person", longAfter],
  ] as const;
  const answers = [
    ["a 500", { status: 500, body: { message: "down" } }],
    ["a 200 that does not say what was delivered", { status: 200, body: { guid: VIDEO, status: 4 } }],
  ] as const;
  for (const [branch, at] of branches) {
    for (const [name, answer] of answers) {
      reset();
      seed();
      video = answer;
      // The hook settles the request meanwhile: it refunds what never came and deletes the record.
      during = () => {
        redis.run(["DEL", KEY]);
        redis.run(["ZREM", QUEUE, VIDEO]);
      };
      is(`${branch}, ${name}, the request settled during the look: it stays gone and is not queued again`, [await look(at), record(), queuedAt()], ["waiting", null, null]);
      during = () => {};
      video = { status: 200, body: { guid: VIDEO, status: 4, captions: [{ srclang: "en" }] } };
      is(`${branch}, ${name}: a known answer afterward asks for no refund again`, [await look(at + HOUR), refundsAsked.length], ["none", 0]);

      reset();
      seed();
      video = answer;
      // The hook's refund was not confirmed meanwhile: it wrote what is owed and listed it for the store.
      during = () => {
        const now = JSON.parse(String(redis.run(["GET", KEY]))) as Pending;
        redis.run(["SET", KEY, JSON.stringify({ ...now, owed: { cents: 6000, key: REFUND_KEY, since: at, looks: 0 } }), "EX", 400 * 86_400]);
        redis.run(["SADD", OWED_KEY, VIDEO]);
      };
      await look(at);
      is(`${branch}, ${name}, a refund owed written during the look: it is kept and still shown to the studio`, [(record() as { owed?: { cents: number } } | null)?.owed?.cents, await autoRefundsOwed(FOLDER)], [6000, [{ id: VIDEO, cents: 6000, stuck: false }]]);

      reset();
      seed();
      video = answer;
      // A language listed meanwhile stays listed.
      during = () => {
        const now = JSON.parse(String(redis.run(["GET", KEY]))) as Pending;
        redis.run(["SET", KEY, JSON.stringify({ ...now, got: ["en"] }), "EX", WEEK_SECONDS]);
      };
      await look(at);
      is(`${branch}, ${name}, a language listed during the look: it stays listed, and the record still lives past the usual one`, [record()?.got, ttl() > WEEK_SECONDS], [["en"], true]);
    }
  }

  part("The EXPIRE reply that keeps the record is read exactly");
  for (const [branch, at] of branches) {
    for (const [name, reply] of [["no reply", []], ["OK", ["OK"]], ["null", [null]], ["-1", [-1]], ["2", [2]], ["the string 1", ["1"]], ["two replies", [1, 1]]] as const) {
      reset();
      seed();
      video = { status: 500, body: { message: "down" } };
      const before = queuedAt();
      replyFor = (commands) => (commands.length === 1 && commands[0][0] === "EXPIRE" && commands[0][1] === KEY ? (reply as unknown as unknown[]) : null);
      is(`${branch}, EXPIRE answered ${name}: unknown, the record untouched, the queue untouched`, [await look(at), record()?.got, ttl() <= WEEK_SECONDS, queuedAt() === before], ["threw UnknownReplyError", [], true, true]);
    }
  }

  part("A look that keeps failing never holds the head of the queue");
  reset();
  const failing = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(8, "0")}-3f40-4a5b-8c6d-7e8f9a0b1c2d`);
  failing.forEach((id, i) => {
    seed(id, streamPath(FOLDER, `lesson${String(100 + i).padStart(6, "0")}`, id));
    redis.run(["ZADD", QUEUE, T - 60_000 + i, id]);
  });
  seed(OTHER, OTHER_PATH);
  redis.run(["ZADD", QUEUE, T - 500, OTHER]);
  video = { status: 200, body: { guid: OTHER, status: 4, captions: [{ srclang: "en" }, { srclang: "es" }] } };
  throwsOn = (c) => c[0] === "GET" && typeof c[1] === "string" && failing.some((id) => c[1] === `nl:stream:auto:${id}`);
  const first = await sweepAutoCaptions(Date.now() + 8_000, T);
  is("thirty looks failing in one run: each is counted and kept in the queue, due for the next run", [first, failing.every((id) => queuedAt(id) !== null && (queuedAt(id) ?? Infinity) <= T)], [{ looked: 30, done: 0, failed: 30 }, true]);
  const second = await sweepAutoCaptions(Date.now() + 8_000, T + 5 * 60_000);
  is("the next run looks at the video that was due before them first, and settles it", [second.done, redis.run(["GET", `nl:stream:auto:${OTHER}`]), queuedAt(OTHER)], [1, null, null]);
  reset();
  seed();
  redis.run(["ZADD", QUEUE, T - 2_000, VIDEO]);
  throwsOn = (c) => (c[0] === "GET" && c[1] === KEY) || c[0] === "ZADD";
  is("Redis failing on the move too: the look is counted, and it keeps its place", [await sweepAutoCaptions(Date.now() + 8_000, T), queuedAt(VIDEO)], [{ looked: 1, done: 0, failed: 1 }, T - 2_000]);

  console.error = realError;
  done();
}

main().catch((error) => {
  console.error = realError;
  console.error(error);
  process.exit(1);
});
