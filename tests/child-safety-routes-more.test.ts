/**
 * The preservation hold (lib/child-safety.ts, C1-20261109-1546-TODOS-70) reaches
 * the studio routes the review of #3471 listed as still touching a held
 * product: its license keys (set up, switched off, added, cleared, revoked),
 * its bundle (cleared or changed, and a held product put in any bundle), its
 * waitlist (the "coming soon" mark taken off or the launch, which hand over
 * pre-orders), its lessons' captions (added, removed, written by AI) and its
 * buyers' reviews (a photo deleted, a review hidden, an answer). Each is
 * refused with the neutral `on_hold` (409) before anything is written,
 * deleted or sent out; a hold that cannot be read refuses too (503). A
 * product not held is not touched by it.
 *
 * Nobody opens, downloads or describes reported content: the titles are
 * neutral placeholders, the files a few placeholder bytes that are never
 * read. Synthetic store, in-memory Redis, every outside call caught here.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductFile, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { holdReported } from "@/lib/child-safety";
import { readListing } from "@/lib/catalog";
import { readCourse, saveCourse } from "@/lib/course";
import { keyCounts } from "@/lib/licence-keys";
import { waitlistViews } from "@/lib/waitlist";
import { readReview, saveReview, setReviewPhoto } from "@/lib/reviews";
import { POST as keysRoute } from "@/app/api/store/keys/route";
import { POST as bundleRoute } from "@/app/api/store/bundle/route";
import { POST as waitlistRoute } from "@/app/api/store/waitlist/route";
import { POST as captionsRoute } from "@/app/api/store/stream/captions/route";
import { POST as reviewsRoute } from "@/app/api/store/reviews/route";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { deleted, files } from "./failure-cleanup-world";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

/** Every call the routes made outside this process; the file store is the one in memory (tests/test-config.mjs). */
const outside: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  outside.push(`${init?.method ?? "GET"} ${String(input instanceof Request ? input.url : input)}`);
  return new Response(JSON.stringify({}), { status: 404, headers: { "content-type": "application/json" } });
}) as typeof fetch;
// A video service the captions route believes in; every call to it is caught above.
process.env.BUNNY_STREAM_LIBRARY_ID = "123456";
process.env.BUNNY_STREAM_API_KEY = "k".repeat(24);
process.env.BUNNY_STREAM_TOKEN_KEY = "t".repeat(24);

type Handler = (request: NextRequest) => Promise<Response>;
const OWNER = "hold.more@example.com";
const HANDLE = "holdmore";
const ORIGIN = "https://marktmorgen.com";
/** A picture's path as the store keeps one (lib/product-image.ts). */
const picture = (n: string) => `images/${"a".repeat(24)}/${n.repeat(32)}.jpg`;

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, HANDLE, "Hold More", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_more", subscriptionId: "sub_more", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const session = await openSession(OWNER);
  const send = async (route: Handler, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`${ORIGIN}/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN, host: "marktmorgen.com" }, body: JSON.stringify(body) }));
    return [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];
  };
  const current = async () => (await storeForEmail(OWNER))!;
  const make = async (title: string, withFile = true) => {
    const made = await addProduct(OWNER, title, "", "19", null);
    if (!made.ok) throw new Error("no product");
    if (withFile) await setProductFile(OWNER, made.product.id, { pathname: `stores/x/${made.product.id}/item.bin`, name: "item.bin", bytes: 4, contentType: "application/octet-stream", addedAt: "" });
    return made.product.id;
  };
  // One report a day per product, so the store's daily cap of automatic holds is never what is tested here.
  let day = 0;
  const hold = async (id: string) => {
    day += 1;
    const outcome = await holdReported({ kind: "child_safety", url: `${ORIGIN}/@${HANDLE}/p/${id}` }, await current(), Date.now() + day * 86_400_000);
    if (outcome !== "held") throw new Error(`not held: ${outcome}`);
  };
  const listing = async (id: string) => (await readListing(await current(), id))!;
  const expect = (what: string, answer: (string | number)[]) => {
    if (answer[0] !== 200) throw new Error(`${what}: ${answer.join(" ")}`);
  };

  // What the held products have, set up before the report, as a creator would have made it.
  const keyed = await make("reported-item-keys");
  expect("keys set up", await send(keysRoute as Handler, "keys", { action: "setup", id: keyed, source: "pool", prefix: "", groups: 4, groupLength: 4, lowAt: 0 }));
  expect("keys added", await send(keysRoute as Handler, "keys", { action: "upload", id: keyed, text: "AAAA-BBBB-CCCC-DDDD\nEEEE-FFFF-GGGG-HHHH" }));

  const partA = await make("reported-item-part-a");
  const partB = await make("item-part-b");
  const partC = await make("item-part-c");
  const bundle = await make("reported-item-bundle", false);
  expect("bundle saved", await send(bundleRoute as Handler, "bundle", { action: "save", id: bundle, items: [partB, partC] }));
  const freeBundle = await make("item-bundle-not-held", false);

  const soon = await make("reported-item-soon");
  expect("marked coming soon", await send(waitlistRoute as Handler, "waitlist", { action: "soon", id: soon, on: true }));

  const lessons = await make("reported-item-course", false);
  expect("course on", await send(courseRoute as Handler, "course", { action: "enable", id: lessons }));
  expect("module", await send(courseRoute as Handler, "course", { action: "edit", id: lessons, op: "module-add", title: "Module A" }));
  const courseId = (await listing(lessons)).course!.id;
  const moduleId = (await readCourse(courseId))!.modules[0].id;
  expect("lesson", await send(courseRoute as Handler, "course", { action: "edit", id: lessons, op: "lesson-add", moduleId, title: "Lesson A" }));
  const course = (await readCourse(courseId))!;
  const lessonId = course.modules[0].lessons[0].id;
  const video = `stream/${await storeFolder(OWNER)}/${lessonId}/0a1b2c3d-0000-4000-8000-00000000000a`;
  course.modules[0].lessons[0] = { ...course.modules[0].lessons[0], video: { pathname: video, name: "lesson.mp4", bytes: 4, contentType: "video/mp4", addedAt: "" } };
  await saveCourse(course, ROOM, true);

  const reviewed = await make("reported-item-reviewed");
  const statsId = (await current()).statsId!;
  const saved = await saveReview(statsId, { productId: reviewed, email: "buyer.more@example.com", reference: "ref-more", pi: "pi_more", rating: 5, text: "Placeholder words.", name: "Buyer" }, ROOM);
  if (saved.state !== "created") throw new Error("no review");
  const reviewId = saved.review.id;
  const photo = { path: picture("4"), width: 10, height: 10 };
  if (typeof (await setReviewPhoto(statsId, reviewed, reviewId, photo)) === "string") throw new Error("no photo");

  for (const id of [keyed, partA, bundle, soon, lessons, reviewed]) await hold(id);
  const ON_HOLD = [409, "on_hold"];
  outside.length = 0;
  deleted.length = 0;

  part("Its license keys");
  is("the pool cleared", await send(keysRoute as Handler, "keys", { action: "clear", id: keyed }), ON_HOLD);
  is("keys switched off", await send(keysRoute as Handler, "keys", { action: "off", id: keyed }), ON_HOLD);
  is("the set-up changed", await send(keysRoute as Handler, "keys", { action: "setup", id: keyed, source: "generated", prefix: "", groups: 4, groupLength: 4, lowAt: 0 }), ON_HOLD);
  is("keys added", await send(keysRoute as Handler, "keys", { action: "upload", id: keyed, text: "IIII-JJJJ-KKKK-LLLL" }), ON_HOLD);
  is("a key revoked", await send(keysRoute as Handler, "keys", { action: "revoke", id: keyed, key: "AAAA-BBBB-CCCC-DDDD", revoked: true }), ON_HOLD);

  part("Its bundle, and a held product put in a bundle");
  is("a held bundle cleared", await send(bundleRoute as Handler, "bundle", { action: "clear", id: bundle }), ON_HOLD);
  is("a held bundle changed", await send(bundleRoute as Handler, "bundle", { action: "save", id: bundle, items: [partC, partB] }), ON_HOLD);
  is("a held product put in another bundle", await send(bundleRoute as Handler, "bundle", { action: "save", id: freeBundle, items: [partA, partC] }), ON_HOLD);
  is("a held product put in a new bundle", await send(bundleRoute as Handler, "bundle", { action: "create", title: "New Bundle", price: "29", summary: "", items: [partC, partA] }), ON_HOLD);

  part("Its waitlist: nothing goes on sale, no pre-order is handed over, nobody is emailed");
  is("the coming-soon mark taken off", await send(waitlistRoute as Handler, "waitlist", { action: "soon", id: soon, on: false }), ON_HOLD);
  is("the launch", await send(waitlistRoute as Handler, "waitlist", { action: "launch", id: soon, note: "", address: "" }), ON_HOLD);

  part("Its lessons' captions");
  is("captions removed", await send(captionsRoute as Handler, "stream/captions", { action: "remove", lessonId, lang: "en" }), ON_HOLD);
  is("captions added", await send(captionsRoute as Handler, "stream/captions", { action: "add", lessonId, lang: "en", text: "WEBVTT\n\n00:00.000 --> 00:01.000\nPlaceholder\n" }), ON_HOLD);
  is("captions written by AI, which would send its video out", await send(captionsRoute as Handler, "stream/captions", { action: "auto", lessonId, spoken: "en", also: [] }), ON_HOLD);
  is("the AI quote", await send(captionsRoute as Handler, "stream/captions", { action: "quote", lessonId }), ON_HOLD);

  part("Its buyers' reviews");
  is("a buyer's photo deleted", await send(reviewsRoute as Handler, "reviews", { action: "photo", product: reviewed, id: reviewId, reason: "unrelated" }), ON_HOLD);
  is("a review hidden", await send(reviewsRoute as Handler, "reviews", { action: "hide", product: reviewed, id: reviewId, hidden: true, reason: "unrelated" }), ON_HOLD);
  is("an answer written", await send(reviewsRoute as Handler, "reviews", { action: "reply", product: reviewed, id: reviewId, text: "Placeholder answer." }), ON_HOLD);

  part("And everything is still there, as it was; nothing deleted, nothing sent out");
  const now = await current();
  is("its keys, set up and in the pool", [(await listing(keyed)).keys?.source, (await keyCounts(now, await listing(keyed))).left], ["pool", 2]);
  is("the bundle's list", (await listing(bundle)).bundle, [partB, partC]);
  is("no bundle holds the held product", [(await listing(freeBundle)).bundle ?? null, now.catalog.items.length], [null, 9]);
  is("still coming soon", (await waitlistViews(now, [soon]))[soon]?.soon, true);
  const review = await readReview(statsId, reviewed, reviewId);
  is("the review, its photo, shown, no answer", [review?.photo?.path, review?.hidden ?? false, review?.reply ?? null], [photo.path, false, null]);
  is("still off the store", await Promise.all([keyed, partA, bundle, soon, lessons, reviewed].map(async (id) => (await listing(id)).hidden)), [true, true, true, true, true, true]);
  is("no file deleted, no call made", [deleted, outside], [[], []]);

  part("A hold that cannot be read refuses, never lets the change through");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => (String(commands[0]?.[1] ?? "").startsWith("nl:csa:keep:") ? [42] : real(commands))) as typeof redis.pipeline;
  const unread = [
    await send(keysRoute as Handler, "keys", { action: "clear", id: keyed }),
    await send(bundleRoute as Handler, "bundle", { action: "clear", id: bundle }),
    await send(bundleRoute as Handler, "bundle", { action: "save", id: freeBundle, items: [partB, partC] }),
    await send(waitlistRoute as Handler, "waitlist", { action: "soon", id: soon, on: false }),
    await send(captionsRoute as Handler, "stream/captions", { action: "remove", lessonId, lang: "en" }),
    await send(reviewsRoute as Handler, "reviews", { action: "photo", product: reviewed, id: reviewId, reason: "unrelated" }),
  ];
  redis.pipeline = real;
  is("503 from every route", unread.map((answer) => answer[0]), [503, 503, 503, 503, 503, 503]);
  is("and still nothing deleted or sent", [(await keyCounts(await current(), await listing(keyed))).left, deleted.length, outside.length], [2, 0, 0]);

  part("A product not held is not touched by it");
  is("a bundle of products not held is saved", await send(bundleRoute as Handler, "bundle", { action: "save", id: freeBundle, items: [partB, partC] }), [200, "ok"]);
  is("and cleared", await send(bundleRoute as Handler, "bundle", { action: "clear", id: freeBundle }), [200, "ok"]);
  const open = await make("item-keys-not-held");
  is("keys set up on a product not held", await send(keysRoute as Handler, "keys", { action: "setup", id: open, source: "generated", prefix: "", groups: 4, groupLength: 4, lowAt: 0 }), [200, "ok"]);
  is("and switched off", await send(keysRoute as Handler, "keys", { action: "off", id: open }), [200, "ok"]);
  is("the review queue is still marked seen", await send(reviewsRoute as Handler, "reviews", { action: "seen", all: true }), [200, "ok"]);

  done();
}

main();
