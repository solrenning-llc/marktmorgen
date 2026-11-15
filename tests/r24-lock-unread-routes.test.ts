/**
 * Rule 24 for the two-step lock at the routes that ask it (the open point of
 * #3552): when the read of a session's lock fails (lib/two-step.ts lockedUntil
 * or lockedFor throws: Redis did not answer), nothing that waits for the lock
 * is done, and the person is told so in plain words, never with a server error
 * (500) and never as unlocked:
 *
 *   - a route the studio's code reads (JSON) answers 503, error "lock_unread",
 *     the sentence below and Retry-After;
 *   - a route reached by a form or a link answers 503 with a page that says
 *     the same, and Retry-After;
 *   - nothing is changed: what the request would have deleted or replaced is
 *     read back after it.
 *
 * Each group sends the real route a request from the owner's own full session
 * with only the lock's read made to fail (its MGET on the lock key throws).
 * Controls: the same requests with the read working are not answered so.
 *
 * Not here: app/api/store/community/events/route.ts (an event moved) and
 * app/api/store/address/route.ts (the sign-in address moved), reserved by
 * other agents (docs/reservations/claude3.md, codex.md); both still end in a
 * 500 that changes nothing when the lock cannot be read.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, emailForSession, openSession } from "@/lib/auth";
import { addProduct, addStoreLink, claimHandle, ensureStatsId, setLinkImage, setPhotoId, setProductFile, setProductImage, setProductPage, setSitePages, storeForEmail } from "@/lib/store";
import { readFields } from "@/lib/crm";
import { CREATOR, createPost, readConfig, readPost } from "@/lib/community";
import { readListing } from "@/lib/catalog";
import { readPage, writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { readCourse, saveCourse } from "@/lib/course";
import { addComment, readComment, setCommentsOn } from "@/lib/lesson-comments";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";
import { LOCK_UNREAD, LOCK_UNREAD_MESSAGE, lockOrUnread, lockRead } from "@/lib/two-step-unknown";
import { POST as passkey } from "@/app/api/auth/passkey/route";
import { POST as recoveryAddress } from "@/app/api/auth/recovery-address/route";
import { POST as signoutAll } from "@/app/api/auth/signout-all/route";
import { POST as twoStep } from "@/app/api/auth/two-step/route";
import { GET as zoomHost } from "@/app/api/integrations/zoom/host/route";
import { POST as billingPause } from "@/app/api/billing/pause/route";
import { GET as assistantMemory } from "@/app/api/store/assistant-memory/route";
import { POST as notes } from "@/app/api/store/notes/route";
import { POST as community } from "@/app/api/store/community/route";
import { POST as communityChat } from "@/app/api/store/community/chat/route";
import { POST as communityManage } from "@/app/api/store/community/manage/route";
import { POST as course } from "@/app/api/store/course/route";
import { POST as courseComment } from "@/app/api/store/course/comment/route";
import { POST as crm } from "@/app/api/store/crm/route";
import { POST as fileAttach } from "@/app/api/store/file/attach/route";
import { POST as image } from "@/app/api/store/image/route";
import { POST as linkImage } from "@/app/api/store/link-image/route";
import { POST as links } from "@/app/api/store/links/route";
import { POST as page } from "@/app/api/store/page/route";
import { POST as photo } from "@/app/api/store/photo/route";
import { POST as product } from "@/app/api/store/product/route";
import { POST as sitePage } from "@/app/api/store/site-page/route";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
// Synthetic values only: Zoom is "switched on" so its host route reaches the studio's check; nothing is sent to it.
process.env.ZOOM_CLIENT_ID = "tests-only-zoom-id";
process.env.ZOOM_CLIENT_SECRET = "tests-only-zoom-secret";
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = "tests-only-zoom-token";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const OWNER = "unread.maker@example.com";
const HANDLE = "unreadshop";
const ORIGIN = "https://marktmorgen.com";
const SAID = "We couldn't check your sign-in right now. Nothing was changed. Try again in a minute.";

type Handler = (request: NextRequest) => Promise<Response>;
const json = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const form = (path: string, session: string, fields: Record<string, string>) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${SESSION_COOKIE}=${session}` }, body: new URLSearchParams(fields) });
const get = (path: string, session: string) => new NextRequest(`${ORIGIN}${path}`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
/** A picture's path as the store keeps one (lib/product-image.ts). */
const picture = (n: string) => `images/${"a".repeat(24)}/${n.repeat(32)}.jpg`;

/** Only the read of a session's lock fails, while `faulty` is set; every other command is answered. */
let faulty = false;
let faults = 0;
const kept = redis.pipeline;
redis.pipeline = async (commands) => {
  if (faulty && commands.some((c) => c[0] === "MGET" && String(c[1]).startsWith("nl:2fa:locked:"))) {
    faults += 1;
    throw new Error("SYNTHETIC_LOCK_READ_FAULT");
  }
  return kept.call(redis, commands);
};

/** The route's answer, read whole; a route that threw is what the platform would send: a 500. */
async function outcome(handler: Handler, request: NextRequest): Promise<{ status: number; error: string; text: string; retry: string | null; html: boolean }> {
  try {
    const response = await handler(request);
    const text = await response.text();
    let error = "";
    try {
      error = String((JSON.parse(text) as { error?: unknown }).error ?? "");
    } catch {
      error = "";
    }
    return { status: response.status, error, text, retry: response.headers.get("retry-after"), html: (response.headers.get("content-type") ?? "").startsWith("text/html") };
  } catch (thrown) {
    return { status: 500, error: "thrown", text: String(thrown), retry: null, html: false };
  }
}

/** With the lock unread: a JSON route's answer, as [status, error, said, Retry-After]. */
async function unreadJson(handler: Handler, request: NextRequest) {
  faulty = true;
  const before = faults;
  try {
    const got = await outcome(handler, request);
    let said = "";
    try {
      said = String((JSON.parse(got.text) as { message?: unknown }).message ?? "");
    } catch {
      said = "";
    }
    return [faults > before, got.status, got.error, said, got.retry];
  } finally {
    faulty = false;
  }
}
const JSON_UNREAD = [true, 503, "lock_unread", SAID, "60"];

/** With the lock unread: a form's or a link's answer, as [status, a page, says it, Retry-After]. */
async function unreadPage(handler: Handler, request: NextRequest) {
  faulty = true;
  const before = faults;
  try {
    const got = await outcome(handler, request);
    return [faults > before, got.status, got.html, got.text.includes(SAID.replace("couldn't", "couldn&#39;t")) || got.text.includes(SAID), got.retry];
  } finally {
    faulty = false;
  }
}
const PAGE_UNREAD = [true, 503, true, true, "60"];

/** With the lock read: whatever it answers, it is not the unread answer. */
async function read(handler: Handler, request: NextRequest) {
  const got = await outcome(handler, request);
  return got.status !== 503 && got.error !== "lock_unread" && got.status !== 500;
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Unread Shop", "");
  await ensureStatsId(OWNER);
  const full = await openSession(OWNER);

  part("Sign-in settings: passkeys, the recovery address, two-step login, logging out everywhere");
  is("passkeys (JSON): 503, said, Retry-After", await unreadJson(passkey as Handler, json("/api/auth/passkey", full, { action: "list" })), JSON_UNREAD);
  is("the recovery address (JSON)", await unreadJson(recoveryAddress as Handler, json("/api/auth/recovery-address", full, { address: "other@example.com" })), JSON_UNREAD);
  is("two-step login (JSON)", await unreadJson(twoStep as Handler, json("/api/auth/two-step", full, { action: "start" })), JSON_UNREAD);
  is("logging out everywhere (a form): a page that says so", await unreadPage(signoutAll as Handler, form("/api/auth/signout-all", full, {})), PAGE_UNREAD);
  is("and the session is still open: nobody was logged out", await emailForSession(full), OWNER);
  is("control: passkeys with the lock read", await read(passkey as Handler, json("/api/auth/passkey", full, { action: "list" })), true);

  part("The studio's own check (studioAccess): JSON, a form and a link");
  is("a note removed (guardStoreWrite, JSON)", await unreadJson(notes as Handler, json("/api/store/notes", full, { action: "remove", id: "x" })), JSON_UNREAD);
  is("the assistant's notes read (jsonAccess, settings)", await unreadJson(assistantMemory as Handler, get("/api/store/assistant-memory", full)), JSON_UNREAD);
  is("the plan paused (creatorFrom, a form)", await unreadPage(billingPause as Handler, form("/api/billing/pause", full, {})), PAGE_UNREAD);
  is("a Zoom host link (a link)", await unreadPage(zoomHost as Handler, get("/api/integrations/zoom/host?scope=x", full)), PAGE_UNREAD);
  is("control: the assistant's notes with the lock read", await read(assistantMemory as Handler, get("/api/store/assistant-memory", full)), true);

  part("The community: the chat room and posts");
  is("set up", ((await (await communityManage(json("/api/store/community/manage", full, { action: "enable", on: true }))).json()) as { ok: boolean }).ok, true);
  await communityManage(json("/api/store/community/manage", full, { action: "room", on: true }));
  const store = (await storeForEmail(OWNER))!;
  const cid = store.community!.id;
  const posted = await createPost(cid, { space: (await readConfig(cid))!.spaces[0].id, author: CREATOR, title: "Hello", text: "A post", img: null, kind: "post", poll: null }, store);
  if (!posted.ok) throw new Error("no post");
  is("emptying the chat room (JSON)", await unreadJson(communityChat as Handler, json("/api/store/community/chat", full, { handle: HANDLE, action: "clear" })), JSON_UNREAD);
  is("a post deleted (a form)", await unreadPage(community as Handler, form("/api/store/community", full, { handle: HANDLE, action: "delete", post: posted.post.id })), PAGE_UNREAD);
  is("and the post is still there", Boolean(await readPost(cid, posted.post.id)), true);

  part("The course: a new video over the old one, a lesson comment deleted");
  const made = await addProduct(OWNER, "Course", "", "99", null);
  if (!made.ok) throw new Error("no product");
  const pid = made.product.id;
  await course(json("/api/store/course", full, { action: "enable", id: pid }));
  await course(json("/api/store/course", full, { action: "edit", id: pid, op: "module-add", title: "Start" }));
  const listing = (await readListing((await storeForEmail(OWNER))!, pid))!;
  let kept2 = (await readCourse(listing.course!.id))!;
  await course(json("/api/store/course", full, { action: "edit", id: pid, op: "lesson-add", moduleId: kept2.modules[0].id, title: "One" }));
  kept2 = (await readCourse(listing.course!.id))!;
  const lessonId = kept2.modules[0].lessons[0].id;
  kept2.modules[0].lessons[0] = { ...kept2.modules[0].lessons[0], video: { pathname: "stores/x/old.mp4", name: "old.mp4", bytes: 10, contentType: "video/mp4", addedAt: "" } };
  await saveCourse(kept2, ROOM);
  is("a new video over the lesson's (JSON)", await unreadJson(course as Handler, json("/api/store/course", full, { action: "media", id: pid, lessonId, kind: "video", pathname: "stores/x/new.mp4" })), JSON_UNREAD);
  is("and the lesson keeps its video", (await readCourse(listing.course!.id))!.modules[0].lessons[0].video?.pathname, "stores/x/old.mp4");
  await setCommentsOn(listing.course!.id, true);
  const said = await addComment({ courseId: listing.course!.id, lessonId, by: "s".repeat(16), name: "Sam", text: "A question", room: ROOM });
  if (!said.ok) throw new Error("no comment");
  is(
    "a lesson comment deleted from the lesson page (a form)",
    await unreadPage(courseComment as Handler, form("/api/store/course/comment", full, { handle: HANDLE, product: pid, lesson: lessonId, action: "delete", id: said.comment.id })),
    PAGE_UNREAD,
  );
  is("and the comment is still there", Boolean(await readComment(listing.course!.id, said.comment.id)), true);

  part("The product: its file, picture and page");
  const extra = await addProduct(OWNER, "Ebook", "", "19", null);
  if (!extra.ok) throw new Error("no product");
  const xid = extra.product.id;
  await setProductFile(OWNER, xid, { pathname: `stores/x/${xid}/book.pdf`, name: "book.pdf", bytes: 10, contentType: "application/pdf", addedAt: "" });
  const fileName = async () => (await readListing((await storeForEmail(OWNER))!, xid))?.file?.name;
  is("a link put over the file (JSON)", await unreadJson(product as Handler, json("/api/store/product", full, { action: "link", id: xid, link: "https://example.com/elsewhere" })), JSON_UNREAD);
  is("a new file over it (JSON)", await unreadJson(fileAttach as Handler, json("/api/store/file/attach", full, { id: xid, pathname: `stores/x/${xid}/other.pdf` })), JSON_UNREAD);
  is("and the product keeps its file", await fileName(), "book.pdf");
  await setProductImage(OWNER, xid, { path: picture("1"), width: 10, height: 10, alt: "", bytes: 10, small: null });
  is("a new picture over it (JSON)", await unreadJson(image as Handler, json("/api/store/image", full, { action: "attach", id: xid, path: picture("2"), width: 10, height: 10 })), JSON_UNREAD);
  is("and the product keeps its picture", (await readListing((await storeForEmail(OWNER))!, xid))?.image?.path, picture("1"));
  await setProductPage(OWNER, xid, true);
  const pictures = { ...parsePage({}), blocks: [{ id: "blk001", kind: "pictures", heading: "", items: [{ path: picture("3"), width: 10, height: 10, alt: "", caption: "" }] }] };
  await writePage(store.statsId!, xid, pictures as never, ROOM);
  is("a page saved without a picture it showed (JSON)", await unreadJson(page as Handler, json("/api/store/page", full, { id: xid, page: { blocks: [] } })), JSON_UNREAD);
  is("and the page still shows it", (await readPage(store.statsId!, xid)).blocks.length, 1);

  part("The store's pages: a site page, a link and its picture, the store photo");
  await setSitePages(OWNER, [{ id: "pagepage01", slug: "about", title: "About", nav: false, target: "", from: 0 }]);
  await writePage(store.statsId!, siteKey("pagepage01"), pictures as never, ROOM);
  is("a site page saved without a picture it showed (JSON)", await unreadJson(sitePage as Handler, json("/api/store/site-page", full, { action: "save", id: "pagepage01", page: { blocks: [] } })), JSON_UNREAD);
  is("and the site page still shows it", (await readPage(store.statsId!, siteKey("pagepage01"))).blocks.length, 1);
  const linked = await addStoreLink(OWNER, "My site", "https://example.com", {});
  if (!linked.ok) throw new Error("no link");
  const linkId = linked.store.links[0].id;
  await setLinkImage(OWNER, linkId, { path: picture("4"), width: 10, height: 10, bytes: 10 });
  const linkPicture = async () => (await storeForEmail(OWNER))!.links.find((l) => l.id === linkId)?.image?.path;
  is("a new link picture over the old one (JSON)", await unreadJson(linkImage as Handler, json("/api/store/link-image", full, { action: "attach", id: linkId, path: picture("2"), width: 10, height: 10 })), JSON_UNREAD);
  is("the link turned into a heading (JSON)", await unreadJson(links as Handler, json("/api/store/links", full, { action: "edit", id: linkId, title: "Heading", header: true })), JSON_UNREAD);
  is("and the link keeps its picture", await linkPicture(), picture("4"));
  await setPhotoId(OWNER, "a".repeat(32));
  is("a new store photo over it (JSON)", await unreadJson(photo as Handler, json("/api/store/photo", full, { photo: "data:image/png;base64,AAAA" })), JSON_UNREAD);
  is("and the store keeps its photo", (await storeForEmail(OWNER))!.photoId, "a".repeat(32));

  part("The store's own fields about each person");
  const company = { id: "fielda", name: "Company", type: "text", options: [] };
  const goal = { id: "fieldb", name: "Goal", type: "text", options: [] };
  is("two fields saved", ((await (await crm(json("/api/store/crm", full, { action: "fields", fields: [company, goal] }))).json()) as { ok: boolean }).ok, true);
  is("saved without one of them (JSON)", await unreadJson(crm as Handler, json("/api/store/crm", full, { action: "fields", fields: [company] })), JSON_UNREAD);
  is("and both are still there", (await readFields(store.statsId!)).map((f) => f.id), ["fielda", "fieldb"]);
  is("control: with the lock read, they save", await read(crm as Handler, json("/api/store/crm", full, { action: "fields", fields: [company, goal] })), true);

  part("The helper: only the read handed in is caught, and the words are the ones above");
  is("the sentence is the one every answer says", LOCK_UNREAD_MESSAGE, SAID);
  is("a read that answers is passed through as it is", [await lockOrUnread(Promise.resolve(0)), await lockRead(Promise.resolve(true)), await lockRead(Promise.resolve(1_700_000_000_000))], [0, true, 1_700_000_000_000]);
  is("a read that failed is LOCK_UNREAD, never 0 or false", (await lockOrUnread(Promise.reject(new Error("SYNTHETIC")))) === LOCK_UNREAD, true);
  let elsewhere = "";
  try {
    const lock = await lockRead(Promise.resolve(false));
    if (lock instanceof Response) throw new Error("read as unread");
    throw new Error("SYNTHETIC_AFTER_THE_READ");
  } catch (error) {
    elsewhere = error instanceof Error ? error.message : "";
  }
  is("an error after the read is not answered as an unread lock: it goes on to the route", elsewhere, "SYNTHETIC_AFTER_THE_READ");
  const pageAnswer = (await lockRead(Promise.reject(new Error("SYNTHETIC")), { back: `${ORIGIN}/@${HANDLE}/community?space=a&x="b"`, to: "the community" })) as Response;
  const html = await pageAnswer.text();
  is(
    "the page: English, one heading, the sentence, a way back said by its link, the address escaped, no cache",
    [/<html lang="en">/.test(html), (html.match(/<h1>/g) ?? []).length, html.includes("Back to the community</a>"), html.includes('space=a&#38;x=&#34;b&#34;"'), pageAnswer.headers.get("cache-control")],
    [true, 1, true, true, "no-store"],
  );

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
