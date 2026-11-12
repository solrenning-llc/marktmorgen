/**
 * The readers a product held for a child-safety report must refuse, past those
 * tests/child-safety-access.test.ts holds (Revisor 2 on #3588; lib/child-safety.ts,
 * C1-20261109-1546-TODOS-70, unit 3a).
 *
 * The MCP server hands an AI client what it reads, so its product tools give
 * nothing of a held product, for anyone (as the studio's AI writing help).
 * The studio's course and podcast pages are the owner's only, as the course
 * route already is. When taking the product off the store did not go through
 * after its mark was written, its own page shows it to nobody at once, and the
 * hourly job keeps taking it off until it is confirmed off (a reply that
 * cannot be read is "not off"), so the store's lists drop it too, at no cost
 * per visit (coordinator, 11/11/2026). A mark that cannot be read refuses the
 * same way. Neutral, synthetic products; nothing here names or describes
 * reported material.
 */
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import StudioCoursePage from "@/app/studio/course/[product]/page";
import StudioPodcastPage from "@/app/studio/podcast/[product]/page";
import ProductPage from "@/app/[handle]/p/[product]/page";
import { productTextTool, readCourseTool, readLessonTool, readPageReadingTool, readPageTestTool, readPageVersionsTool, readSalesPageTool } from "@/lib/mcp-tools";
import { readListing, readPage, searchStore } from "@/lib/catalog";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { saveCourse, type Course } from "@/lib/course";
import { putMember } from "@/lib/team";
import * as childSafety from "@/lib/child-safety";
import { holdReported } from "@/lib/child-safety";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCourse, setProductHidden, setProductPodcast, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const OWNER = "readers-owner@example.com";
const EDITOR = "readers-editor@example.com";
const BASE = "https://marktmorgen.com";
const HANDLE = "readershop";

/** What a page did: drawn, sent elsewhere (and where), or not found. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    const node = await run();
    const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
    await stream.allReady;
    const page = await new Response(stream).text();
    return page.includes("Held Product") ? "shown" : "drawn without it";
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return `redirect ${digest.split(";")[2]}`;
    if (digest.includes("404")) return "not found";
    return "not refused";
  }
}

/** What an MCP tool answered: the refusal's status, or "read" when it handed something over. */
async function tool(run: () => Promise<unknown>): Promise<string | number> {
  const answer = await run().catch(() => "threw");
  if (answer instanceof Response) return answer.status;
  return answer === "threw" ? "threw" : "read";
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Readers Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_readers01", subscriptionId: "sub_readers01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });

  const courseMade = await addProduct(OWNER, "Held Product course", "", "149", null);
  const showMade = await addProduct(OWNER, "Held Product podcast", "", "29", null);
  const pageMade = await addProduct(OWNER, "Held Product guide", "", "19", null);
  const freeMade = await addProduct(OWNER, "Free course", "", "19", null);
  if (!courseMade.ok || !showMade.ok || !pageMade.ok || !freeMade.ok) throw new Error("no products");
  const courseId = courseMade.product.id;
  const showId = showMade.product.id;
  const pageId = pageMade.product.id;
  const freeId = freeMade.product.id;
  const lessons = (id: string) =>
    ({
      id,
      certificate: false,
      startsAt: null,
      modules: [{ id: "module000001", title: "First part", dripDays: 0, lessons: [{ id: "lesson000001", title: "A lesson", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null }] }],
    }) as unknown as Course;
  await saveCourse(lessons("d".repeat(32)), ROOM, true);
  await saveCourse(lessons("f".repeat(32)), ROOM, true);
  if (!(await setProductCourse(OWNER, courseId, { id: "d".repeat(32), lessons: 1 })).ok) throw new Error("no course");
  if (!(await setProductCourse(OWNER, freeId, { id: "f".repeat(32), lessons: 1 })).ok) throw new Error("no free course");
  if (!(await setProductPodcast(OWNER, showId, { id: "9".repeat(32), episodes: 0 })).ok) throw new Error("no podcast");

  const store = (await storeForEmail(OWNER)) as Store;
  if (!store.sid) throw new Error("no store id");
  if (!(await putMember(store, EDITOR, "editor"))) throw new Error("no editor");
  const sessions = { stranger: "", owner: await openSession(OWNER), editor: await openSession(EDITOR) };
  type Who = keyof typeof sessions;
  const asked = (who: Who, path: string) => {
    const request = new NextRequest(`${BASE}${path}`, { headers: sessions[who] ? { cookie: `${SESSION_COOKIE}=${sessions[who]}` } : {} });
    answering(request);
    return request;
  };
  const studioCourse = (who: Who) => {
    asked(who, `/studio/course/${courseId}?store=${store.sid}`);
    return outcome(() => StudioCoursePage({ params: Promise.resolve({ product: courseId }), searchParams: Promise.resolve({ store: store.sid! }) }));
  };
  const studioPodcast = (who: Who) => {
    asked(who, `/studio/podcast/${showId}?store=${store.sid}`);
    return outcome(() => StudioPodcastPage({ params: Promise.resolve({ product: showId }), searchParams: Promise.resolve({ store: store.sid! }) }));
  };
  const productPage = (id: string) => {
    asked("stranger", `/@${HANDLE}/p/${id}`);
    return outcome(() => ProductPage({ params: Promise.resolve({ handle: `@${HANDLE}`, product: id }), searchParams: Promise.resolve({}) }));
  };
  const charge = async () => null;
  const hold = async () => async () => null;
  const now = async () => (await storeForEmail(OWNER)) as Store;
  const mcp = async (id: string) => {
    const s = await now();
    return {
      outline: await tool(() => readCourseTool(s, id, charge)),
      lesson: await tool(() => readLessonTool(s, id, "lesson000001", charge)),
      description: await tool(() => productTextTool(s, id, charge)),
      page: await tool(() => readSalesPageTool(s, id, charge)),
      test: await tool(() => readPageTestTool(s, id, charge)),
      reading: await tool(() => readPageReadingTool(s, id, charge)),
      versions: await tool(() => readPageVersionsTool(s, id, null, hold)),
    };
  };
  const front = async () => (await readPage(await now(), 1)).listings.map((l) => l.id);
  const found = async () => (await searchStore(await now(), "Held Product")).listings.map((l) => l.id);

  part("Before any hold");
  is("the MCP server reads the course", (await mcp(courseId)).outline, "read");
  is("the front page and the search list the products", [(await front()).includes(pageId), (await found()).includes(pageId)], [true, true]);

  part("A child-safety report holds the course, the podcast and the guide");
  for (const id of [courseId, showId, pageId]) is(`held: ${id}`, await holdReported({ kind: "child_safety", url: `${BASE}/@${HANDLE}/p/${id}` }, await now()), "held");

  part("The MCP server hands nothing of a held product to an AI client, whoever holds the key");
  const refused = { outline: 409, lesson: 409, description: 409, page: 409, test: 409, reading: 409, versions: 409 };
  is("the course: outline, lesson, description, page, test, reading and versions are refused", await mcp(courseId), refused);
  is("the guide too", await mcp(pageId), refused);
  is("a product that is not held is still read", (await mcp(freeId)).outline, "read");

  part("The studio's course and podcast pages are the owner's only, as the course route is");
  is("someone on the team is sent back to the studio", [await studioCourse("editor"), await studioPodcast("editor")], [`redirect /studio?store=${store.sid}&team=held`, `redirect /studio?store=${store.sid}&team=held`]);
  is("the owner is not sent back for it", [(await studioCourse("owner")).includes("team=held"), (await studioPodcast("owner")).includes("team=held")], [false, false]);

  part("A hold whose taking off the store did not go through: its own page at once, then the hourly job takes it off");
  // The store's lock answers off its shape, so taking a product off cannot be written (lib/store.ts withStore).
  const real = redis.pipeline.bind(redis);
  const lockBusy = () => {
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands.some((command) => command[0] === "SET" && String(command[1]).startsWith("nl:store:lock:")) ? commands.map(() => "BUSY") : real(commands)) as typeof redis.pipeline;
  };
  const queued = async () => ((await real([["ZRANGEBYSCORE", "nl:csa:hide", "-inf", "+inf"]]))[0] as string[]).length;
  const run = (at = Date.now()) => (childSafety as unknown as { hideHeldProducts?: (now: number) => Promise<unknown> }).hideHeldProducts?.(at);
  is("a hold whose taking off went through leaves nothing waiting", await queued(), 0);
  const lateMade = await addProduct(OWNER, "Held Product late", "", "19", null);
  if (!lateMade.ok) throw new Error("no late product");
  const lateId = lateMade.product.id;
  // A new day for the automatic step's cap, which the three holds above reached.
  redis.run(["DEL", ...redis.keys().filter((key) => key.startsWith("nl:csa:held:"))]);
  lockBusy();
  const outcome0 = await holdReported({ kind: "child_safety", url: `${BASE}/@${HANDLE}/p/${lateId}` }, await now());
  redis.pipeline = real as typeof redis.pipeline;
  is("taking it off did not go through: the owner is told it could not be confirmed", outcome0, "unknown");
  is("it is still on the store", (await readListing(await now(), lateId))?.hidden, false);
  is("its public page sends a visitor to the store at once", await productPage(lateId), `redirect /@${HANDLE}`);
  is("and it waits to be taken off", await queued(), 1);
  lockBusy();
  for (let n = 0; n < 3; n++) await run(Date.now() + (n + 1) * 2 * 3_600_000);
  redis.pipeline = real as typeof redis.pipeline;
  is("while taking it off keeps failing, it stays off nowhere and waiting: never dropped", [(await readListing(await now(), lateId))?.hidden, await queued()], [false, 1]);
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.some((command) => command.slice(1).some((arg) => String(arg).startsWith("nl:csa:keep:"))) ? commands.map(() => 42) : real(commands)) as typeof redis.pipeline;
  await run(Date.now() + 8 * 3_600_000);
  redis.pipeline = real as typeof redis.pipeline;
  is("a mark that cannot be read is not a reason to drop it", await queued(), 1);
  await run(Date.now() + 10 * 3_600_000);
  is("the next run that can write takes it off", (await readListing(await now(), lateId))?.hidden, true);
  is("and, confirmed off, it waits no more", await queued(), 0);
  is("the store's front page no longer lists it", (await front()).includes(lateId), false);
  is("nor does its search", (await found()).includes(lateId), false);
  is("nor another product's page", await productPage(freeId), "drawn without it");
  is("a product that is not held is still listed", (await front()).includes(freeId), true);

  part("A hold cut short after its mark is still queued for the hourly job, before its files are held");
  const cutMade = await addProduct(OWNER, "Held Product cut", "", "19", null);
  if (!cutMade.ok) throw new Error("no cut product");
  const cutId = cutMade.product.id;
  redis.run(["DEL", ...redis.keys().filter((key) => key.startsWith("nl:csa:held:"))]);
  let marked = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const isMark = commands.some((command) => command[0] === "SET" && String(command[1]).startsWith("nl:csa:keep:"));
    const isQueue = commands.some((command) => command[0] === "ZADD" && command[1] === "nl:csa:hide");
    if (marked && !isQueue) return new Promise(() => {});
    if (isMark) marked = true;
    return real(commands);
  }) as typeof redis.pipeline;
  void holdReported({ kind: "child_safety", url: `${BASE}/@${HANDLE}/p/${cutId}` }, await now());
  await new Promise((resolve) => setTimeout(resolve, 150));
  redis.pipeline = real as typeof redis.pipeline;
  is("kept, and queued although everything after the mark hung", [marked, await queued()], [true, 1]);

  part("A mark that cannot be read refuses, never shows the content");
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.some((command) => command.slice(1).some((arg) => String(arg).startsWith("nl:csa:keep:"))) ? commands.map(() => 42) : real(commands)) as typeof redis.pipeline;
  is("the MCP lesson: try again later", (await mcp(freeId)).lesson, 503);
  is("the team's studio course page sends them back, saying it could not be opened just now", await studioCourse("editor"), `redirect /studio?store=${store.sid}&team=unchecked`);
  is("the public page of a product that is not held either", await productPage(freeId), `redirect /@${HANDLE}`);
  redis.pipeline = real as typeof redis.pipeline;

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
