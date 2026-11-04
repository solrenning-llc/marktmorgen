/**
 * Lesson video: how long it was watched, what a plan covers of it, what is
 * charged past that, and what happens where there is nobody to charge
 * (lib/watch-rules.ts, lib/watch.ts, lib/watch-billing.ts, lib/learn.ts).
 *
 * Two services are somebody else's and are stood in for here. The video
 * service lists a store's videos with the seconds each has been watched, a
 * thousand to a page, the way its own "List Videos" page says. Stripe keeps
 * the lines added to a customer the way it does: one for each request, and
 * one only for requests that carry the same Idempotency-Key. Each can be
 * slow to the point of not answering, and Stripe can do the worse thing:
 * carry a request out and never say so.
 *
 * What no test here can hold is either service itself.
 *
 * Stripe's part was tried by hand in its sandbox on October 7, 2026, with
 * the very fields lib/billing.ts sends: the line was taken and tied to the
 * subscription, was found again by customer and date with its mark on it,
 * and stood on the preview of that subscription's next invoice beside the
 * plan; a subscription billed by the year took the setting that bills added
 * lines monthly. The charge itself is to be seen on a real invoice, the
 * first time a real store passes its hours.
 *
 * The video service's count was read against the live library the same
 * day: a lesson played once through, 24 seconds, came back as 24 seconds
 * more, and the five-minute job added exactly the service's total to the
 * store's month. The same reading showed where its player counts less than
 * was played (lib/watch.ts): replays in one sitting, after a video has
 * reached its end.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { monthKey, rememberFolderOwner } from "@/lib/delivery";
import { lessonVideo } from "@/lib/learn";
import { claimHandle, setSubscription, storeFolder } from "@/lib/store";
import { PLAYER_SECONDS, streamWatched } from "@/lib/stream";
import { STREAM_API_ORIGIN, streamPath } from "@/lib/stream-rules";
import { measure, measureDue, opened, watchedFolders, watchedIn } from "@/lib/watch";
import { firstWord, settle, settleAll } from "@/lib/watch-billing";
import {
  MEASURE_EVERY_MS,
  MEASURE_SOON_MS,
  VIDEO_CENTS_PER_HOUR_OVER,
  VIDEO_SECONDS_INCLUDED,
  canBeCharged,
  centsWords,
  hoursWords,
  monthBefore,
  monthWords,
  videoOwedCents,
} from "@/lib/watch-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const LIBRARY = "4242";
const API_KEY = "a-stand-in-library-key-for-tests-only";
const HOUR = 3600;

// ------------------------------------------------------- the video service

type Video = { guid: string; collectionId: string; totalWatchTime: number };
const videos = new Map<string, Video>();
let streamService: "up" | "down" = "up";
const streamAsked: string[] = [];
let made = 0;
const guid = () => {
  made += 1;
  return `00000000-0000-4000-8000-${String(made).padStart(12, "0")}`;
};

// ------------------------------------------------------------------ Stripe

type Line = { id: string; customer: string; subscription: string; amount: number; description: string; mark: string; created: number };
const lines: Line[] = [];
const keys = new Map<string, Line>();
const monthly: string[] = [];
/** up; down, nothing happens and nothing is answered; lost, the request is carried out and never answered. */
const stripe = "up" as "up" | "down" | "lost";
const stripeAsked: string[] = [];
/** What time it is at Stripe: the time of the run that is asking. */
let clock = Date.now();
/** One store's month settled at a given time, which Stripe's clock is set to. */
const settleAt = (folder: string, month: string, final: boolean, when: number) => {
  clock = when;
  return settle(folder, month, final, when);
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

  if (url.origin === STREAM_API_ORIGIN) {
    streamAsked.push(`${method} ${url.pathname}${url.search}`);
    if (streamService === "down") throw new TypeError("fetch failed");
    if ((init?.headers as Record<string, string>).AccessKey !== API_KEY) return json({}, 401);
    if (url.pathname === `/library/${LIBRARY}/videos` && method === "GET") {
      const all = [...videos.values()].filter((v) => v.collectionId === url.searchParams.get("collection"));
      const per = Math.min(1000, Math.max(10, Number(url.searchParams.get("itemsPerPage") ?? "100")));
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
      return json({ totalItems: all.length, currentPage: page, itemsPerPage: per, items: all.slice((page - 1) * per, page * per) });
    }
    return json({}, 404);
  }

  if (url.origin === "https://api.stripe.com") {
    const path = url.pathname.replace(/^\/v1/, "");
    stripeAsked.push(`${method} ${path}`);
    if (stripe === "down") throw new TypeError("fetch failed");
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (path === "/invoiceitems" && method === "POST") {
      const key = (init?.headers as Record<string, string>)["Idempotency-Key"] ?? "";
      let line = keys.get(key);
      if (!line) {
        line = {
          id: `ii_${String(lines.length + 1).padStart(14, "0")}`,
          customer: body.get("customer") ?? "",
          subscription: body.get("subscription") ?? "",
          amount: Number(body.get("amount")),
          description: body.get("description") ?? "",
          mark: body.get("metadata[mark]") ?? "",
          created: Math.floor(clock / 1000),
        };
        if (body.get("currency") !== "usd" || !(line.amount > 0)) return json({ error: { code: "parameter_invalid" } }, 400);
        lines.push(line);
        if (key) keys.set(key, line);
      }
      if (stripe === "lost") throw new TypeError("fetch failed");
      return json({ id: line.id, amount: line.amount });
    }
    if (path === "/invoiceitems" && method === "GET") {
      const since = Number(url.searchParams.get("created[gte]") ?? "0");
      const found = lines.filter((l) => l.customer === url.searchParams.get("customer") && l.created >= since);
      return json({ data: found.map((l) => ({ id: l.id, amount: l.amount, metadata: { mark: l.mark } })), has_more: false });
    }
    const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
    if (sub && method === "POST") {
      if (body.get("pending_invoice_item_interval[interval]") === "month") monthly.push(sub[1]);
      return json({ id: sub[1] });
    }
    return json({ error: { code: "resource_missing" } }, 404);
  }
  return json({}, 404);
}) as typeof fetch;

function setUp(): void {
  process.env.BUNNY_STREAM_LIBRARY_ID = LIBRARY;
  process.env.BUNNY_STREAM_API_KEY = API_KEY;
  process.env.BUNNY_STREAM_TOKEN_KEY = "a-stand-in-token-key-for-tests-only";
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
}

/** A store with a collection at the video service, and the folder it is kept under. */
async function storeWith(email: string, handle: string): Promise<{ folder: string; collection: string }> {
  await claimHandle(email, handle, handle, "");
  const folder = await storeFolder(email);
  await rememberFolderOwner(folder, email);
  const collection = guid();
  await redis.pipeline([["SET", `nl:stream:col:${folder}`, collection]]);
  return { folder, collection };
}

function video(collection: string, seconds = 0): Video {
  const made: Video = { guid: guid(), collectionId: collection, totalWatchTime: seconds };
  videos.set(made.guid, made);
  return made;
}

/** Writes down a month's watching for a store, as lib/watch.ts would have. */
async function watched(folder: string, month: string, seconds: number): Promise<void> {
  await redis.pipeline([
    ["SET", `nl:watch:sec:${folder}:${month}`, seconds],
    ["SADD", `nl:watch:folders:${month}`, folder],
  ]);
}

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
/** Every .ts and .tsx file under a folder, as paths from the repository's root. */
const filesUnder = (dir: string): string[] => readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? filesUnder(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []);

async function main(): Promise<void> {
  setUp();

  part("What a plan covers, and what an hour past it costs");
  is("a month inside the hours owes nothing", [videoOwedCents(0), videoOwedCents(VIDEO_SECONDS_INCLUDED)], [0, 0]);
  is("an hour past them is the published price", videoOwedCents(VIDEO_SECONDS_INCLUDED + HOUR), VIDEO_CENTS_PER_HOUR_OVER);
  is("it is counted to the second, and a part of a cent is never charged", [videoOwedCents(VIDEO_SECONDS_INCLUDED + 1199), videoOwedCents(VIDEO_SECONDS_INCLUDED + 1200), videoOwedCents(VIDEO_SECONDS_INCLUDED + 2399)], [0, 1, 1]);
  is("a thousand hours past them", videoOwedCents(VIDEO_SECONDS_INCLUDED + 1000 * HOUR), 1000 * VIDEO_CENTS_PER_HOUR_OVER);
  is("a figure that is not one owes nothing", [videoOwedCents(Number.NaN), videoOwedCents(-5)], [0, 0]);
  is("a length of watching, in words", [hoursWords(0), hoursWords(60), hoursWords(59 * 60), hoursWords(HOUR), hoursWords(3.56 * HOUR), hoursWords(412.9 * HOUR), hoursWords(1500 * HOUR)], ["0 minutes", "1 minute", "59 minutes", "1 hour", "3.5 hours", "412 hours", "1,500 hours"]);
  is("money and months, in words", [centsWords(3), centsWords(150), monthWords("2026-10"), monthBefore("2026-10"), monthBefore("2027-01")], ["$0.03", "$1.50", "October 2026", "2026-09", "2026-12"]);
  const plan = { subscriptionActive: true, subscriptionId: "sub_Paid00001", period: paidPeriod(), stripeCustomerId: "cus_Paid00001", trialEnds: 0 };
  is("a paid plan past its trial can be charged", canBeCharged(plan, 1_000), true);
  is("one still in its free trial cannot", canBeCharged({ ...plan, trialEnds: 2_000 }, 1_000), false);
  is("nor one that is not paying, or was never started", [canBeCharged({ ...plan, subscriptionActive: false }, 1_000), canBeCharged({ ...plan, subscriptionId: null }, 1_000), canBeCharged({ ...plan, stripeCustomerId: null }, 1_000)], [false, false, false]);

  part("How long a store's video was watched, read from the video service");
  const ana = await storeWith("ana@example.com", "ana");
  const first = video(ana.collection, 0);
  const second = video(ana.collection, 0);
  const t0 = Date.UTC(2026, 9, 20, 14, 0, 0);
  const month = monthKey(new Date(t0));
  is("a store nobody watches is not asked about", [(await measureDue(Date.now() + 5_000, t0)).read, streamAsked.length], [0, 0]);
  await opened(ana.folder, t0);
  is("a lesson opened does not have it read at once", (await measureDue(Date.now() + 5_000, t0 + 60_000)).read, 0);
  first.totalWatchTime = 600;
  second.totalWatchTime = 150;
  is("ten minutes on it is read, and what was watched is added up", await measureDue(Date.now() + 5_000, t0 + MEASURE_SOON_MS), { read: 1, seconds: 750 });
  is("under the month it was read in", [await watchedIn(ana.folder, month), await watchedFolders(month)], [750, [ana.folder]]);
  is("in one question for the whole store", streamAsked.length, 1);
  is("not again inside the hour", (await measureDue(Date.now() + 5_000, t0 + MEASURE_SOON_MS + 60_000)).read, 0);
  first.totalWatchTime = 4200;
  const t1 = t0 + MEASURE_SOON_MS + MEASURE_EVERY_MS;
  is("an hour on, only what was watched since is added", [await measureDue(Date.now() + 5_000, t1), await watchedIn(ana.folder, month)], [{ read: 1, seconds: 3600 }, 4350]);
  is("a reading with nothing new adds nothing", [await measure(ana.folder, t1), await watchedIn(ana.folder, month)], [0, 4350]);
  second.totalWatchTime = 100;
  is("a count that went down adds nothing", [await measure(ana.folder, t1), await watchedIn(ana.folder, month)], [0, 4350]);
  second.totalWatchTime = 400;
  is("and is counted again from where it went down to", [await measure(ana.folder, t1), await watchedIn(ana.folder, month)], [300, 4650]);
  videos.delete(first.guid);
  const third = video(ana.collection, 90);
  is("a video taken away takes nothing back, and a new one counts from its first second", [await measure(ana.folder, t1), await watchedIn(ana.folder, month)], [90, 4740]);
  is("the one taken away is forgotten", Object.keys(Object.fromEntries(chunk((await redis.pipeline([["HGETALL", `nl:watch:last:${ana.folder}`]]))[0] as string[]))).sort(), [second.guid, third.guid].sort());

  streamService = "down";
  third.totalWatchTime = 190;
  const t2 = t1 + MEASURE_EVERY_MS;
  is("a service that cannot be read adds nothing", [await measure(ana.folder, t2), await streamWatched(ana.folder), await watchedIn(ana.folder, month)], [null, null, 4740]);
  is("and the store is not counted as read", (await measureDue(Date.now() + 5_000, t2)).read, 0);
  streamService = "up";
  is("it is read again a quarter of an hour on, and nothing was lost", [(await measureDue(Date.now() + 5_000, t2 + 14 * 60_000)).read, await measureDue(Date.now() + 5_000, t2 + 15 * 60_000), await watchedIn(ana.folder, month)], [0, { read: 1, seconds: 100 }, 4840]);

  // Nobody opens a lesson again. A token lasts PLAYER_SECONDS, so the store
  // is read until an hour past that, counted from the last lesson opened.
  let at = t2 + 15 * 60_000;
  let reads = 0;
  for (let i = 0; i < 12; i += 1) {
    at += MEASURE_EVERY_MS;
    reads += (await measureDue(Date.now() + 5_000, at)).read;
  }
  const last = t0 + (PLAYER_SECONDS + HOUR) * 1000;
  is("it is read by the hour until the last token has run out, and then left alone", [reads >= 1 && reads <= 5, at > last, (await redis.pipeline([["ZSCORE", "nl:watch:due", ana.folder]]))[0]], [true, true, null]);
  await opened(ana.folder, at);
  is("until a lesson is opened again", (await measureDue(Date.now() + 5_000, at + MEASURE_SOON_MS)).read, 1);

  const bea = await storeWith("bea@example.com", "bea");
  for (let i = 0; i < 1001; i += 1) video(bea.collection, 2);
  streamAsked.length = 0;
  is("a store with more than a thousand videos is read page after page", [await measure(bea.folder, t0), streamAsked.length], [2002, 2]);
  is("a month changes with the reading", [await measure(bea.folder, Date.UTC(2026, 10, 1, 0, 30)), await watchedIn(bea.folder, "2026-11")], [0, 0]);
  [...videos.values()].find((v) => v.collectionId === bea.collection)!.totalWatchTime = 62;
  is("the last hour of a month, read in the next, is counted there and once", [await measure(bea.folder, Date.UTC(2026, 10, 1, 0, 30)), await watchedIn(bea.folder, "2026-11"), await watchedIn(bea.folder, month)], [60, 60, 2002]);
  is("a store with no videos at the service has watched nothing", [await streamWatched("f".repeat(32)), await measure("f".repeat(32), t0)], [[], 0]);

  part("Past the hours, nothing is put on an invoice (232 [CA1] unit 3)");
  const now = Date.UTC(2026, 9, 21, 14, 0, 0);
  await setSubscription("ana@example.com", { customerId: "cus_Ana0001", subscriptionId: "sub_Ana0001", active: true, cycle: "month", period: paidPeriod() });
  stripeAsked.length = 0;
  lines.length = 0;
  for (const past of [50 * HOUR, 101 * HOUR, 1000 * HOUR]) {
    await watched(ana.folder, month, VIDEO_SECONDS_INCLUDED + past);
    const row = await settleAt(ana.folder, month, false, now);
    is(`${past / HOUR} hours past them owes nothing and adds nothing`, [row.state, row.owed, row.added], ["nothing", 0, 0]);
  }
  is("when the month is over nothing is billed either", [(await settleAt(ana.folder, month, true, Date.UTC(2026, 10, 1, 14))).added, lines.length], [0, 0]);
  const cal = await storeWith("cal@example.com", "cal");
  await setSubscription("cal@example.com", { customerId: "cus_Cal0001", subscriptionId: "sub_Cal0001", active: true, cycle: "year", period: paidPeriod() });
  await watched(cal.folder, month, VIDEO_SECONDS_INCLUDED + 300 * HOUR);
  is("a yearly plan is not switched to billing added lines monthly", [(await settleAt(cal.folder, month, true, now)).added, monthly], [0, []]);
  // A line begun before 31 October 2026 and left unfinished is dropped, never charged after use.
  await redis.pipeline([["SET", `nl:watch:adding:${ana.folder}:${month}`, JSON.stringify({ from: 0, to: 150, at: now, amount: VIDEO_SECONDS_INCLUDED + 50 * HOUR, line: "old line", customerId: "cus_Ana0001", subscriptionId: "sub_Ana0001" })]]);
  const stale = await settleAt(ana.folder, month, true, now);
  is("an unfinished line from before is dropped, not finished", [stale.state, stale.added, lines.length, (await redis.pipeline([["GET", `nl:watch:adding:${ana.folder}:${month}`]]))[0]], ["nothing", 0, 0, null]);
  is("Stripe is never asked to add a line", [stripeAsked.filter((p) => p.includes("invoiceitems")).length, lines.length], [0, 0]);
  is("the legacy price is kept only as history: the meter does not use it", videoOwedCents(VIDEO_SECONDS_INCLUDED + HOUR) > 0, true);

  part("A store with no plan that can be charged");
  const dee = await storeWith("dee@example.com", "dee");
  await setSubscription("dee@example.com", { customerId: "cus_Dee0001", subscriptionId: "sub_Dee0001", active: true, trialEnds: Math.floor(now / 1000) + 86_400 * 10, period: paidPeriod() });
  await watched(dee.folder, month, VIDEO_SECONDS_INCLUDED + 300 * HOUR);
  stripeAsked.length = 0;
  const trial = await settleAt(dee.folder, month, false, now);
  is("in its free trial, nothing is put on an invoice", [trial.state, trial.added, stripeAsked], ["nothing", 0, []]);

  // Its video plays for the hours a plan covers, and is paused past them.
  const lessonPath = streamPath(dee.folder, "abcdefghij12", guid());
  const lessonId = lessonPath.split("/")[3];
  await redis.pipeline([
    ["SET", `nl:stream:v:${lessonId}`, JSON.stringify({ id: lessonId, path: lessonPath, name: "lesson.mp4", type: "video/mp4", bytes: 1000, state: "ready", at: Date.now(), seconds: 600, width: 1920, height: 1080, settled: true })],
  ]);
  const file = { pathname: lessonPath, name: "lesson.mp4", bytes: 1000, contentType: "video/mp4", addedAt: new Date(0).toISOString() };
  const thisMonth = monthKey();
  await watched(dee.folder, thisMonth, VIDEO_SECONDS_INCLUDED - 1);
  is("inside the hours its video plays", (await lessonVideo(file, VIDEO_SECONDS_INCLUDED))?.kind, "stream");
  is("and the store is put in line to be read", typeof (await redis.pipeline([["ZSCORE", "nl:watch:due", dee.folder]]))[0], "string");
  await watched(dee.folder, thisMonth, VIDEO_SECONDS_INCLUDED);
  is("at the hours it is paused", await lessonVideo(file, VIDEO_SECONDS_INCLUDED), { kind: "paused" });
  is("a null limit cannot bypass a paid store playback threshold", [(await watched(dee.folder, thisMonth, VIDEO_SECONDS_INCLUDED * 50), await lessonVideo(file, null))?.kind], [undefined]);

  part("The daily run");
  lines.length = 0;
  keys.clear();
  const fay = await storeWith("fay@example.com", "fay");
  await setSubscription("fay@example.com", { customerId: "cus_Fay0001", subscriptionId: "sub_Fay0001", active: true, period: paidPeriod() });
  const gus = await storeWith("gus@example.com", "gus");
  await setSubscription("gus@example.com", { customerId: "cus_Gus0001", subscriptionId: "sub_Gus0001", active: true, period: paidPeriod() });
  await watched(fay.folder, "2026-11", VIDEO_SECONDS_INCLUDED + 10 * HOUR);
  await watched(fay.folder, "2026-12", VIDEO_SECONDS_INCLUDED + 40 * HOUR);
  await watched(gus.folder, "2026-12", VIDEO_SECONDS_INCLUDED - 60);
  // Only this part's stores: a store from the parts above recorded its hours under the
  // real month (monthKey()), which from 1 November 2026 is the "2026-11" read here.
  const ours = (r: { folder: string }) => r.folder === fay.folder || r.folder === gus.folder;
  const early = (await settleAll(Date.UTC(2026, 11, 2, 14))).filter(ours);
  is("in a month's first days the month before is read and owes nothing", early.filter((r) => r.month === "2026-11").map((r) => [r.folder === fay.folder, r.state, r.added]), [[true, "nothing", 0]]);
  is("and the month that is running owes nothing either", early.filter((r) => r.month === "2026-12").map((r) => [r.folder === fay.folder, r.state, r.added]), [[true, "nothing", 0]]);
  is("a store inside its hours is not in it at all", early.some((r) => r.folder === gus.folder), false);
  const later = (await settleAll(Date.UTC(2026, 11, 20, 14))).filter(ours);
  is("later in the month, the month before is left closed, and no line was ever added", [later.some((r) => r.month === "2026-11"), lines.length], [false, 0]);
  is("a creator is written to about a month once", [await firstWord(fay.folder, "2026-12"), await firstWord(fay.folder, "2026-12"), await firstWord(fay.folder, "2027-01")], [true, false, true]);


  part("What the pages say is what is charged");
  const terms = read("app/terms/page.tsx");
  is("the Terms disclose a finite video threshold", [/paidVideoWords/.test(terms), /New playback pauses/.test(terms)], [true, true]);
  is("the Terms explain existing player links and separate file delivery", [/Existing player/.test(terms), /separate download path/.test(terms)], [true, true]);
  is("and no longer say a download is charged for", [/Nothing is charged for downloads/.test(terms), /OVER_ALLOWANCE/.test(terms)], [true, false]);
  const studio = read("app/studio/page.tsx");
  is("the studio shows the hours and the playback pause", [/hoursWords\(videoRoom\)/.test(studio), /New stream playback pauses/.test(studio)], [true, true]);
  is("the home page discloses finite video admission", /new playback pauses at the threshold/.test(read("components/home-parts.tsx")), true);
  const help = read("lib/help-content.ts");
  const features = read("lib/feature-pages.ts");
  is("the help explains the finite playback threshold", help.includes("New playback pauses at that threshold"), true);
  is("the course feature page explains pauses", features.includes("New playback pauses at the recorded threshold"), true);
  is("nothing still says video counts as a download", [/Videos watched count toward/.test(help), /Videos watched count toward/.test(features)], [false, false]);
  is("a lesson's video is no longer counted by the page that opens it", /recordDelivery\(file\.pathname, viewingBytes/.test(read("lib/learn.ts")), false);
  is("the daily job still runs and is scheduled", [/settleAll/.test(read("app/api/cron/usage/route.ts")), /\/api\/cron\/usage/.test(read("vercel.json"))], [true, true]);
  is("the daily job never tells a creator of a charge after use", /videoOwedCents|canBeCharged/.test(read("app/api/cron/usage/route.ts")), false);
  const naming = ["lib", "app", "components", "scripts"].flatMap((dir) => filesUnder(dir)).filter((f) => f !== "lib/billing.ts" && /\baddToNextInvoice\b/.test(read(f)));
  is("nothing but the usage meters names addToNextInvoice, however it is imported", naming, ["lib/usage-billing.ts"]);
  is("and lib/billing.ts only defines it", (read("lib/billing.ts").match(/\baddToNextInvoice\s*\(/g) ?? []).length, 1);
  is("no meter owes anything after use", [/owed: \(\) => 0/.test(read("lib/watch-billing.ts")), /owed: \(\) => 0/.test(read("lib/traffic-billing.ts")), /owed: \(\) => 0/.test(read("lib/orders-billing.ts"))], [true, true, true]);
  is("and the five-minute job is the one that reads", /measureDue/.test(read("app/api/cron/stream/route.ts")), true);

  done();
}

/** A flat list of pairs, as a hash is read back, in pairs. */
function chunk(flat: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
