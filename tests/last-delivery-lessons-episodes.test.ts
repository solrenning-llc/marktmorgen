/**
 * A published course keeps its last lesson, and a published private podcast its last episode (#5285 row #3432).
 *
 * A product on the store is never left handing over nothing: the checkout's rule (lib/product-option.ts handsOver)
 * sells a course once it has a lesson and a private podcast once it has an episode, so taking the last one away would
 * leave the product on the store while every sale is refused, with no word to the creator. The file and link routes
 * already refused that (`last_delivery`, tests/publish-hands-over.test.ts); the course route's "lesson-remove" and
 * "module-remove" and the podcast route's "remove" now refuse it too, before anything is saved or deleted, and name the
 * product (WCAG 3.3.1). A draft, or a published one that keeps another lesson or episode, is never held up. The studio
 * editors say what to do in their own words.
 *
 * Synthetic only: the in-memory Redis double and a local stand-in for Vercel Blob (HEAD and delete).
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { POST as podcastRoute } from "@/app/api/store/podcast/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { lessonsInOrder, readCourse } from "@/lib/course";
import { readListing } from "@/lib/catalog";
import { editPodcast, readPodcast, savePodcast } from "@/lib/podcast";
import type { Podcast } from "@/lib/podcast-rules";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  ensureStoreId,
  setPodcastEpisodes,
  setProductHidden,
  setStripeAccount,
  setSubscription,
  storeFolder,
  storeForEmail,
} from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_lastdelivery_notarealsecret";

// Vercel Blob, answered by a local stand-in: HEAD (GET ?url=<pathname>) for any file, and every delete written down.
const deleted: string[] = [];
const blobStandIn = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname.endsWith("/delete")) {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () => {
      const urls = (JSON.parse(raw || "{}") as { urls?: string[] }).urls ?? [];
      deleted.push(...urls);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    return;
  }
  const asked = url.searchParams.get("url") ?? "";
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ url: `https://x.public.blob.vercel-storage.com/${asked}`, downloadUrl: `https://x.public.blob.vercel-storage.com/${asked}?download=1`, pathname: asked, size: 1234, contentType: "audio/mpeg", contentDisposition: "inline", cacheControl: "public", uploadedAt: new Date().toISOString(), etag: "\"e\"" }));
});

const OWNER = "last-delivery-lessons@example.com";
const ORIGIN = "https://marktmorgen.com";

type Reply = { status: number; body: { ok?: boolean; error?: string; product?: string } };

async function main(): Promise<void> {
  await new Promise<void>((resolve) => blobStandIn.listen(0, "127.0.0.1", resolve));
  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${(blobStandIn.address() as AddressInfo).port}`;
  redis.clear();
  await claimHandle(OWNER, "lastdelivery", "Last Delivery", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1LastDelivxxxxx", true);
  await setSubscription(OWNER, { customerId: "cus_last_delivery", subscriptionId: "sub_last_delivery", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const session = await openSession(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const folder = await storeFolder(OWNER);
  const headers = { "content-type": "application/json", "x-nimbus-store": store.sid!, cookie: `${SESSION_COOKIE}=${session}` };
  const call = async (route: typeof courseRoute, path: string, body: Record<string, unknown>): Promise<Reply> => {
    const response = await route(new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply["body"] };
  };
  const courseCall = (body: Record<string, unknown>) => call(courseRoute, "/api/store/course", body);
  const podcastCall = (body: Record<string, unknown>) => call(podcastRoute, "/api/store/podcast", body);
  const listing = async (id: string) => readListing((await storeForEmail(OWNER))!, id);

  const makeCourse = async (title: string, lessonTitles: string[], hidden: boolean) => {
    const made = await addProduct(OWNER, title, "", "40");
    if (!made.ok) throw new Error("product not made");
    const id = made.product.id;
    const enabled = await courseCall({ action: "enable", id });
    if (!enabled.body.ok) throw new Error(`course not enabled: ${enabled.body.error}`);
    const courseId = (await listing(id))?.course?.id;
    if (!courseId) throw new Error("course not listed");
    for (const lessonTitle of lessonTitles) {
      const before = await readCourse(courseId);
      const added = await courseCall({ action: "edit", id, op: "lesson-add", moduleId: before!.modules[0].id, title: lessonTitle });
      if (!added.body.ok) throw new Error(`lesson not added: ${added.body.error}`);
    }
    if (hidden) await setProductHidden(OWNER, id, true);
    const lessons = lessonsInOrder((await readCourse(courseId))!).map(({ lesson }) => lesson.id);
    return { id, courseId, lessons };
  };
  const lessonState = async (id: string, courseId: string) => [lessonsInOrder((await readCourse(courseId))!).length, (await listing(id))?.course?.lessons];

  part("A published course: removing its only lesson is refused, named, and nothing changes");
  {
    const { id, courseId, lessons } = await makeCourse("The Sourdough Course", ["Starter"], false);
    is("published, one lesson", [(await listing(id))?.hidden, ...(await lessonState(id, courseId))], [false, 1, 1]);
    const removed = await courseCall({ action: "edit", id, op: "lesson-remove", lessonId: lessons[0] });
    is("refused, said why, named", [removed.status, removed.body.error, removed.body.product], [409, "last_delivery", "The Sourdough Course"]);
    is("the lesson is still in the course, and the listing still counts it", await lessonState(id, courseId), [1, 1]);
    is("the lesson kept is the same one", lessonsInOrder((await readCourse(courseId))!)[0]?.lesson.id, lessons[0]);
  }

  part("A draft course: its only lesson can be removed");
  {
    const { id, courseId, lessons } = await makeCourse("The Draft Course", ["Only lesson"], true);
    const removed = await courseCall({ action: "edit", id, op: "lesson-remove", lessonId: lessons[0] });
    is("allowed", [removed.status, removed.body.ok], [200, true]);
    is("no lesson left, the listing counts none", await lessonState(id, courseId), [0, 0]);
  }

  part("A published course with two lessons: one can be removed");
  {
    const { id, courseId, lessons } = await makeCourse("The Two Lesson Course", ["First", "Second"], false);
    const removed = await courseCall({ action: "edit", id, op: "lesson-remove", lessonId: lessons[0] });
    is("allowed", [removed.status, removed.body.ok], [200, true]);
    is("one lesson left, the listing counts one", await lessonState(id, courseId), [1, 1]);
    const last = await courseCall({ action: "edit", id, op: "lesson-remove", lessonId: lessons[1] });
    is("and then the last one is refused", [last.status, last.body.error, last.body.product], [409, "last_delivery", "The Two Lesson Course"]);
    is("it stays", await lessonState(id, courseId), [1, 1]);
  }

  const episode = (podcast: Podcast, productId: string, n: string): Podcast => {
    const made = editPodcast(podcast, { op: "add", pathname: `stores/${folder}/${productId}/${n}.mp3`, bytes: 10, contentType: "audio/mpeg", title: `Episode ${n}`, notes: "", at: 1 });
    if (!made.ok) throw new Error("no episode");
    return made.podcast;
  };
  const makePodcast = async (title: string, episodes: string[], hidden: boolean) => {
    const made = await addProduct(OWNER, title, "", "9", null);
    if (!made.ok) throw new Error("no product");
    const id = made.product.id;
    const enabled = await podcastCall({ action: "enable", id });
    const podcastId = (enabled.body as { podcastId?: string }).podcastId;
    if (!podcastId) throw new Error(`podcast not enabled: ${enabled.body.error}`);
    let podcast: Podcast = { id: podcastId, episodes: [] };
    for (const n of episodes) podcast = episode(podcast, id, n);
    await savePodcast(podcast);
    await setPodcastEpisodes(OWNER, id, podcast.episodes.length);
    if (hidden) await setProductHidden(OWNER, id, true);
    return { id, podcastId, episodes: podcast.episodes };
  };
  const episodeState = async (id: string, podcastId: string) => [(await readPodcast(podcastId))?.episodes.length, (await listing(id))?.podcast?.episodes];

  part("A published podcast: removing its only episode is refused, named, its audio kept");
  {
    const { id, podcastId, episodes } = await makePodcast("The Baking Show", ["one"], false);
    is("published, one episode", [(await listing(id))?.hidden, ...(await episodeState(id, podcastId))], [false, 1, 1]);
    deleted.length = 0;
    const removed = await podcastCall({ action: "remove", id, episode: episodes[0].id });
    is("refused, said why, named", [removed.status, removed.body.error, removed.body.product], [409, "last_delivery", "The Baking Show"]);
    is("the episode is still in the feed, and the listing still counts it", await episodeState(id, podcastId), [1, 1]);
    is("its audio was not deleted", deleted, []);
  }

  part("A draft podcast: its only episode can be removed");
  {
    const { id, podcastId, episodes } = await makePodcast("The Draft Show", ["one"], true);
    deleted.length = 0;
    const removed = await podcastCall({ action: "remove", id, episode: episodes[0].id });
    is("allowed", [removed.status, removed.body.ok], [200, true]);
    is("no episode left, the listing counts none", await episodeState(id, podcastId), [0, 0]);
    is("its audio was deleted", deleted.length, 1);
  }

  part("A published podcast with two episodes: one can be removed");
  {
    const { id, podcastId, episodes } = await makePodcast("The Two Episode Show", ["one", "two"], false);
    deleted.length = 0;
    const removed = await podcastCall({ action: "remove", id, episode: episodes[0].id });
    is("allowed", [removed.status, removed.body.ok], [200, true]);
    is("one episode left, the listing counts one", await episodeState(id, podcastId), [1, 1]);
    is("the removed episode's audio was deleted", deleted.length, 1);
    deleted.length = 0;
    const last = await podcastCall({ action: "remove", id, episode: episodes[1].id });
    is("and then the last one is refused", [last.status, last.body.error, last.body.product], [409, "last_delivery", "The Two Episode Show"]);
    is("it stays, its audio kept", [...(await episodeState(id, podcastId)), deleted.length], [1, 1, 0]);
  }

  part("The studio says what to do, in each editor's own words");
  for (const [editor, word] of [["components/course-editor.tsx", "lesson"], ["components/podcast-editor.tsx", "episode"]] as const) {
    const source = readFileSync(editor, "utf8");
    const messages = source.slice(source.indexOf("const MESSAGES"), source.indexOf("};", source.indexOf("const MESSAGES")));
    const sentence = /\blast_delivery:\s*"([^"]+)"/.exec(messages)?.[1] ?? "";
    is(`${editor}: MESSAGES has a last_delivery sentence`, sentence.length > 0, true);
    is(`${editor}: it names the last ${word} and what to do`, [sentence.includes(`last ${word}`), /unpublish/i.test(sentence)], [true, true]);
  }

  blobStandIn.close();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
