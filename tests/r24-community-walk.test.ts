/**
 * CX-123 rule 24 on the one walk of a community's archive into its search index (lib/community-walk.ts) and on the
 * check of a community post's picture (lib/community-image.ts).
 *
 * The walk is marked done once, ever, and is never done again: a course or the calendar it could not read, taken for
 * "nothing there", left those lessons or events out of the search for good while the community was marked as walked.
 * Its marker read in a shape that is neither the version nor nil walked again, paid from the store's requests.
 *
 * A picture whose first bytes could not be read was taken for "not a picture" and deleted, with the member told the
 * picture was refused; a head that could not be read already kept it for the member to send again.
 */
import { claimHandle, ensureStatsId, setCommunity, setProductCourse, setSubscription, addProduct, storeForEmail, type Store } from "@/lib/store";
import { saveCourse, type Course } from "@/lib/course";
import { createEvent } from "@/lib/community-events";
import { needsWalk, walkCommunity } from "@/lib/community-walk";
import { indexedWords, unindexWrites } from "@/lib/community-search";
import { lessonRef } from "@/lib/community-index";
import { type ImageStore, checkCommunityImage, communityFolder } from "@/lib/community-image";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { THROWS, answer, clearAnswers, getOf } from "./l10b-replies";

const OWNER = "r24-walk@example.com";
const COURSE_ID = "c".repeat(32);
const LESSON_ID = "lesson000001";

async function setup(): Promise<{ store: Store; id: string; productId: string; eventId: string }> {
  redis.clear();
  clearAnswers();
  await claimHandle(OWNER, "rwalk", "Bread Club", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_rwalk0001", subscriptionId: "sub_rwalk0001", active: true, tier: "pro", period: paidPeriod() });
  await setCommunity(OWNER, true);
  const made = await addProduct(OWNER, "Sourdough course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  const course = {
    id: COURSE_ID,
    certificate: false,
    startsAt: null,
    modules: [{ id: "module000001", title: "Starters", dripDays: 0, lessons: [{ id: LESSON_ID, title: "Feeding a levain", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null }] }],
  } as unknown as Course;
  await saveCourse(course, ROOM, true);
  const attached = await setProductCourse(OWNER, made.product.id, { id: COURSE_ID, lessons: 1 });
  if (!attached.ok) throw new Error(`no course: ${attached.reason}`);
  const store = (await storeForEmail(OWNER)) as Store;
  const id = store.community!.id;
  const event = await createEvent(store, { title: "Rye night", about: "A long ferment and a hot oven.", start: Date.now() + 86_400_000, minutes: 60, tz: "UTC", cap: 0, where: "room", link: "", meet: null, only: [] });
  if (!event.ok) throw new Error("no event");
  // Written before the index reached events, as the archive the walk is for: taken out of the index again.
  const had = await indexedWords(id, "event", [event.event.id]);
  if (!had || had[0] === "over") throw new Error("event words unread");
  await redis.pipeline(unindexWrites(id, "event", event.event.id, had[0]));
  if (await indexed(id, "event", event.event.id)) throw new Error("event still indexed");
  clearAnswers();
  return { store, id, productId: made.product.id, eventId: event.event.id };
}

/** Whether a thing is in the index now: words held for it. */
async function indexed(id: string, kind: "lesson" | "event", thing: string): Promise<boolean> {
  const words = await indexedWords(id, kind, [thing]);
  return Array.isArray(words?.[0]) && words[0].length > 0;
}

async function main(): Promise<void> {
  let paid = 0;
  const pay = async () => {
    paid += 1;
    return true;
  };

  part("The plain case: its lesson and its event indexed, marked once");
  {
    const { store, id, productId, eventId } = await setup();
    paid = 0;
    const walked = await walkCommunity(store, pay);
    is("walked, paid, marked, the lesson and the event findable", [walked, paid > 0, await needsWalk(id), await indexed(id, "lesson", lessonRef(productId, LESSON_ID)), await indexed(id, "event", eventId)], [true, true, false, true, true]);
    paid = 0;
    is("a second search walks nothing and pays nothing", [await walkCommunity(store, pay), paid], [false, 0]);
  }

  part("A course that could not be read stops the walk unmarked");
  {
    const { store, id, productId } = await setup();
    answer(getOf(`nl:course:${COURSE_ID}`), THROWS, { run: false });
    const walked = await walkCommunity(store, pay).catch(() => "threw");
    is("not taken as walked, still to be walked, its lesson not claimed as indexed", [walked === true, await needsWalk(id), await indexed(id, "lesson", lessonRef(productId, LESSON_ID))], [false, true, false]);
    clearAnswers();
    is("the next search walks it whole", [await walkCommunity(store, pay), await needsWalk(id), await indexed(id, "lesson", lessonRef(productId, LESSON_ID))], [true, false, true]);
  }

  part("A calendar that could not be read stops the walk unmarked");
  for (const [shape, match] of [
    ["its list of events failing", (c: (string | number)[]) => c[0] === "ZRANGEBYSCORE" && String(c[1]).endsWith(":evs")],
    ["its events failing", (c: (string | number)[]) => c[0] === "GET" && String(c[1]).includes(":ev:")],
  ] as const) {
    const { store, id, eventId } = await setup();
    answer(match, THROWS, { run: false });
    const walked = await walkCommunity(store, pay).catch(() => "threw");
    is(`${shape}: not taken as walked, still to be walked, the event not claimed as indexed`, [walked === true, await needsWalk(id), await indexed(id, "event", eventId)], [false, true, false]);
    clearAnswers();
    is(`${shape}: the next search walks it whole`, [await walkCommunity(store, pay), await needsWalk(id), await indexed(id, "event", eventId)], [true, false, true]);
  }

  // Claude 4 on #3263 (review 6728128004): a reply that is not a throw, in a shape that is neither the course nor nil,
  // was still taken for a course that is gone, and the community was marked without its lessons.
  part("A course read in an unknown shape stops the walk unmarked");
  for (const [shape, reply] of [
    ["no reply at all", () => []],
    ["a number", () => [42]],
    ["an object", () => [{}]],
    ["text that is not a course", () => ["{oops"]],
  ] as const) {
    const { store, id, productId } = await setup();
    answer(getOf(`nl:course:${COURSE_ID}`), reply as (real: unknown[]) => unknown, { run: false });
    const walked = await walkCommunity(store, pay).catch(() => "threw");
    is(`the course answered with ${shape}: not taken as walked, still to be walked, its lesson not claimed as indexed`, [walked === true, await needsWalk(id), await indexed(id, "lesson", lessonRef(productId, LESSON_ID))], [false, true, false]);
  }
  {
    const { store, id, productId } = await setup();
    answer(getOf(`nl:course:${COURSE_ID}:body:`), () => [7], { run: false });
    const walked = await walkCommunity(store, pay).catch(() => "threw");
    is("a lesson's text answered with a number: not taken as walked, still to be walked, its lesson not claimed as indexed", [walked === true, await needsWalk(id), await indexed(id, "lesson", lessonRef(productId, LESSON_ID))], [false, true, false]);
    clearAnswers();
    is("the next search walks it whole", [await walkCommunity(store, pay), await needsWalk(id), await indexed(id, "lesson", lessonRef(productId, LESSON_ID))], [true, false, true]);
  }
  {
    const { store, id, productId, eventId } = await setup();
    answer(getOf(`nl:course:${COURSE_ID}`), () => [null], { run: false });
    is("a course confirmed gone (nil) is passed over: walked and marked, its lesson not indexed, the event indexed", [await walkCommunity(store, pay), await needsWalk(id), await indexed(id, "lesson", lessonRef(productId, LESSON_ID)), await indexed(id, "event", eventId)], [true, false, false, true]);
  }

  // The same review: an unknown count, list or event row was read as an empty calendar, and the community was marked.
  part("A calendar read in an unknown shape stops the walk unmarked");
  const zcard = (c: (string | number)[]) => c[0] === "ZCARD" && String(c[1]).endsWith(":evs");
  const zrange = (c: (string | number)[]) => c[0] === "ZRANGEBYSCORE" && String(c[1]).endsWith(":evs");
  const eventGet = (c: (string | number)[]) => c[0] === "GET" && String(c[1]).includes(":ev:");
  for (const [shape, match, reply] of [
    ["its count with no reply at all", zcard, () => []],
    ["its count as text", zcard, () => ["abc"]],
    ["its list with no reply at all", zrange, () => []],
    ["its list as a number", zrange, () => [7]],
    ["its event as a number", eventGet, () => [7]],
    ["its event as text that is not an event", eventGet, () => ["{oops"]],
  ] as const) {
    const { store, id, eventId } = await setup();
    answer(match, reply as (real: unknown[]) => unknown, { run: false });
    const walked = await walkCommunity(store, pay).catch(() => "threw");
    is(`${shape}: not taken as walked, still to be walked, the event not claimed as indexed`, [walked === true, await needsWalk(id), await indexed(id, "event", eventId)], [false, true, false]);
  }
  for (const [shape, match, reply] of [
    ["a count confirmed 0", zcard, () => [0]],
    ["a list confirmed empty", zrange, () => [[]]],
    ["its one event confirmed gone (nil)", eventGet, () => [null]],
  ] as const) {
    const { store, id, productId, eventId } = await setup();
    answer(match, reply as (real: unknown[]) => unknown, { run: false });
    is(`${shape}: an empty calendar, walked and marked, the lesson indexed, the event not`, [await walkCommunity(store, pay), await needsWalk(id), await indexed(id, "lesson", lessonRef(productId, LESSON_ID)), await indexed(id, "event", eventId)], [true, false, true, false]);
  }

  part("The marker read exactly: only nil or another version walks");
  {
    const { store, id } = await setup();
    await walkCommunity(store, pay);
    const mark = `nl:cm:${id}:sv`;
    for (const [shape, reply] of [
      ["no reply at all", () => []],
      ["a reply too many", () => ["3", "3"]],
      ["no value", () => [undefined]],
      ["a number", () => [3]],
      ["not a list", () => "3"],
    ] as const) {
      clearAnswers();
      paid = 0;
      answer(getOf(mark), reply as (real: unknown[]) => unknown, { run: false });
      const said = await needsWalk(id).then(
        (v) => v,
        (e: Error) => e.name,
      );
      answer(getOf(mark), reply as (real: unknown[]) => unknown, { run: false });
      const walked = await walkCommunity(store, pay).catch(() => "threw");
      is(`the marker answered with ${shape}: unknown, not walked, nothing paid`, [said, walked === true, paid], ["UnknownReplyError", false, 0]);
    }
    clearAnswers();
    is("the marker at this version: no walk", await needsWalk(id), false);
    redis.run(["SET", mark, "2"]);
    is("the marker at an older version: walk", await needsWalk(id), true);
    redis.run(["DEL", mark]);
    is("no marker at all: walk", await needsWalk(id), true);
  }

  part("A picture whose first bytes could not be read is kept, not refused");
  {
    const communityId = "a1b2c3d4e5f6a7b8c9d0e1f2";
    const path = `community/${communityFolder(communityId)}/${"d".repeat(32)}.jpg`;
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
    const deleted: string[] = [];
    const files = (first: () => Promise<Uint8Array | null>): ImageStore => ({
      head: async () => ({ size: 50_000, contentType: "image/jpeg" }),
      firstBytes: first,
      del: async (p) => {
        deleted.push(p);
      },
    });
    deleted.length = 0;
    is("a real JPEG: ok, nothing deleted", [await checkCommunityImage(path, communityId, files(async () => JPEG)), deleted.length], ["ok", 0]);
    deleted.length = 0;
    is("bytes that are not a picture: refused and deleted", [await checkCommunityImage(path, communityId, files(async () => new Uint8Array([0x3c, 0x73, 0x76, 0x67]))), deleted], ["type", [path]]);
    deleted.length = 0;
    const unread = await checkCommunityImage(
      path,
      communityId,
      files(async () => {
        throw new Error("the file store did not answer");
      }),
    ).then(
      (v) => v,
      () => "threw",
    );
    is("the first bytes unread: not called a wrong type, nothing deleted", [unread === "type", deleted.length], [false, 0]);
  }

  clearAnswers();
  done();
}

void main();
