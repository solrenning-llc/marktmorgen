/**
 * AI captions kept for a person (lib/auto-captions.ts, unknownLook): past
 * GIVE_UP_HOURS and every automatic look, the video service never said which
 * captions it delivered, so nothing was refunded and the record left the
 * queue. What is checked here (rule 24, VR):
 *
 *   - such a record is never shown as "being written": the lesson says, in a
 *     status region, that the captions could not be confirmed and the charge
 *     is not final, and offers no new AI captions for that video;
 *   - it is never counted as a refund owed (no refund was decided: what was
 *     delivered is unknown), never as refunded and never as delivered; it is
 *     listed apart for the store, with the amount charged, deleted videos
 *     included;
 *   - it is counted once for the owner's monthly report, numbers only, with
 *     the other cases kept for a person (an order Stripe never settled, a
 *     refund Stripe never confirmed), each counted once;
 *   - a new request for that video says why it cannot be bought, never
 *     "already being written";
 *   - an answer that later says what was delivered settles it as before, and
 *     it is listed no more;
 *   - the store's list of money not settled, read in an unknown shape, is
 *     unknown, never "nothing owed";
 *   - the kept mark lands only over the record read before asking the video
 *     service (with #3345's EXPIRE, which only extends it): one changed or
 *     gone meanwhile keeps what was written there, and the mark's reply is
 *     read exactly (rule 24): anything but 1 or 0 is unknown, nothing else is
 *     written, and the case is counted so the owner's report never leaves it
 *     out.
 *
 * Synthetic data only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { readFileSync } from "node:fs";
import { CourseEditor } from "@/components/course-editor";
import { GIVE_UP_HOURS } from "@/lib/auto-captions-rules";
import * as captions from "@/lib/auto-captions";
import { REFUND_LOOKS_MAX, autoRefundsOwed, autoWriting, requestAutoCaptions, syncAutoCaptions } from "@/lib/auto-captions";
import type { Course } from "@/lib/course";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { streamPath } from "@/lib/stream-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const VIDEO = "6f7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const FOLDER = "e".repeat(32);
const LESSON = "lesson000006";
const PATH = streamPath(FOLDER, LESSON, VIDEO);
const KEY = `nl:stream:auto:${VIDEO}`;
const QUEUE = "nl:stream:autoq";
const OWED = `nl:stream:autoowed:${FOLDER}`;
const PI = "pi_Captions000006";
const PRICE = 12000;
const HOUR = 3_600_000;
const WEEK_SECONDS = 7 * 86_400;
const T = Date.now();
const LATE = T + (GIVE_UP_HOURS + 24 * 15) * HOUR;
const MONTH = new Date(LATE).toISOString().slice(0, 7);

/** Looked up by name, so a function not written yet is a failed check, not a build error. */
const named = <F>(name: string): F | undefined => (captions as unknown as Record<string, unknown>)[name] as F | undefined;
type Money = { owed: { id: string; cents: number; stuck: boolean }[]; unconfirmed: { id: string; cents: number }[] };
type States = { writing: Record<string, string[]>; held: string[] };
type KeptMonth = { delivery: number; order: number; refund: number };
const money = async (folder = FOLDER): Promise<Money | string> => {
  const fn = named<(folder: string) => Promise<Money>>("autoCaptionsMoney");
  if (!fn) return "missing";
  try {
    return await fn(folder);
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${(error as Error).message}`;
  }
};
const states = async (paths: string[]): Promise<States | string> => {
  const fn = named<(paths: string[]) => Promise<States>>("autoCaptionStates");
  return fn ? fn(paths) : "missing";
};
const keptMonth = async (month = MONTH): Promise<KeptMonth | null | string> => {
  const fn = named<(month: string) => Promise<KeptMonth | null>>("autoCaptionsKeptMonth");
  return fn ? fn(month) : "missing";
};

/** What the video service answers about the video. */
let video: { status: number; body: unknown } = { status: 200, body: { guid: VIDEO, status: 4 } };
/** How Stripe answers a refund asked for, and its list of the payment's refunds. */
let refundStatus = "succeeded";
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
  if (url.hostname === "video.bunnycdn.com") return json(video.body, video.status);
  const path = url.pathname.replace(/^\/v1/, "");
  const body = new URLSearchParams(String(init?.body ?? ""));
  if (path === "/refunds" && method === "POST") {
    refundsAsked.push(body);
    const amount = body.has("amount") ? Number(body.get("amount")) : PRICE;
    return json({ object: "refund", id: `re_Captions${String(refundsAsked.length).padStart(6, "0")}`, status: refundStatus, payment_intent: body.get("payment_intent"), currency: "usd", amount });
  }
  if (path === "/refunds") return json({ object: "list", has_more: false, data: [] });
  if (path.startsWith("/payment_intents/")) return json({ object: "payment_intent", id: decodeURIComponent(path.slice("/payment_intents/".length)), currency: "usd", amount_received: PRICE });
  if (path === "/invoices" && method === "GET") return json({ object: "list", has_more: false, data: [{ object: "invoice" }] });
  return json({});
}) as typeof fetch;

const realPipeline = redis.pipeline.bind(redis);
let replyFor: (commands: (string | number)[][]) => unknown[] | null = () => null;
redis.pipeline = (async (commands: (string | number)[][]) => replyFor(commands) ?? realPipeline(commands)) as typeof redis.pipeline;

type Pending = { langs: string[]; got: string[]; at: number; cents: number; pi: string; path: string; kept?: number; owed?: unknown };
const record = (): Pending | null => {
  const raw = redis.run(["GET", KEY]);
  return typeof raw === "string" ? (JSON.parse(raw) as Pending) : null;
};
const queued = (): unknown => redis.run(["ZSCORE", QUEUE, VIDEO]);

function seed(path = PATH): void {
  const pending: Pending = { langs: ["en", "es"], got: [], at: T, cents: PRICE, pi: PI, path };
  redis.run(["SET", KEY, JSON.stringify(pending), "EX", WEEK_SECONDS]);
  redis.run(["ZADD", QUEUE, T + 3 * 60_000, VIDEO]);
}

function reset(): void {
  redis.clear();
  refundsAsked.length = 0;
  errors.length = 0;
  replyFor = () => null;
  refundStatus = "succeeded";
  video = { status: 200, body: { guid: VIDEO, status: 4 } };
}

/** Seeded, then looked at past every automatic look with an answer that does not say what was delivered. */
async function keep(path = PATH): Promise<string> {
  seed(path);
  return syncAutoCaptions(VIDEO, LATE);
}

const store = {
  handle: "kept",
  subscriptionActive: true,
  subscriptionId: "sub_Store000006",
  period: paidPeriod(),
  stripeCustomerId: "cus_Store000006",
} as unknown as Store;

function course(): Course {
  return {
    id: "c".repeat(32),
    certificate: false,
    startsAt: null,
    modules: [{ id: "module000006", title: "Module 1", dripDays: 0, lessons: [{ id: LESSON, title: "Knife skills", preview: false, video: { pathname: PATH, name: "Knife skills.mp4", bytes: 1, contentType: "video/mp4", addedAt: new Date(T).toISOString() }, files: [], link: null, hasBody: false, quiz: null }] }],
  } as unknown as Course;
}

function draw(writing: Record<string, string[]>, held: string[] | undefined): string {
  const props = {
    productId: "p1",
    initial: course(),
    folder: FOLDER,
    openFirst: LESSON,
    streams: { [PATH]: "ready" },
    captions: {},
    writing,
    auto: { can: true, spoken: "en" },
    ...(held ? { held } : {}),
  };
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {} } as never }, createElement(CourseEditor as never, props as never)));
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_captions_only_a_stand_in";
  process.env.BUNNY_STREAM_LIBRARY_ID = "12345";
  process.env.BUNNY_STREAM_API_KEY = "bunny-api-key-only-a-stand-in";
  process.env.BUNNY_STREAM_TOKEN_KEY = "bunny-token-key-only-a-stand-in";

  part("Healthy controls");
  reset();
  seed();
  is("a request still being written is shown as being written, and is no money to settle", [await autoWriting([PATH]), await states([PATH]), await money()], [{ [PATH]: ["en", "es"] }, { writing: { [PATH]: ["en", "es"] }, held: [] }, { owed: [], unconfirmed: [] }]);
  reset();
  is("a store with nothing listed: nothing owed, nothing unconfirmed; and an empty month counts none", [await money(), await keptMonth()], [{ owed: [], unconfirmed: [] }, { delivery: 0, order: 0, refund: 0 }]);

  part("Kept for a person: never shown as being written");
  reset();
  is("kept: never refunded, out of the queue, the record kept", [await keep(), refundsAsked.length, queued(), record() !== null], ["waiting", 0, null, true]);
  is("marked as kept, with when", typeof record()?.kept, "number");
  is("not being written", (await autoWriting([PATH]))[PATH], undefined);
  is("held, in the studio's one read of the lesson videos", await states([PATH]), { writing: {}, held: [PATH] });

  part("Not a refund owed, not refunded, not delivered: listed apart for the store");
  is("never counted as a refund owed", await autoRefundsOwed(FOLDER), []);
  is("listed apart, with what was charged", await money(), { owed: [], unconfirmed: [{ id: VIDEO, cents: PRICE }] });
  is("never for another store", await money("b".repeat(32)), { owed: [], unconfirmed: [] });
  is("listed by store, so it is still shown once the video is deleted", redis.run(["SISMEMBER", OWED, VIDEO]), 1);

  part("Counted once for the owner's report");
  is("counted once", await keptMonth(), { delivery: 1, order: 0, refund: 0 });
  // The service's announcement looks again at a video no longer queued (app/api/stream/hook).
  await syncAutoCaptions(VIDEO, LATE + HOUR);
  is("an announcement looking again with the answer still unknown: kept, not counted twice, still out of the queue", [await keptMonth(), queued(), record()?.kept !== undefined], [{ delivery: 1, order: 0, refund: 0 }, null, true]);
  is("an unreadable month is unknown, never zero", await (async () => {
    replyFor = (commands) => (commands.length === 1 && commands[0][0] === "HMGET" ? [["1", "x", null]] : null);
    const read = await keptMonth();
    replyFor = () => null;
    return read;
  })(), null);

  part("A new request for it says why, never already being written");
  reset();
  await keep();
  await redis.pipeline([["SET", `nl:stream:v:${VIDEO}`, JSON.stringify({ id: VIDEO, path: PATH, name: "Knife skills.mp4", type: "video/mp4", bytes: 1, state: "ready", at: T, seconds: 600, width: 1920, height: 1080, settled: true })]]);
  is("held, not busy, and nothing charged", await requestAutoCaptions(store, PATH, "en", ["fr"], LATE + HOUR), { ok: false, reason: "held" });
  const editorSource = readFileSync("components/course-editor.tsx", "utf8");
  is("the editor has its own words for it", /auto_held: "/.test(editorSource), true);

  part("A later answer that says what was delivered settles it as before");
  reset();
  await keep();
  video = { status: 200, body: { guid: VIDEO, status: 4, captions: [{ srclang: "en", label: "English" }] } };
  is("one of two delivered: half refunded, done, listed no more", [await syncAutoCaptions(VIDEO, LATE + HOUR), refundsAsked.map((b) => b.get("amount")), record(), redis.run(["SISMEMBER", OWED, VIDEO]), await money()], ["done", ["6000"], null, 0, { owed: [], unconfirmed: [] }]);
  reset();
  await keep();
  video = { status: 200, body: { guid: VIDEO, status: 4, captions: [] } };
  refundStatus = "pending";
  is("none delivered and the refund not confirmed: a refund owed now, not unconfirmed", [await syncAutoCaptions(VIDEO, LATE + HOUR), await money()], ["waiting", { owed: [{ id: VIDEO, cents: PRICE, stuck: false }], unconfirmed: [] }]);

  part("The other cases kept for a person are counted once each");
  reset();
  // An order whose invoice Stripe never lists in a readable shape, past every look.
  redis.run(["SET", KEY, JSON.stringify({ order: "o1", at: T, cents: PRICE, langs: ["en"], path: PATH, customer: "cus_Store000006" }), "EX", 400 * 86_400]);
  redis.run(["ZADD", QUEUE, T, VIDEO]);
  await syncAutoCaptions(VIDEO, LATE);
  await syncAutoCaptions(VIDEO, LATE + HOUR);
  is("an order never settled: counted once", await keptMonth(), { delivery: 0, order: 1, refund: 0 });
  reset();
  redis.run(["SET", KEY, JSON.stringify({ langs: ["en"], got: [], at: T, cents: PRICE, pi: PI, path: PATH, owed: { cents: null, key: "nl-k", since: T, looks: REFUND_LOOKS_MAX - 1 } }), "EX", 400 * 86_400]);
  redis.run(["ZADD", QUEUE, T, VIDEO]);
  refundStatus = "pending";
  await syncAutoCaptions(VIDEO, LATE);
  await syncAutoCaptions(VIDEO, LATE + HOUR);
  is("a refund never confirmed: counted once, and shown as stuck", [await keptMonth(), await money()], [{ delivery: 0, order: 0, refund: 1 }, { owed: [{ id: VIDEO, cents: PRICE, stuck: true }], unconfirmed: [] }]);

  part("The store's list read in an unknown shape is unknown, never nothing owed");
  for (const [name, reply] of [["the list an object", [{}]], ["a member a number", [[VIDEO, 7]]], ["no reply", []]] as const) {
    reset();
    await keep();
    replyFor = (commands) => (commands.length === 1 && commands[0][0] === "SMEMBERS" && commands[0][1] === OWED ? (reply as unknown as unknown[]) : null);
    is(`${name}: unknown`, await money(), "unknown");
  }
  reset();
  await keep();
  replyFor = (commands) => (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === KEY ? [7] : null);
  is("a record in an unknown shape: unknown", await money(), "unknown");
  reset();
  await keep();
  redis.run(["DEL", KEY]);
  is("a listed record confirmed gone: not listed", await money(), { owed: [], unconfirmed: [] });

  part("The studio shows it, in a status region, and offers no new AI captions for it");
  const writingHtml = draw({ [PATH]: ["en", "es"] }, []);
  is("control: being written, in a status region", [writingHtml.includes("Being written by AI: English, Español."), /role="status" data-captions-writing/.test(writingHtml)], [true, true]);
  const offeredHtml = draw({}, []);
  is("control: nothing pending, AI captions offered", offeredHtml.includes("data-auto-captions"), true);
  const heldHtml = draw({}, [PATH]);
  const line = /<p[^>]*role="status"[^>]*data-captions-held[^>]*>([^<]*)<\/p>/.exec(heldHtml)?.[1] ?? "";
  is("held: said in a status region", line.startsWith("We could not confirm these AI captions with our video provider"), true);
  is("held: the charge is not final, and nobody is told it is being checked when it is not", [line.includes("charge for them is not final"), /we are checking/i.test(line), line.includes("support@marktmorgen.com")], [true, false, true]);
  is("held: never being written, no new AI captions offered", [heldHtml.includes("Being written by AI"), heldHtml.includes("data-auto-captions")], [false, false]);

  const page = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  is("the course page reads the lesson videos once, held ones included", /autoCaptionStates\(videoPaths\)/.test(page) && /held=\{held\}/.test(page), true);
  is("the course page lists unconfirmed charges apart from refunds owed", [page.includes("data-captions-unconfirmed"), page.includes("data-captions-refunds")], [true, true]);
  is("an unreadable list is said, never shown as nothing owed", /autoCaptionsMoney\(folder\)\.catch\(\(\) => null\)/.test(page) && page.includes("data-captions-money-unread"), true);
  part("The kept mark lands only over the record read before asking the service");
  const MARK = "-- marktmorgen:auto-captions-kept:v1\n";
  const isMark = (commands: (string | number)[][]) => commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith(MARK) && commands[0][3] === KEY;
  const tried = async (): Promise<unknown> => {
    try {
      return await syncAutoCaptions(VIDEO, LATE);
    } catch (error) {
      return error instanceof UnknownReplyError ? "threw UnknownReplyError" : String(error);
    }
  };
  reset();
  await keep();
  is("control: marked over the record read, the rest of it as it was, living as long as a refund owed would", [record()?.got, record()?.langs, Number(redis.run(["TTL", KEY])) > WEEK_SECONDS], [[], ["en", "es"], true]);
  reset();
  seed();
  // A language listed by the service's hook between the EXPIRE and the mark.
  replyFor = (commands) => {
    if (isMark(commands)) redis.run(["SET", KEY, JSON.stringify({ ...record(), got: ["en"] }), "EX", WEEK_SECONDS]);
    return null;
  };
  is(
    "a record changed meanwhile: what was written stays, not marked, not listed, not counted, and it keeps its place in the queue",
    [await tried(), record()?.got, record()?.kept, redis.run(["SISMEMBER", OWED, VIDEO]), queued(), await keptMonth()],
    ["waiting", ["en"], undefined, 0, String(T + 3 * 60_000), { delivery: 0, order: 0, refund: 0 }],
  );
  reset();
  seed();
  // Settled and deleted by the hook between the EXPIRE and the mark.
  replyFor = (commands) => {
    if (isMark(commands)) {
      redis.run(["DEL", KEY]);
      redis.run(["ZREM", QUEUE, VIDEO]);
    }
    return null;
  };
  is("a record gone meanwhile: it stays gone, unqueued, not listed and not counted", [await tried(), record(), queued(), redis.run(["SISMEMBER", OWED, VIDEO]), await keptMonth()], ["waiting", null, null, 0, { delivery: 0, order: 0, refund: 0 }]);
  for (const [name, reply] of [["no reply", []], ["OK", ["OK"]], ["null", [null]], ["2", [2]], ["the string 1", ["1"]], ["two replies", [1, 1]]] as const) {
    reset();
    seed();
    replyFor = (commands) => (isMark(commands) ? (reply as unknown as unknown[]) : null);
    is(
      `the mark answered ${name}: unknown, nothing else written, and counted so the owner's report never leaves it out`,
      [await tried(), record()?.kept, redis.run(["SISMEMBER", OWED, VIDEO]), queued(), await keptMonth()],
      ["threw UnknownReplyError", undefined, 0, String(T + 3 * 60_000), { delivery: 1, order: 0, refund: 0 }],
    );
  }
  replyFor = () => null;

  is("errors say so", errors.some((l) => l.includes("person") && l.includes(VIDEO)), true);

  console.error = realError;
  done();
}

main().catch((error) => {
  console.error = realError;
  console.error(error);
  process.exit(1);
});
