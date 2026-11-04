/**
 * A store whose plan has ended, and what it still keeps (lib/plan-closing.ts).
 *
 * A store with no plan may keep five gigabytes (lib/plan-standing.ts). One
 * whose plan ends may be keeping forty times that, put there while it paid,
 * and until this was written it kept it for ever at our cost. So what such a
 * store keeps past that room has a date on it: sixty days from the end of
 * the plan, said three times before it comes.
 *
 * This is the one thing here that deletes what a creator put here without
 * being asked to. What these hold, each against stand-ins for the file
 * store, the video service, Stripe and the email sender:
 *
 *   - a store that fits is never written to and never touched;
 *   - one that does not is written to when its plan ends, thirty days before
 *     the day and seven days before it, once each;
 *   - nothing is removed before the day, nor sooner than a week after the
 *     last notice went out, however late that was;
 *   - nothing is removed on our own note that the plan is over: Stripe is
 *     asked that day, and a plan it says is running is written back down;
 *   - nothing is removed, and nobody is told it was, when Stripe, the email
 *     sender or the file store could not be reached;
 *   - what is removed is the files and the videos, records first; the store,
 *     its products, its prices and its lessons stay;
 *   - a plan that ended, ran again and ended again starts from nothing.
 *
 * The host's own file store has no stand-in (its library does not ask
 * through `fetch`), so the stores here keep nothing in it, and its listing
 * is answered as empty.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { syncSubscriptions } from "@/lib/billing-sync";
import { readAllListings, readListing } from "@/lib/catalog";
import { type Course, readCourse, saveCourse } from "@/lib/course";
import { deleteFile, listFiles } from "@/lib/file-store";
import { CLOSING_DAYS, type Hands, RECHECK_DAYS, WARN_MONTH_DAYS, WARN_WEEK_DAYS, closeEnded, closeOne, closingOf, finishClosed, noticeFor, removalDay } from "@/lib/plan-closing";
import { eraseClosed } from "@/lib/closed-store-data";
import { lastPlanMoment } from "@/lib/closing-plan-guard";
import { KEEP_NOTHING_FROM, keptRoomFor } from "@/lib/plan-closing-rules";
import { communityFolder } from "@/lib/community-image";
import { picturesKept, takePicturePlace } from "@/lib/community-files";
import { PICTURE_BYTES } from "@/lib/community-picture-rules";
import { HELP_SECTIONS } from "@/lib/help-content";
import { ENDED_INDEX, SETUP_STORAGE_BYTES } from "@/lib/plan-standing";
import { readPodcast, savePodcast } from "@/lib/podcast";
import type { ProductFile } from "@/lib/product-file";
import { storageWords } from "@/lib/storage-quota";
import { addOption, addProduct, claimHandle, setCommunity, setProductCourse, setProductFile, setProductPodcast, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { STREAM_API_ORIGIN, streamPath } from "@/lib/stream-rules";
import { vaultPath } from "@/lib/vault-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const GB = 1024 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
/** The day what a store keeps is removed, and the days its second and last notices go out, counted from the end of its plan. */
const C = CLOSING_DAYS;
const M = CLOSING_DAYS - WARN_MONTH_DAYS;
const W = CLOSING_DAYS - WARN_WEEK_DAYS;
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const BUCKET = "sold-files";
const R2 = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const LIBRARY = "4242";
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

// ---------------------------------------------------------- the file store

/** What is kept, by path, and how big each says it is. */
const objects = new Map<string, number>();
let fileStore: "up" | "down" = "up";

// ------------------------------------------------------- the video service

type Video = { guid: string; collectionId: string; totalWatchTime: number; storageSize: number };
const videos = new Map<string, Video>();
let videoService: "up" | "down" = "up";
let made = 0;
const guid = () => {
  made += 1;
  return `00000000-0000-4000-8000-${String(made).padStart(12, "0")}`;
};

// ------------------------------------------------------------------ Stripe

/** The subscriptions Stripe says are running, by the store's address. */
const running = new Map<string, Record<string, unknown>>();
let stripe: "up" | "down" = "up";
const stripeAsked: string[] = [];

// --------------------------------------------------------------- the email

type Sent = { to: string[]; subject: string; text: string; reply_to?: string };
const sent: Sent[] = [];
let mail: "up" | "down" | "uncertain" = "up";
let mailAttempts = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

  if (url.origin === R2) {
    if (fileStore === "down") return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
    const key = url.pathname.slice(`/${BUCKET}/`.length);
    if (!key) {
      const all = [...objects.keys()].filter((k) => k.startsWith(url.searchParams.get("prefix") ?? "")).sort();
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${all.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)}</Size></Contents>`).join("")}</ListBucketResult>`, { status: 200 });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }

  if (url.origin === STREAM_API_ORIGIN) {
    if (videoService === "down") throw new TypeError("fetch failed");
    const path = url.pathname.replace(`/library/${LIBRARY}`, "");
    if (path === "/videos" && method === "GET") {
      const all = [...videos.values()].filter((v) => v.collectionId === url.searchParams.get("collection"));
      return json({ totalItems: all.length, currentPage: 1, itemsPerPage: 1000, items: all });
    }
    if (path.startsWith("/videos/") && method === "DELETE") {
      return json({ success: videos.delete(path.slice("/videos/".length)) });
    }
    return json({}, 404);
  }

  if (url.origin === "https://api.stripe.com") {
    const path = url.pathname.replace(/^\/v1/, "");
    stripeAsked.push(`${method} ${path}`);
    if (stripe === "down") throw new TypeError("fetch failed");
    if (path === "/subscriptions/search") {
      const query = url.searchParams.get("query") ?? "";
      return json({ data: [...running.entries()].filter(([handle]) => query.includes(`'${handle}'`)).map(([, subscription]) => subscription), has_more: false });
    }
    if (path === "/subscriptions") return json({ data: [], has_more: false });
    const one = [...running.values()].find((subscription) => path === `/subscriptions/${String(subscription.id)}`);
    if (one) return json(one);
    return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
  }

  if (url.hostname === "api.resend.com") {
    mailAttempts += 1;
    if (mail === "down") return json({ message: "unavailable" }, 429);
    if (mail === "uncertain") return json({ message: "acceptance unknown" }, 500);
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return json({ id: `email-${sent.length}` });
  }

  return new Response(null, { status: 404 });
}) as typeof fetch;

// -------------------------------------------------------------- the stores

const file = (pathname: string, name: string, bytes: number, contentType = "application/pdf"): ProductFile => ({ pathname, name, bytes, contentType, addedAt: "2026-06-01T00:00:00.000Z" });
let tokens = 0;
const token = () => {
  tokens += 1;
  return tokens.toString(16).padStart(16, "0");
};

/** Puts a file of a given size in the file store, on a product, an option or a lesson. */
function kept(folder: string, ownerId: string, name: string, bytes: number, contentType = "application/pdf"): ProductFile {
  const pathname = vaultPath(folder, ownerId, token(), name);
  objects.set(pathname, bytes);
  return file(pathname, name, bytes, contentType);
}

type Made = { email: string; handle: string; folder: string; collection: string };

/** A store on a paid plan, with a place at the video service. */
async function storeWith(handle: string): Promise<Made> {
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, `${handle[0].toUpperCase()}${handle.slice(1)} Studio`, "");
  await setSubscription(email, { customerId: `cus_${handle}0001`, subscriptionId: `sub_${handle}0001`, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  const folder = await storeFolder(email);
  const collection = guid();
  await redis.pipeline([["SET", `nl:stream:col:${folder}`, collection]]);
  return { email, handle, folder, collection };
}

/** A product that hands over one file of a given size. */
async function productWith(made: Made, title: string, bytes: number): Promise<string> {
  const added = await addProduct(made.email, title, "", "19", null);
  if (!added.ok) throw new Error(`no product: ${added.reason}`);
  const put = await setProductFile(made.email, added.product.id, kept(made.folder, added.product.id, `${title}.pdf`, bytes));
  if (!put.ok) throw new Error(`no file: ${put.reason}`);
  return added.product.id;
}

/** What a store keeps, as its stores say: every file under its folder, every video in its collection. */
const measured: string[] = [];
const hands: Hands = {
  measure: async (folder) => {
    measured.push(folder);
    let bytes = 0;
    for (const [path, size] of objects) if (path.startsWith(`vault/${folder}/`)) bytes += size;
    const [collection] = await redis.pipeline([["GET", `nl:stream:col:${folder}`]]);
    for (const video of videos.values()) if (video.collectionId === collection) bytes += video.storageSize;
    return bytes;
  },
  // Nothing here is kept in the host's own file store.
  list: async (prefix) => (prefix.startsWith("stores/") ? [] : listFiles(prefix)),
  remove: deleteFile,
};

/** The day a store's plan ended, as written on it. */
const endedAt = async (email: string) => Date.parse((await storeForEmail(email))?.planEndedAt ?? "");
const endPlan = (email: string) => setSubscription(email, { active: false });
const inLine = async (email: string) => {
  const [score] = await redis.pipeline([["ZSCORE", ENDED_INDEX, email]]);
  return score === null ? null : Number(score);
};
const mailTo = (email: string) => sent.filter((m) => m.to.includes(email));
const dateWords = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

/** Runs something that is expected to complain, and answers how often it did. */
async function quietly<T>(work: () => Promise<T>): Promise<{ answer: T; complaints: number }> {
  const real = console.error;
  let complaints = 0;
  console.error = () => {
    complaints += 1;
  };
  try {
    return { answer: await work(), complaints };
  } finally {
    console.error = real;
  }
}

/** The clock every part runs on: set back to before KEEP_NOTHING_FROM for the rule most parts check, forward for the one that replaced it. */
const realNow = Date.now.bind(Date);
const clockAt = (ms: number) => {
  const shift = ms - realNow();
  Date.now = () => realNow() + shift;
};

async function main(): Promise<void> {
  // A synthetic company address, so the buyers' notice of a plan that ends from 31 October 2026 can go (lib/company-postal.ts).
  process.env.COMPANY_POSTAL_ADDRESS = "100 Example Street, Example City, NY 10001, United States";
  redis.clear();
  // A plan that ended before 18 October 2026 keeps a store with no plan's room (lib/plan-closing-rules.ts).
  clockAt(Date.UTC(2026, 9, 10, 12, 0, 0));
  for (const [name, value] of [
    ["R2_ACCOUNT_ID", ACCOUNT],
    ["R2_ACCESS_KEY_ID", "a-stand-in-access-key-id"],
    ["R2_SECRET_ACCESS_KEY", "a-stand-in-secret-access-key-for-tests-only"],
    ["R2_BUCKET", BUCKET],
    ["BUNNY_STREAM_LIBRARY_ID", LIBRARY],
    ["BUNNY_STREAM_API_KEY", "a-stand-in-library-key-for-tests-only"],
    ["BUNNY_STREAM_TOKEN_KEY", "a-stand-in-token-key-for-tests-only"],
    ["STRIPE_SECRET_KEY", "sk_test_a_stand_in_key_for_tests_only"],
    ["RESEND_API_KEY", "re_test_a_stand_in_key_for_tests_only"],
  ]) {
    process.env[name] = value;
  }

  part("The days");
  const E = Date.UTC(2026, 9, 1, 12, 0, 0);
  is("what a store keeps past its room is removed thirty days after its plan ended", [CLOSING_DAYS, removalDay(E) - E], [30, 30 * DAY]);
  is("with a notice when the plan ends, one fourteen days before and one seven days before", [WARN_MONTH_DAYS, WARN_WEEK_DAYS, noticeFor(E, E), noticeFor(E, E + (M - 1) * DAY), noticeFor(E, E + M * DAY), noticeFor(E, E + (W - 1) * DAY), noticeFor(E, E + W * DAY), noticeFor(E, E + (C + 110) * DAY)], [14, 7, "ended", "ended", "month", "month", "week", "week"]);

  part("A store whose plan runs is not in line");
  const ana = await storeWith("ana");
  const guide = await productWith(ana, "Guide", 3 * GB);
  // A product sold at two prices, with a file on one of them.
  const pack = await addProduct(ana.email, "Pack", "", "29", null);
  if (!pack.ok) throw new Error("no pack");
  await addOption(ana.email, pack.product.id, "Standard", "29");
  const standard = (await readListing((await storeForEmail(ana.email))!, pack.product.id))!.options[0];
  await setProductFile(ana.email, standard.id, kept(ana.folder, standard.id, "pack.zip", GB, "application/zip"));
  // A course: one lesson with a video and a worksheet, one with words only.
  const lessonVideo: Video = { guid: guid(), collectionId: ana.collection, totalWatchTime: 900, storageSize: 4 * GB };
  videos.set(lessonVideo.guid, lessonVideo);
  const course: Course = {
    id: "c".repeat(32),
    certificate: true,
    startsAt: null,
    modules: [
      {
        id: "module000001",
        title: "Week one",
        dripDays: 0,
        lessons: [
          { id: "lesson000001", title: "Watch this", preview: true, video: file(streamPath(ana.folder, "lesson000001", lessonVideo.guid), "intro.mp4", 4 * GB, "video/mp4"), files: [kept(ana.folder, "lesson000001", "worksheet.pdf", GB / 2)], link: null, hasBody: true, quiz: null },
          { id: "lesson000002", title: "Read this", preview: false, video: null, files: [], link: "https://example.com/reading", hasBody: true, quiz: null },
        ],
      },
    ],
  };
  await saveCourse(course, ROOM);
  const lessons = await addProduct(ana.email, "Course", "", "99", null);
  if (!lessons.ok) throw new Error("no course product");
  is("a course", (await setProductCourse(ana.email, lessons.product.id, { id: course.id, lessons: 2 })).ok, true);
  // A private podcast with two episodes.
  const show = await addProduct(ana.email, "Podcast", "", "9", null);
  if (!show.ok) throw new Error("no podcast product");
  const podcastId = "d".repeat(32);
  await savePodcast({
    id: podcastId,
    episodes: [
      { id: "episode00001", title: "One", notes: "", pathname: kept(ana.folder, show.product.id, "one.mp3", Math.floor(GB / 5), "audio/mpeg").pathname, bytes: Math.floor(GB / 5), contentType: "audio/mpeg", at: 1_780_000_000 },
      { id: "episode00002", title: "Two", notes: "", pathname: kept(ana.folder, show.product.id, "two.mp3", Math.floor(GB / 5), "audio/mpeg").pathname, bytes: Math.floor(GB / 5), contentType: "audio/mpeg", at: 1_780_600_000 },
    ],
  });
  is("a podcast", (await setProductPodcast(ana.email, show.product.id, { id: podcastId, episodes: 2 })).ok, true);
  // And what no record names: a copy stamped for a buyer, a video no lesson has any more.
  objects.set(`vault/${ana.folder}/${guide}/stamped/order-1.pdf`, Math.floor(GB / 10));
  const stray: Video = { guid: guid(), collectionId: ana.collection, totalWatchTime: 0, storageSize: 2 * GB };
  videos.set(stray.guid, stray);
  const anaKeeps = await hands.measure(ana.folder);
  is("she keeps eleven gigabytes, more than twice what a store with no plan may", [storageWords(anaKeeps), SETUP_STORAGE_BYTES], ["11 GB", 5 * GB]);

  const ben = await storeWith("ben");
  await productWith(ben, "Notes", GB);
  await claimHandle("cyd@example.com", "cyd", "Cyd", "");
  measured.length = 0;
  is("nobody is in line while their plan runs, or before they ever had one", [await inLine(ana.email), await inLine(ben.email), await inLine("cyd@example.com")], [null, null, null]);
  is("and a run looks at nobody", [await closeEnded(Date.now() + 20_000, Date.now(), hands), measured.length, sent.length], [[], 0, 0]);

  part("The plan ends");
  await endPlan(ana.email);
  await endPlan(ben.email);
  const A = await endedAt(ana.email);
  is("each is in line under the day its plan ended", [await inLine(ana.email), (await inLine(ben.email)) === (await endedAt(ben.email)), await inLine("cyd@example.com")], [A, true, null]);
  is("seen again as ended, a store keeps its place", [(await endPlan(ana.email))?.planEndedAt === new Date(A).toISOString(), await inLine(ana.email)], [true, A]);

  mail = "down";
  const unsent = await quietly(() => closeOne(ana.email, A + 60_000, hands));
  is("a notice that cannot be sent is not written down as sent", [unsent.answer.state, unsent.answer.note, sent.length], ["held", "the notice could not be sent", 0]);
  mail = "up";
  const first = await closeEnded(Date.now() + 20_000, A + 2 * 60_000, hands);
  is("the store that keeps more than its room is written to; the one that fits is left alone", first.map((row) => [row.key, row.state, row.note ?? ""]), [[ana.email, "told", "ended"], [ben.email, "fits", ""]]);
  const one = mailTo(ana.email)[0];
  is("one email, to the store's owner, with replies going to the people who answer", [sent.length, mailTo(ben.email).length, one.to, typeof one.reply_to], [1, 0, [ana.email], "string"]);
  is("it says the plan ended and that nothing has been removed", [one.subject, one.text.includes(`ended on ${dateWords(A)}`), one.text.includes("nothing has been removed")], ["Ana Studio: what happens to your files now that your plan has ended", true, true]);
  is("it gives the room, what the store keeps, and the day", [one.text.includes(`may keep ${storageWords(SETUP_STORAGE_BYTES)} of files`), one.text.includes("Yours keeps\n11 GB."), one.text.includes(`On ${dateWords(A + C * DAY)}, ${CLOSING_DAYS} days after your plan ended`)], [true, true, true]);
  is("the two ways out", [one.text.includes("start a plan again, and everything stays exactly as it is"), one.text.includes(`until your store keeps ${storageWords(SETUP_STORAGE_BYTES)} or less`)], [true, true]);
  is("what goes and what stays", [one.text.includes("After that day your buyers can no longer\ndownload those files or watch those videos"), one.text.includes("What stays: your store and its page, your products and their prices"), one.text.includes("your contacts and your orders")], [true, true, true]);
  is("and that two more notices come first, the last at least a week before", one.text.includes("We will write to you again 14 days before that day and 7 days before it. Nothing is removed without a notice at least a week old."), true);
  is("the same day again, nobody is written to twice", [(await closeOne(ana.email, A + 3 * 60_000, hands)).state, sent.length], ["waiting", 1]);

  part("A store that fits is measured once a week, not once a day");
  measured.length = 0;
  await closeOne(ben.email, A + DAY, hands);
  await closeOne(ben.email, A + (RECHECK_DAYS - 1) * DAY, hands);
  is("not again inside the week", measured.filter((folder) => folder === ben.folder).length, 0);
  is("and again after it", [(await closeOne(ben.email, A + (RECHECK_DAYS + 1) * DAY, hands)).state, measured.filter((folder) => folder === ben.folder).length], ["fits", 1]);
  is("a store that keeps more is measured every day it is looked at", [(await closeOne(ana.email, A + DAY, hands)).state, (await closeOne(ana.email, A + 2 * DAY, hands)).state, measured.filter((folder) => folder === ana.folder).length], ["waiting", "waiting", 2]);

  part("The notices before the day");
  is("nothing more is said until two weeks before the day", [(await closeOne(ana.email, A + (M - 1) * DAY, hands)).state, sent.length], ["waiting", 1]);
  is("fourteen days before, the second", [await closeOne(ana.email, A + M * DAY, hands), sent.length], [{ key: ana.email, state: "told", note: "month" }, 2]);
  const two = mailTo(ana.email)[1];
  is("with the days left and the same day named", [two.subject, two.text.includes(`On ${dateWords(A + C * DAY)}`), two.text.includes("We will write to you once more, 7 days before that day.")], ["14 days until the files Ana Studio keeps are removed", true, true]);
  is("once", [(await closeOne(ana.email, A + (M + 1) * DAY, hands)).state, (await closeOne(ana.email, A + (W - 1) * DAY, hands)).state, sent.length], ["waiting", "waiting", 2]);
  is("seven days before, the last", [await closeOne(ana.email, A + W * DAY, hands), sent.length], [{ key: ana.email, state: "told", note: "week" }, 3]);
  const three = mailTo(ana.email)[2];
  is("which says it is the last", [three.subject, three.text.includes("This is the last notice before that day."), three.text.includes(`On ${dateWords(A + C * DAY)}`)], ["7 days until the files Ana Studio keeps are removed", true, true]);
  const before = { objects: objects.size, videos: videos.size };
  is("and until the day nothing is touched", [(await closeOne(ana.email, A + (C - 1) * DAY, hands)).state, sent.length, objects.size === before.objects, videos.size === before.videos, stripeAsked.length], ["waiting", 3, true, true, 0]);

  part("What the studio is told");
  is("the day the job will act on, for a store whose last notice went out in time", await closingOf((await storeForEmail(ana.email))!, A + (W + 2) * DAY), { endedAt: A, day: A + C * DAY });
  is("nothing for a store whose plan runs, or that never had one", [await closingOf((await storeForEmail("cyd@example.com"))!, A), await closingOf({ ...(await storeForEmail(ana.email))!, subscriptionActive: true, planEndedAt: "" }, A)], [null, null]);

  part("The day: Stripe is asked before anything is touched");
  stripe = "down";
  const unasked = await quietly(() => closeOne(ana.email, A + C * DAY, hands));
  is("when it cannot be asked, nothing is removed", [unasked.answer.state, unasked.answer.note, objects.size === before.objects, videos.size === before.videos, sent.length], ["held", "Stripe could not be asked", true, true, 3]);
  stripe = "up";

  // A store whose plan Stripe says is running, whatever its record here says.
  const eve = await storeWith("eve");
  const evesFile = await productWith(eve, "Archive", 6 * GB);
  await endPlan(eve.email);
  const V = await endedAt(eve.email);
  for (const day of [0, M, W]) await closeOne(eve.email, V + day * DAY, hands);
  is("told three times, like anybody", mailTo(eve.email).map((m) => m.subject.slice(0, 7)), ["Eve Stu", "14 days", "7 days "]);
  running.set("eve", { id: "sub_eve0002", status: "active", created: 1_790_000_000, current_period_start: 1_790_000_000, current_period_end: 1_792_678_400, customer: { id: "cus_eve0001", email: eve.email }, metadata: { store: "eve" }, items: { data: [{ quantity: 1, price: { currency: "usd", unit_amount: 9900, recurring: { interval: "month", interval_count: 1 } } }] } });
  const repaired = await closeOne(eve.email, V + C * DAY, hands);
  const eveNow = (await storeForEmail(eve.email))!;
  is("Stripe says the plan runs: nothing is removed and nobody is told it was", [repaired.state, repaired.note, objects.has((await readListing(eveNow, evesFile))!.file!.pathname), mailTo(eve.email).length], ["running", "Stripe says the plan runs", true, 3]);
  is("the record is put right from what Stripe said", [eveNow.subscriptionActive, eveNow.subscriptionId, eveNow.tier, eveNow.planEndedAt], [true, "sub_eve0002", "pro", ""]);
  is("and the store is out of line", [await inLine(eve.email), (await closeOne(eve.email, V + (C + 1) * DAY, hands)).state, objects.has((await readListing(eveNow, evesFile))!.file!.pathname)], [null, "running", true]);

  // And one whose own subscription, the one written on it, Stripe says is running.
  const kai = await storeWith("kai");
  await productWith(kai, "Vault", 6 * GB);
  await endPlan(kai.email);
  const K = await endedAt(kai.email);
  for (const day of [0, M, W]) await closeOne(kai.email, K + day * DAY, hands);
  running.set("nobody-by-search", { id: "sub_kai0001", status: "trialing", created: 1_790_000_000, trial_end: 1_900_000_000, customer: "cus_kai0001", metadata: {}, items: { data: [{ price: { unit_amount: 2900, recurring: { interval: "month" } } }] } });
  const own = await closeOne(kai.email, K + C * DAY, hands);
  const kaiNow = (await storeForEmail(kai.email))!;
  is("asked about by its own number first: running, so nothing is removed", [own.state, own.note, kaiNow.subscriptionActive, kaiNow.planEndedAt, [...objects.keys()].filter((path) => path.startsWith(`vault/${kai.folder}/`)).length, mailTo(kai.email).length], ["running", "Stripe says the plan runs", true, "", 1, 3]);

  part("The day: what is removed, and what stays");
  const storeBefore = (await storeForEmail(ana.email))!;
  const listed = (await readAllListings(storeBefore)).map((listing) => [listing.title, listing.priceCents]);
  const removed = await closeOne(ana.email, A + C * DAY, hands);
  is("with no plan at Stripe, what the store kept is removed", [removed.state, removed.note], ["removed", "6 files"]);
  const after = (await storeForEmail(ana.email))!;
  const now = await readAllListings(after);
  const byTitle = (title: string) => now.find((listing) => listing.title === title)!;
  is("the product's file and the price option's file are off them", [byTitle("Guide").file, byTitle("Pack").options.map((option) => option.file)], [null, [null]]);
  const courseNow = (await readCourse(course.id))!;
  const [watch, readIt] = courseNow.modules[0].lessons;
  is("the lesson's video and its download are off it", [watch.video, watch.files], [null, []]);
  is("its title, its words, its place in the course and the course's settings are as they were", [watch.title, watch.hasBody, watch.preview, readIt, courseNow.certificate, byTitle("Course").course], ["Watch this", true, true, course.modules[0].lessons[1], true, { id: course.id, lessons: 2 }]);
  is("the podcast has no episodes, and its product says so", [(await readPodcast(podcastId))?.episodes, byTitle("Podcast").podcast], [[], { id: podcastId, episodes: 0 }]);
  is("nothing of hers is left in the file store, the copy no record named among it", [...objects.keys()].filter((path) => path.startsWith(`vault/${ana.folder}/`)), []);
  is("nor at the video service, the video no lesson named among them", [...videos.values()].filter((video) => video.collectionId === ana.collection), []);
  is("what other stores keep is where it was", [[...objects.keys()].filter((path) => path.startsWith(`vault/${ben.folder}/`)).length, [...objects.keys()].filter((path) => path.startsWith(`vault/${eve.folder}/`)).length], [1, 1]);
  is("the store is still hers: its address, its name, every product and every price", [after.handle, after.name, now.map((listing) => [listing.title, listing.priceCents]), now.length], [storeBefore.handle, storeBefore.name, listed, 4]);
  const last = mailTo(ana.email)[3];
  is("she is told, once, what was removed and what was not", [mailTo(ana.email).length, last.subject, last.text.includes("have now been removed"), last.text.includes("Your store is still yours"), last.text.includes("Start\na plan again and you can put a file back on each product")], [4, "The files Ana Studio kept have been removed", true, true, true]);
  is("and her studio has no day to show any more", await closingOf(after, A + (C + 1) * DAY), null);
  measured.length = 0;
  is("and after that she is a store that fits: not measured, not written to", [(await closeOne(ana.email, A + (C + 1) * DAY, hands)).state, (await closeOne(ana.email, A + (C + 110) * DAY, hands)).state, measured.length, mailTo(ana.email).length], ["fits", "fits", 0, 4]);

  part("A last notice that went out late moves the day");
  const dee = await storeWith("dee");
  await productWith(dee, "Library", 8 * GB);
  await endPlan(dee.email);
  const D = await endedAt(dee.email);
  await closeOne(dee.email, D, hands);
  await closeOne(dee.email, D + M * DAY, hands);
  mail = "down";
  const late = await quietly(async () => [(await closeOne(dee.email, D + W * DAY, hands)).state, (await closeOne(dee.email, D + (W + 4) * DAY, hands)).state]);
  is("the email sender is down for the days it was due", [late.answer, mailTo(dee.email).length], [["held", "held"], 2]);
  mail = "up";
  is("it goes out five days late", (await closeOne(dee.email, D + (W + 5) * DAY, hands)).note, "week");
  const lateNotice = mailTo(dee.email)[2];
  is("and names the day it makes true, a week on, not the day first given", [lateNotice.text.includes(`On ${dateWords(D + (C + 5) * DAY)}`), lateNotice.text.includes(`On ${dateWords(D + C * DAY)}`), lateNotice.subject], [true, false, "7 days until the files Dee Studio keeps are removed"]);
  const deeFolder = () => [...objects.keys()].filter((path) => path.startsWith(`vault/${dee.folder}/`)).length;
  is("the studio shows that later day", (await closingOf((await storeForEmail(dee.email))!, D + (C - 1) * DAY))?.day, D + (C + 5) * DAY);
  is("nothing is removed on the day first given, nor the minute before the week is up", [(await closeOne(dee.email, D + C * DAY, hands)).state, (await closeOne(dee.email, D + (C + 5) * DAY - 60_000, hands)).state, deeFolder()], ["waiting", "waiting", 1]);

  part("A removal that could not be seen through is not written down as done");
  fileStore = "down";
  const half = await quietly(() => closeOne(dee.email, D + (C + 5) * DAY, hands));
  is("the file store is down on the day: held, and nobody is told anything was removed", [half.answer.state, half.answer.note, deeFolder(), mailTo(dee.email).length, half.complaints > 0], ["held", "removed 1, and something could not be removed", 1, 3, true]);
  fileStore = "up";
  const again = await closeOne(dee.email, D + (C + 6) * DAY, hands);
  is("the next day it is finished from what is left in the folder, and then she is told", [again.state, deeFolder(), mailTo(dee.email).length, mailTo(dee.email)[3]?.subject], ["removed", 0, 4, "The files Dee Studio kept have been removed"]);

  const fay = await storeWith("fay");
  await productWith(fay, "Films", 2 * GB);
  const faysVideo: Video = { guid: guid(), collectionId: fay.collection, totalWatchTime: 0, storageSize: 9 * GB };
  videos.set(faysVideo.guid, faysVideo);
  await endPlan(fay.email);
  const F = await endedAt(fay.email);
  for (const day of [0, M, W]) await closeOne(fay.email, F + day * DAY, hands);
  videoService = "down";
  const noVideo = await quietly(() => closeOne(fay.email, F + C * DAY, hands));
  is("nor when the video service cannot be read", [noVideo.answer.state, videos.has(faysVideo.guid), mailTo(fay.email).length], ["held", true, 3]);
  videoService = "up";
  mail = "down";
  const untold = await quietly(() => closeOne(fay.email, F + (C + 1) * DAY, hands));
  is("until it can", [untold.answer.state, videos.has(faysVideo.guid), mailTo(fay.email).length], ["removed", false, 3]);
  mail = "up";
  is("the letter saying so, which could not be sent that day, goes out on the next, once", [(await closeOne(fay.email, F + (C + 2) * DAY, hands)).state, (await closeOne(fay.email, F + (C + 3) * DAY, hands)).state, mailTo(fay.email).length, mailTo(fay.email)[3]?.subject], ["fits", "fits", 4, "The files Fay Studio kept have been removed"]);

  const joy = await storeWith("joy");
  for (const title of ["One", "Two", "Three"]) await productWith(joy, title, 2 * GB);
  await endPlan(joy.email);
  const J = await endedAt(joy.email);
  for (const day of [0, M, W]) await closeOne(joy.email, J + day * DAY, hands);
  const joysFiles = () => [...objects.keys()].filter((path) => path.startsWith(`vault/${joy.folder}/`)).length;
  const short = await quietly(() => closeOne(joy.email, J + C * DAY, hands, Date.now() - 1));
  is("nor when the run is out of time before the files are gone: it stops, and says nothing yet", [short.answer.state, joysFiles(), mailTo(joy.email).length], ["held", 3, 3]);
  is("and the next run finishes it from what is left", [(await closeOne(joy.email, J + (C + 1) * DAY, hands)).state, joysFiles(), mailTo(joy.email).length], ["removed", 0, 4]);

  part("A store that makes room is left alone");
  const gil = await storeWith("gil");
  const gilsBig = await productWith(gil, "Raw footage", 7 * GB);
  await productWith(gil, "Final cut", 2 * GB);
  await endPlan(gil.email);
  const G = await endedAt(gil.email);
  await closeOne(gil.email, G, hands);
  // He deletes the big one himself, as the notice says he can.
  const taken = await setProductFile(gil.email, gilsBig, null);
  if (taken.ok && taken.removed) objects.delete(taken.removed.pathname);
  is("having deleted enough to fit, he is not written to again, and nothing of his is removed", [(await closeOne(gil.email, G + M * DAY, hands)).state, (await closeOne(gil.email, G + W * DAY, hands)).state, (await closeOne(gil.email, G + (C + 30) * DAY, hands)).state, mailTo(gil.email).length, [...objects.keys()].filter((path) => path.startsWith(`vault/${gil.folder}/`)).length], ["fits", "fits", "fits", 1, 1]);

  // Long after, copies stamped for his buyers take him past his room again.
  objects.set(`vault/${gil.folder}/stamped/later.pdf`, 4 * GB);
  const afresh = await closeOne(gil.email, G + (C + 60) * DAY, hands);
  is("should he ever keep more again, he is told from the start and has his week from that notice", [afresh.state, afresh.note, mailTo(gil.email)[1].text.includes(`On ${dateWords(G + (C + 67) * DAY)}`), (await closeOne(gil.email, G + (C + 66) * DAY, hands)).state], ["told", "week", true, "waiting"]);

  part("A plan that ran again and ended again starts from nothing");
  const hal = await storeWith("hal");
  await productWith(hal, "Masters", 6 * GB);
  await endPlan(hal.email);
  const H1 = await endedAt(hal.email);
  await closeOne(hal.email, H1, hands);
  await closeOne(hal.email, H1 + M * DAY, hands);
  await setSubscription(hal.email, { active: true });
  is("a plan started again takes the store out of line at once", [await inLine(hal.email), (await closeOne(hal.email, H1 + (M + 1) * DAY, hands)).state], [null, "running"]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await endPlan(hal.email);
  const H2 = await endedAt(hal.email);
  is("ended again, it is in line under the new day", [H2 > H1, await inLine(hal.email)], [true, H2]);
  is("and every notice is still to come, the first one first", [(await closeOne(hal.email, H2 + 60_000, hands)).note, mailTo(hal.email).map((m) => m.subject.slice(0, 7))], ["ended", ["Hal Stu", "14 days", "Hal Stu"]]);
  is("with the day counted from the second ending", mailTo(hal.email)[2].text.includes(`On ${dateWords(H2 + C * DAY)}`), true);

  part("With no way to write to a creator, nothing moves");
  const ivy = await storeWith("ivy");
  await productWith(ivy, "Everything", 6 * GB);
  await endPlan(ivy.email);
  const I = await endedAt(ivy.email);
  delete process.env.RESEND_API_KEY;
  is("no sender set up: held, on any day", [(await closeOne(ivy.email, I, hands)).state, (await closeOne(ivy.email, I + 400 * DAY, hands)).state, [...objects.keys()].filter((path) => path.startsWith(`vault/${ivy.folder}/`)).length], ["held", "held", 1]);
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  is("a store first written to long after its plan ended still has its week", [(await closeOne(ivy.email, I + 400 * DAY, hands)).note, mailTo(ivy.email)[0].text.includes(`On ${dateWords(I + 407 * DAY)}`), (await closeOne(ivy.email, I + 406 * DAY, hands)).state, (await closeOne(ivy.email, I + 407 * DAY, hands)).state], ["week", true, "waiting", "removed"]);

  part("The daily run");
  const everyone = await closeEnded(Date.now() + 20_000, I + 500 * DAY, hands);
  is("looks at every store whose plan has ended, the longest ended first", everyone.map((row) => row.key), [ana.email, ben.email, dee.email, fay.email, joy.email, gil.email, hal.email, ivy.email]);
  const stopped = await closeEnded(Date.now() - 1, I + 500 * DAY, hands);
  const [mark] = await redis.pipeline([["GET", "nl:plan:closing:after"]]);
  is("out of time, it stops and writes down where", [stopped, mark], [[], String(A)]);
  await redis.pipeline([["SET", "nl:plan:closing:after", String(await endedAt(gil.email))]]);
  const rest = await closeEnded(Date.now() + 20_000, I + 500 * DAY, hands);
  const [cleared] = await redis.pipeline([["GET", "nl:plan:closing:after"]]);
  is("the next run carries on from there to the end, and the mark is cleared", [rest.map((row) => row.key), cleared], [[gil.email, hal.email, ivy.email], null]);
  await redis.pipeline([["ZREM", ENDED_INDEX, hal.email]]);
  const synced = await syncSubscriptions(Date.now() + 20_000);
  is("a store the line lost is put back by the daily check of every store's plan, under the same day", [synced.complete, await inLine(hal.email), await inLine(eve.email), await inLine("cyd@example.com")], [true, H2, null, null]);
  await redis.pipeline([["ZADD", ENDED_INDEX, 1, "nobody@example.com"]]);
  is("a store that is no longer there is taken out of line", [(await closeOne("nobody@example.com", I, hands)).state, await inLine("nobody@example.com")], ["gone", null]);

  part("Where it runs, and what the pages say");
  const job = read("app/api/cron/closing/route.ts");
  is("the job is one of ours to run, one at a time", [/cronAllowed\(request\)/.test(job), /"nl:closing:lock", "1", "NX"/.test(job), /closeEnded\(/.test(job)], [true, true, true]);
  const crons = (JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] }).crons;
  const at = (path: string) => crons.find((cron) => cron.path === path)?.schedule;
  is("every day, after the check of every store's plan", [at("/api/cron/plans"), at("/api/cron/closing")], ["0 9 * * *", "30 9 * * *"]);
  const terms = read("app/terms/page.tsx");
  is("the Terms give the days, from where the job reads them", [/A store closes \{CLOSING_DAYS\} days after its plan ends/.test(terms), /\{CLOSING_DAYS\} days after the plan ended/.test(terms), /\{WARN_MONTH_DAYS\} days before the closing day and \{WARN_WEEK_DAYS\} days\s+before it/.test(terms), /storageWords\(SETUP_STORAGE_BYTES\)/.test(terms), /from "@\/lib\/plan-closing-rules"/.test(terms)], [true, true, true, true, true]);
  is("what is removed, what is kept, and what it means for buyers", [
    /the files\s+its products hand over, its lessons&rsquo; videos and downloads, its\s+podcast&rsquo;s episodes, the files its students handed in and the\s+pictures in its community&rsquo;s posts/.test(terms),
    /everything else the store keeps with us is deleted/.test(terms),
    /No copy of the store&rsquo;s sales/.test(terms),
    /can\s+no longer be downloaded or opened here/.test(terms),
    /a store never closes sooner\s+than a week after the last of those emails/.test(terms),
    /keeps the rule it ended under: the store and its records stay/.test(terms),
  ], [true, true, true, true, true, true]);
  const help = JSON.stringify(HELP_SECTIONS);
  is("the help pages say the same", [help.includes(`stays as it is for ${CLOSING_DAYS} days`), help.includes(`${WARN_MONTH_DAYS} days before that day and ${WARN_WEEK_DAYS} days before it`), help.includes(`keeps more than ${storageWords(SETUP_STORAGE_BYTES)} has a date`), help.includes("download your whole store as one file")], [true, true, true, true]);
  is("and the privacy policy says when such files are deleted", read("app/privacy/page.tsx").includes(`deleted ${CLOSING_DAYS} days after the plan`), true);
  const studio = read("app/studio/page.tsx");
  is("and the studio shows a store past its room the day, counted the way the job counts it", [/closingOf\(store\)/.test(studio), /keptNow > keptRoom/.test(studio), /keptRoomFor\(closingAt\.endedAt\)/.test(studio), /dayWords\(closing\.day\)/.test(studio)], [true, true, true, true]);

  part("A plan that ends from October 18, 2026 keeps nothing past its day");
  clockAt(Date.UTC(2026, 9, 20, 12, 0, 0));
  is("the room it keeps with no date is none, and the old room before that day", [keptRoomFor(KEEP_NOTHING_FROM), keptRoomFor(KEEP_NOTHING_FROM - 1)], [0, SETUP_STORAGE_BYTES]);
  const zoe = await storeWith("zoe");
  await productWith(zoe, "Small", 10 * 1024 * 1024);
  const withCommunity = await setCommunity(zoe.email, true);
  const cf = communityFolder(withCommunity!.community!.id);
  // Two pictures in its community's posts, each counted when its door was given (lib/community-files.ts).
  const pictures = new Map<string, number>();
  for (const name of ["a1b2c3d4e5f6a7b8.jpg", "b1b2c3d4e5f6a7b8.jpg"]) {
    const path = `community/${cf}/${name}`;
    pictures.set(path, 400_000);
    await takePicturePlace(path, 10);
  }
  const zoeHands: Hands = {
    ...hands,
    pictures: async (id) => (await picturesKept(communityFolder(id))) * PICTURE_BYTES,
    list: async (prefix) => (prefix.startsWith("community/") ? [...pictures.keys()].filter((path) => path.startsWith(prefix)) : hands.list(prefix)),
    remove: async (paths) => {
      const others = paths.filter((path) => !pictures.delete(path));
      if (others.length) await hands.remove(others);
    },
  };
  await endPlan(zoe.email);
  const Z = await endedAt(zoe.email);
  is("it ended on that day or after", Z >= KEEP_NOTHING_FROM, true);
  const zoeFirst = await closeOne(zoe.email, Z + 60_000, zoeHands);
  const zoeLetter = mailTo(zoe.email)[0];
  is("ten megabytes and two pictures are not a store that fits: it is written to", [zoeFirst.state, zoeFirst.note], ["told", "ended"]);
  is("its letter gives the day, and one way out, and says what goes", [
    zoeLetter.text.includes(`On ${dateWords(Z + C * DAY)}, ${CLOSING_DAYS} days after your plan ended`),
    zoeLetter.text.includes(`Starting a plan again before ${new Date(lastPlanMoment(Z + C * DAY)).toLocaleString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC keeps your store`),
    zoeLetter.text.includes("delete files or lessons"),
    zoeLetter.text.includes("the files your students handed in and the\n    pictures in your community's posts"),
  ], [true, true, false, true]);
  // What the walk deletes is held in full by tests/closing-journey.ts.
  await closeOne(zoe.email, Z + M * DAY, zoeHands);
  await closeOne(zoe.email, Z + W * DAY, zoeHands);
  const zoeGone = await closeOne(zoe.email, Z + (C + 1) * DAY, zoeHands);
  is("on its day its files go, its community's pictures with them, and the store closes", [zoeGone.state, [...objects.keys()].filter((path) => path.startsWith(`vault/${zoe.folder}/`)).length, pictures.size, await picturesKept(cf)], ["removed", 0, 0, 0]);
  is("nothing it sold is charged again: it had no Stripe account to stop", stripeAsked.filter((asked) => asked.startsWith("POST")).length, 0);
  const told = mailTo(zoe.email).length;
  const walked = await eraseClosed(Date.now() + 20_000, finishClosed, Z + (C + 1) * DAY + 3_600_000);
  is("the walk deletes its records, and nobody else's", [walked.done, walked.finished, await storeForEmail(zoe.email), (await storeForEmail(ana.email))?.handle, (await storeForEmail(ben.email))?.handle], [true, 1, null, "ana", "ben"]);
  is("and its owner, told three times before, is not written to again", [told, mailTo(zoe.email).length], [3, 3]);

  part("Unknown acceptance never authorizes a second provider attempt");
  const unknownOwner = await storeWith("uncertain");
  await productWith(unknownOwner, "Kept source", 6 * GB);
  await endPlan(unknownOwner.email);
  const unknownEnd = await endedAt(unknownOwner.email);
  const attemptsBefore = mailAttempts, sentBefore = sent.length;
  mail = "uncertain";
  const unknownFirst = await closeOne(unknownOwner.email, unknownEnd + 60_000, hands);
  mail = "up";
  const unknownRetry = await closeOne(unknownOwner.email, unknownEnd + 120_000, hands);
  is("a server error may follow acceptance: hold the notice without another POST", [unknownFirst.state, unknownRetry.state, mailAttempts - attemptsBefore, sent.length - sentBefore], ["held", "held", 1, 0]);
  is("the ended-plan source and recovery entry remain available", [await endedAt(unknownOwner.email), await inLine(unknownOwner.email), (await storeForEmail(unknownOwner.email))?.handle], [unknownEnd, unknownEnd, unknownOwner.handle]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
