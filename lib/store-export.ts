/**
 * Everything a store keeps, as one file its owner can take anywhere (added
 * 18 October 2026), offered in the studio and in every notice before a
 * store closes (lib/plan-closing.ts): its products and their prices, pages,
 * long descriptions and notes after paying; its blog posts; its courses with
 * every lesson's text; its forms with their answers; its contacts; and a
 * summary of its orders, read from its own Stripe account and its PayPal
 * records. Files, videos and community posts are not in it: files and videos
 * are downloaded from the studio one by one, and a community's posts are its
 * members' as much as the creator's.
 *
 * Written out as it is read, a part at a time, so a large store is never
 * held whole in memory. What it reads is the store's data room and its
 * sales on its Stripe account, so what it costs is counted the way the room
 * is, with the wait for Stripe's pages: while a plan runs it is taken from
 * the store's studio figure at exportUnits of its size
 * (tests/closing-cost.test.ts holds the units to the cost), and once a plan
 * has ended a store may take ENDED_STORE_EXPORTS of them before it closes
 * (lib/plan-closing-rules.ts), its own and never refused for want of room
 * anywhere else, priced with its closing against its own payments
 * (tests/plan-cost-registry.ts, closure).
 */
import { readAllListings } from "@/lib/catalog";
import { BODIES_PER_READ, readAllBodies, readCourses } from "@/lib/course";
import { listAsCsv, listSize } from "@/lib/free";
import { dataUsed } from "@/lib/store-data";
import { readForms, readResponses } from "@/lib/form-store";
import { readAbouts } from "@/lib/product-about";
import { readPages } from "@/lib/sales-page-store";
import { EXPORT_PAGES, salesCsv, readsSales } from "@/lib/stats";
import { allPosts, readPosts } from "@/lib/store-blog";
import { type Store } from "@/lib/store";
import { standingOf } from "@/lib/plan-standing";
import { ENDED_STORE_EXPORTS } from "@/lib/plan-closing-rules";
import { readThanksNotes } from "@/lib/thanks-note-store";
import { listValuesShape } from "@/lib/free";

/**
 * What an export reads: every byte the store's data room counts at the
 * most, and a few commands for each thing it reads one at a time (a
 * product's page, long description and note, a lesson's text, a post, a
 * form's answers), the contacts a thousand at a command, and its fixed part.
 */
export type ExportShape = { bytes: number; commands: number };
/**
 * Commands each thing an export reads takes at the most, read together: a
 * product (its page, long description and note, a hundred at a command), a
 * course (a hundred at a command), a lesson (its text, BODIES_PER_READ at a
 * command whatever course it is of), a post (its words, a hundred at a
 * command), a form (its answers); and the fixed part, the catalog's pages,
 * the posts' list, the contacts' first page and the store's PayPal sales.
 */
export const EXPORT_COMMANDS = { product: 0.03, course: 0.01, lesson: 0.002, post: 0.01, form: 2, fixed: 80 };
/**
 * One studio unit is twenty commands and fifty kilobytes through the
 * database at a studio request's time (tests/plan-cost-registry.ts,
 * UNIT_COST); an export is counted at fewer commands, and at a megabyte of
 * what it reads, which costs about half a unit: the bytes moved and the time
 * to write them out (tests/closing-cost.test.ts holds it).
 */
export const EXPORT_COMMANDS_PER_UNIT = 16;
export const EXPORT_BYTES_PER_UNIT = 1_000_000;
/** The pages of the store's sales read from its Stripe account at the most: its checkouts' and its one-click extras' (lib/stats.ts, salesCsv), the two read side by side. */
export const EXPORT_STRIPE_PAGES = 2 * EXPORT_PAGES;
/** How long one of those pages is waited for at the most, held at 2 GB: a review ceiling. The two lists are read at once, so the wait is for one list's pages. */
export const EXPORT_PAGE_SECONDS = 2;
/** The studio units that wait takes, whatever the store's size (tests/closing-cost.test.ts holds them to it). */
export const EXPORT_WAIT_UNITS = 20;

/** The studio units a whole export of this shape takes (tests/closing-cost.test.ts holds them to its cost). */
export function exportUnits(shape: ExportShape): number {
  return 1 + EXPORT_WAIT_UNITS + Math.ceil(Math.max(0, shape.commands) / EXPORT_COMMANDS_PER_UNIT) + Math.ceil(Math.max(0, shape.bytes) / EXPORT_BYTES_PER_UNIT);
}

/**
 * What exporting this store reads, counted before it is read: the room's
 * bytes, and its products, lessons, posts, forms and contacts; and what the
 * contacts' file reads beside its list, page by page, for the people on it
 * (lib/free.ts, listValuesShape), read exactly so an export is never priced
 * without it (second cost review of #3354).
 */
export async function exportShape(store: Store): Promise<ExportShape> {
  const shape = await roomShape(store);
  const values = await listValuesShape(store);
  return { bytes: shape.bytes + values.bytes, commands: shape.commands + values.commands };
}

/** The room's bytes, and its products, lessons, posts, forms and contacts. */
async function roomShape(store: Store): Promise<ExportShape> {
  const used = await dataUsed(store);
  // The full export is paid for from this measurement. Unknown room usage
  // cannot be priced as an empty room before the remaining reads begin.
  if (!used) throw new Error("The data-room size could not be read");
  const listings = await readAllListings(store);
  const ids = listings.flatMap((l) => (l.course ? [l.course.id] : []));
  const courses = ids.length ? await readCourses(ids) : new Map();
  let lessons = 0;
  for (const course of courses.values()) for (const unit of course.modules) lessons += unit.lessons.length;
  const posts = (await allPosts(store.statsId)).length;
  const forms = (await readForms(store.statsId)).length;
  const contacts = (await listSize(store)).total;
  return {
    bytes: used.used,
    commands: Math.ceil(EXPORT_COMMANDS.fixed + 3 * Math.ceil(listings.length / 100) + Math.ceil(courses.size / 100) + Math.ceil(lessons / BODIES_PER_READ) + Math.ceil(posts / 100) + EXPORT_COMMANDS.form * forms + contacts / 1000),
  };
}

const encoder = new TextEncoder();

/** Said for a part that could not be read, after what it is. */
const UNREAD_LATER = "could not be read just now. Download the file again in a few minutes.";

/** A failed read of one part of every product: logged, and null so the part is left out and said once. */
function unread(part: string): (error: unknown) => null {
  return (error) => {
    console.error(`a store export could not read the products' ${part}`, error);
    return null;
  };
}

/**
 * The whole export, as a stream of JSON. Each part is read just before it
 * is written; a part that cannot be read is written as what could not be
 * read, never left out without a word.
 */
export function storeExport(store: Store, now = Date.now()): ReadableStream<Uint8Array> {
  const statsId = store.statsId;
  const parts: (() => Promise<string>)[] = [
    async () => `{"exportedAt":${JSON.stringify(new Date(now).toISOString())},"store":${JSON.stringify({ handle: store.handle, name: store.name, bio: store.bio, links: store.links, createdAt: store.createdAt, currency: store.currency })}`,
    async () => {
      const listings = await readAllListings(store);
      const ids = listings.map((listing) => listing.id);
      // A part that cannot be read is left out of every product and said once, by name: never written as "no page",
      // "no description" or "no note", which is what an empty value would tell the creator (C4-2630, Codex T's 64b3a0a9).
      const pages = await readPages(statsId, ids).catch(unread("pages"));
      const abouts = await readAbouts(statsId, ids).catch(unread("abouts"));
      const notes = await readThanksNotes(statsId, ids).catch(unread("thanks"));
      const out = listings.map((listing, i) => ({
        product: listing,
        ...(pages ? { page: statsId ? pages[i] : null } : {}),
        ...(abouts ? { about: abouts[i] ?? "" } : {}),
        ...(notes ? { thanks: notes[i] ?? null } : {}),
      }));
      const notesOut = [pages ? "" : `,"pagesNote":"The products' sales pages ${UNREAD_LATER}"`, abouts ? "" : `,"aboutsNote":"The products' long descriptions ${UNREAD_LATER}"`, notes ? "" : `,"thanksNote":"The products' thank-you notes ${UNREAD_LATER}"`].join("");
      const courseIds = listings.flatMap((l) => (l.course ? [l.course.id] : []));
      const courses = courseIds.length ? await readCourses(courseIds) : new Map();
      const list = [...courses.values()];
      const bodies = await readAllBodies(list.map((course) => ({ id: course.id, lessons: course.modules.flatMap((unit: { lessons: { id: string }[] }) => unit.lessons.map((lesson) => lesson.id)) })));
      const withText: unknown[] = list.map((course) => ({ ...course, lessonText: bodies.get(course.id) ?? {} }));
      return `,"products":${JSON.stringify(out)}${notesOut},"courses":${JSON.stringify(withText)}`;
    },
    async () => {
      const posts = await readPosts(statsId, await allPosts(statsId));
      return `,"posts":${JSON.stringify(posts)}`;
    },
    async () => {
      const forms: unknown[] = [];
      for (const form of await readForms(statsId)) forms.push({ form, answers: (await readResponses(statsId, form.id)).responses });
      return `,"forms":${JSON.stringify(forms)}`;
    },
    async () => `,"contactsCsv":${JSON.stringify(await listAsCsv(store, false))}`,
    async () => {
      if (!readsSales(store)) return `,"ordersCsv":"","ordersNote":"No Stripe or PayPal account was connected, so there are no orders to list."`;
      const { csv, partial } = await salesCsv(store, 0);
      return `,"ordersCsv":${JSON.stringify(csv)}${partial ? `,"ordersNote":"More orders than one file reads: the rest are on your own Stripe account."` : ""}`;
    },
    async () => `,"notIncluded":"Nothing else is in this file. For example, files, videos, community posts, email sequences and broadcasts, reviews, coupons, affiliates, the times of booked calls (their payments are in your orders), funnels and CRM deals and tasks stay in your studio. Download files and videos from their own pages in your studio."}\n`,
  ];
  // A store whose plan runs downloads again from its studio's figure, so "download again" is true for it. A store
  // whose plan has ended has ENDED_STORE_EXPORTS of this file, taken before it streams (app/api/store/export/route.ts):
  // the words never promise it a download the route then refuses (VR item 2). Its turn is not given back here, since a
  // part that always fails would make its exports unbounded past the closing cost priced in tests/plan-cost-registry.ts.
  const unreadWords =
    standingOf(store) === "ended"
      ? `This part could not be read just now, so it is not in this file. A store whose plan has ended downloads this file ${ENDED_STORE_EXPORTS === 1 ? "once" : `${ENDED_STORE_EXPORTS} times`}, and starting a plan again lets you download it again.`
      : "This part could not be read just now. Download the file again in a few minutes.";
  let at = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (at >= parts.length) {
        controller.close();
        return;
      }
      const part = parts[at];
      at += 1;
      let text: string;
      try {
        text = await part();
      } catch (error) {
        console.error("a part of a store's export could not be read", error);
        text = at === 1 ? `{"exportedAt":${JSON.stringify(new Date(now).toISOString())}` : `,"unreadPart${at}":${JSON.stringify(unreadWords)}`;
      }
      controller.enqueue(encoder.encode(text));
    },
  });
}
