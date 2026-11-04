/**
 * A session let in without its second step (lib/two-step.ts enterLocked: the
 * person who only has the creator's old inbox) may not delete anything for
 * good, nor email every member, until two-step login turns off (4 November
 * 2026, C2-76, after a review found the same harm through doors other than
 * erasing a person or removing a product). Each check below sends the real
 * route a request with a real locked session (openLockedSession) and the
 * creator's own store, and reads that it was refused before anything went:
 *
 *   - the community: an announcement emailed to every member, a post or a
 *     comment deleted, the chat room emptied or a message taken out, a
 *     reported post deleted, and a lesson comment deleted from the course;
 *   - the course: a lesson, a module, a lesson file, an assignment with the
 *     work handed in, a lesson comment, and a new video over the old one;
 *   - the product's file taken off or replaced, its picture removed or
 *     replaced, a page saved without a picture it showed, license keys and a
 *     bundle cleared, a price option, an episode, a page funnel, captions;
 *   - the store's pages: a form with its answers, a site page and its
 *     pictures, a saved block, a link and its picture, a short link, a blog
 *     post, the store photo, the missed questions;
 *   - events canceled, deleted or moved (each emails everyone coming);
 *   - notes, tasks, deals, pitches, segments and drafts deleted, a buyer's
 *     review photo taken off;
 *   - a passkey change does not spend the owner's hourly changes.
 *
 * And what has a way back stays open: adding and editing, a post that emails
 * nobody, an event edited without moving it.
 *
 * The inventory at the end reads every route under app/api/store that
 * deletes, and holds each to a way it is kept from a locked session, or to a
 * reason it is not the creator's store being deleted.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, addStoreLink, claimHandle, ensureStatsId, setLinkImage, setPhotoId, setProductFile, setProductImage, setProductPage, setSitePages, storeForEmail } from "@/lib/store";
import { LOCKED_ACTIONS, LOCKED_NEEDS, lockedOut, openLockedSession } from "@/lib/two-step";
import { LOCKED_LIST, LOCKED_LIST_START } from "@/lib/locked-words";
import { CREATOR, createPost, readConfig, readPost } from "@/lib/community";
import { readListing } from "@/lib/catalog";
import { readCourse, saveCourse } from "@/lib/course";
import { addComment, readComment, setCommentsOn } from "@/lib/lesson-comments";
import { writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";
import { POST as passkey } from "@/app/api/auth/passkey/route";
import { POST as rcourse_comment } from "@/app/api/store/course/comment/route";
import { POST as ranswers } from "@/app/api/store/answers/route";
import { POST as rassistant_settings } from "@/app/api/store/assistant-settings/route";
import { POST as rblog } from "@/app/api/store/blog/route";
import { POST as rbundle } from "@/app/api/store/bundle/route";
import { POST as rcommunity } from "@/app/api/store/community/route";
import { POST as rcommunity_chat } from "@/app/api/store/community/chat/route";
import { POST as rcommunity_events } from "@/app/api/store/community/events/route";
import { POST as rcommunity_manage } from "@/app/api/store/community/manage/route";
import { POST as rcourse } from "@/app/api/store/course/route";
import { POST as rcrm } from "@/app/api/store/crm/route";
import { POST as rfile_attach } from "@/app/api/store/file/attach/route";
import { POST as rforms } from "@/app/api/store/forms/route";
import { POST as rimage } from "@/app/api/store/image/route";
import { POST as rkeys } from "@/app/api/store/keys/route";
import { POST as rlink_image } from "@/app/api/store/link-image/route";
import { POST as rlinks } from "@/app/api/store/links/route";
import { POST as rmail } from "@/app/api/store/mail/route";
import { POST as rnotes } from "@/app/api/store/notes/route";
import { POST as roption } from "@/app/api/store/option/route";
import { POST as routreach } from "@/app/api/store/outreach/route";
import { POST as rpage } from "@/app/api/store/page/route";
import { POST as rpage_funnels } from "@/app/api/store/page-funnels/route";
import { POST as rperson } from "@/app/api/store/person/route";
import { POST as rperson_tasks } from "@/app/api/store/person-tasks/route";
import { POST as rphoto } from "@/app/api/store/photo/route";
import { POST as rpodcast } from "@/app/api/store/podcast/route";
import { POST as rproduct } from "@/app/api/store/product/route";
import { POST as rreviews } from "@/app/api/store/reviews/route";
import { POST as rsaved_blocks } from "@/app/api/store/saved-blocks/route";
import { POST as rshort_links } from "@/app/api/store/short-links/route";
import { POST as rsite_page } from "@/app/api/store/site-page/route";
import { POST as rspend } from "@/app/api/store/spend/route";
import { POST as rstream_captions } from "@/app/api/store/stream/captions/route";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const OWNER = "locked.maker@example.com";
const HANDLE = "lockedshop";
const ORIGIN = "https://marktmorgen.com";

type Handler = (request: NextRequest) => Promise<Response>;
const json = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const form = (path: string, session: string, fields: Record<string, string>) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${SESSION_COOKIE}=${session}` }, body: new URLSearchParams(fields) });
const answer = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? ""];
const LOCKED = [403, "locked"];
/** A picture's path as the store keeps one (lib/product-image.ts). */
const picture = (n: string) => `images/${"a".repeat(24)}/${n.repeat(32)}.jpg`;
const ROUTES: Record<string, Handler> = {
  "course/comment": rcourse_comment as Handler,
  "answers": ranswers as Handler,
  "assistant-settings": rassistant_settings as Handler,
  "blog": rblog as Handler,
  "bundle": rbundle as Handler,
  "community": rcommunity as Handler,
  "community/chat": rcommunity_chat as Handler,
  "community/events": rcommunity_events as Handler,
  "community/manage": rcommunity_manage as Handler,
  "course": rcourse as Handler,
  "crm": rcrm as Handler,
  "file/attach": rfile_attach as Handler,
  "forms": rforms as Handler,
  "image": rimage as Handler,
  "keys": rkeys as Handler,
  "link-image": rlink_image as Handler,
  "links": rlinks as Handler,
  "mail": rmail as Handler,
  "notes": rnotes as Handler,
  "option": roption as Handler,
  "outreach": routreach as Handler,
  "page": rpage as Handler,
  "page-funnels": rpage_funnels as Handler,
  "person": rperson as Handler,
  "person-tasks": rperson_tasks as Handler,
  "photo": rphoto as Handler,
  "podcast": rpodcast as Handler,
  "product": rproduct as Handler,
  "reviews": rreviews as Handler,
  "saved-blocks": rsaved_blocks as Handler,
  "short-links": rshort_links as Handler,
  "site-page": rsite_page as Handler,
  "spend": rspend as Handler,
  "stream/captions": rstream_captions as Handler,
};
const route = async (path: string): Promise<Handler> => {
  if (!Object.hasOwn(ROUTES, path)) throw new Error(`no route ${path}`);
  return ROUTES[path];
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Locked Shop", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Course", "", "99", null);
  if (!made.ok) throw new Error("no product");
  const pid = made.product.id;
  const full = await openSession(OWNER);
  const locked = await openLockedSession(OWNER, Date.now() + 7 * 86_400_000);

  part("The community: emailing every member and deleting wait");
  const manage = await route("community/manage");
  is("set up by the full session", ((await (await manage(json("/api/store/community/manage", full, { action: "enable", on: true }))).json()) as { ok: boolean }).ok, true);
  await manage(json("/api/store/community/manage", full, { action: "room", on: true }));
  const store = (await storeForEmail(OWNER))!;
  const cid = store.community!.id;
  const posted = await createPost(cid, { space: (await readConfig(cid))!.spaces[0].id, author: CREATOR, title: "Hello", text: "A post", img: null, kind: "post", poll: null }, store);
  if (!posted.ok) throw new Error("no post");
  const community = await route("community");
  const where = (response: Response) => new URL(response.headers.get("location") ?? `${ORIGIN}/`).searchParams.get("n");
  const announced = await community(form("/api/store/community", locked, { handle: HANDLE, action: "post", kind: "announcement", email: "1", title: "Urgent", text: "Pay here" }));
  is("an announcement emailed to every member is refused", where(announced), "locked");
  is("a post deleted is refused, and the post is still there", [where(await community(form("/api/store/community", locked, { handle: HANDLE, action: "delete", post: posted.post.id }))), Boolean(await readPost(cid, posted.post.id))], ["locked", true]);
  is("a comment deleted is refused", where(await community(form("/api/store/community", locked, { handle: HANDLE, action: "delete-comment", post: posted.post.id, comment: "c".repeat(12) }))), "locked");
  const plain = await community(form("/api/store/community", locked, { handle: HANDLE, action: "post", title: "Plain", text: "A post that emails nobody" }));
  is("a post that emails nobody is not", where(plain) !== "locked", true);
  const chat = await route("community/chat");
  is("emptying the chat room is refused", await answer(await chat(json("/api/store/community/chat", locked, { handle: HANDLE, action: "clear" }))), LOCKED);
  is("taking a chat message out is refused", await answer(await chat(json("/api/store/community/chat", locked, { handle: HANDLE, action: "unsay", number: 1 }))), LOCKED);
  is("a reported post deleted from the studio is refused", await answer(await manage(json("/api/store/community/manage", locked, { action: "report-delete", report: "post:x" }))), LOCKED);

  part("Events: canceling, deleting and moving one emails everyone coming");
  const events = await route("community/events");
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const event = { title: "Live Q&A", about: "", date: day, time: "15:00", tz: "UTC", minutes: 60, where: "room", cap: "" };
  const created = (await (await events(json("/api/store/community/events", full, { action: "create", ...event }))).json()) as { ok: boolean; event?: { id: string } };
  is("made by the full session", created.ok, true);
  const eid = created.event?.id ?? "";
  is("canceling it is refused", await answer(await events(json("/api/store/community/events", locked, { action: "cancel", event: eid }))), LOCKED);
  is("deleting it is refused", await answer(await events(json("/api/store/community/events", locked, { action: "delete", event: eid }))), LOCKED);
  is("moving it is refused", await answer(await events(json("/api/store/community/events", locked, { action: "edit", event: eid, ...event, time: "16:00" }))), LOCKED);
  is("renaming it, at the same time, is not", ((await (await events(json("/api/store/community/events", locked, { action: "edit", event: eid, ...event, title: "Live questions" }))).json()) as { ok: boolean }).ok, true);

  part("The course: what takes a lesson, a file or students' work away waits");
  const course = await route("course");
  await course(json("/api/store/course", full, { action: "enable", id: pid }));
  await course(json("/api/store/course", full, { action: "edit", id: pid, op: "module-add", title: "Start" }));
  const listing = (await readListing((await storeForEmail(OWNER))!, pid))!;
  let kept = (await readCourse(listing.course!.id))!;
  const moduleId = kept.modules[0].id;
  is("a lesson added from the locked session: adding stays open", ((await (await course(json("/api/store/course", locked, { action: "edit", id: pid, op: "lesson-add", moduleId, title: "One" }))).json()) as { ok: boolean }).ok, true);
  kept = (await readCourse(listing.course!.id))!;
  const lessonId = kept.modules[0].lessons[0].id;
  for (const op of ["lesson-remove", "module-remove", "media-remove"]) {
    is(`"${op}" is refused`, await answer(await course(json("/api/store/course", locked, { action: "edit", id: pid, op, lessonId, moduleId, pathname: "x" }))), LOCKED);
  }
  is("taking an assignment off, with the work handed in, is refused", await answer(await course(json("/api/store/course", locked, { action: "task", id: pid, lessonId, task: null }))), LOCKED);
  is("deleting a lesson comment from the studio is refused", await answer(await course(json("/api/store/course", locked, { action: "cm-delete", id: pid, comment: "x" }))), LOCKED);
  kept.modules[0].lessons[0] = { ...kept.modules[0].lessons[0], video: { pathname: "stores/x/old.mp4", name: "old.mp4", bytes: 10, contentType: "video/mp4", addedAt: "" } };
  await saveCourse(kept, ROOM);
  is("a new video over the lesson's old one is refused", await answer(await course(json("/api/store/course", locked, { action: "media", id: pid, lessonId, kind: "video", pathname: "stores/x/new.mp4" }))), LOCKED);
  is("and the lesson keeps it", (await readCourse(listing.course!.id))!.modules[0].lessons[0].video?.pathname, "stores/x/old.mp4");
  await setCommentsOn(listing.course!.id, true);
  const said = await addComment({ courseId: listing.course!.id, lessonId, by: "s".repeat(16), name: "Sam", text: "A question", room: ROOM });
  if (!said.ok) throw new Error("no comment");
  const lessonComment = await (await route("course/comment"))(
    form("/api/store/course/comment", locked, { handle: HANDLE, product: pid, lesson: lessonId, action: "delete", id: said.comment.id }),
  );
  is("deleting it from the lesson page is refused too, and it is still there", [new URL(lessonComment.headers.get("location") ?? `${ORIGIN}/`).searchParams.get("c"), Boolean(await readComment(listing.course!.id, said.comment.id))], ["locked", true]);

  part("The product: its file, picture, page, keys and the rest");
  const extra = await addProduct(OWNER, "Ebook", "", "19", null);
  if (!extra.ok) throw new Error("no product");
  const xid = extra.product.id;
  await setProductFile(OWNER, xid, { pathname: `stores/x/${xid}/book.pdf`, name: "book.pdf", bytes: 10, contentType: "application/pdf", addedAt: "" });
  const attach = await route("file/attach");
  is("taking the file off is refused", await answer(await attach(json("/api/store/file/attach", locked, { id: xid, detach: true }))), LOCKED);
  is("a new file over it is refused", await answer(await attach(json("/api/store/file/attach", locked, { id: xid, pathname: `stores/x/${xid}/other.pdf` }))), LOCKED);
  await setProductImage(OWNER, xid, { path: picture("1"), width: 10, height: 10, alt: "", bytes: 10, small: null });
  const image = await route("image");
  is("removing the picture is refused", await answer(await image(json("/api/store/image", locked, { action: "remove", id: xid }))), LOCKED);
  is("a new picture over it is refused", await answer(await image(json("/api/store/image", locked, { action: "attach", id: xid, path: picture("2"), width: 10, height: 10 }))), LOCKED);
  is("its alt text is not", (await answer(await image(json("/api/store/image", locked, { action: "alt", id: xid, alt: "A cover" }))))[1] !== "locked", true);
  await setProductPage(OWNER, xid, true);
  const pictures = { ...parsePage({}), blocks: [{ id: "blk001", kind: "pictures", heading: "", items: [{ path: picture("3"), width: 10, height: 10, alt: "", caption: "" }] }] };
  await writePage(store.statsId!, xid, pictures as never, ROOM);
  is("a page saved without a picture it showed is refused", await answer(await (await route("page"))(json("/api/store/page", locked, { id: xid, page: { blocks: [] } }))), LOCKED);
  const plainRoutes: [string, Record<string, unknown>][] = [
    ["product", { action: "remove", id: xid }],
    ["keys", { action: "clear", id: xid }],
    ["bundle", { action: "clear", id: xid }],
    ["option", { action: "remove", id: "x" }],
    ["podcast", { action: "remove", id: xid, episode: "x" }],
    ["page-funnels", { action: "remove", id: "x" }],
    ["stream/captions", { action: "remove", lessonId: "x", lang: "en" }],
  ];
  for (const [path, body] of plainRoutes) is(`${path}: ${String(body.action)} is refused`, await answer(await (await route(path))(json(`/api/store/${path}`, locked, body))), LOCKED);
  is("and the product is still there", Boolean((await storeForEmail(OWNER))!.catalog), true);

  part("The store's pages");
  await setSitePages(OWNER, [{ id: "pagepage01", slug: "about", title: "About", nav: false, target: "", from: 0 }]);
  await writePage(store.statsId!, siteKey("pagepage01"), pictures as never, ROOM);
  const sitePage = await route("site-page");
  is("a site page saved without a picture it showed is refused", await answer(await sitePage(json("/api/store/site-page", locked, { action: "save", id: "pagepage01", page: { blocks: [] } }))), LOCKED);
  const linked = await addStoreLink(OWNER, "My site", "https://example.com", {});
  if (!linked.ok) throw new Error("no link");
  const linkId = linked.store.links[0].id;
  await setLinkImage(OWNER, linkId, { path: picture("4"), width: 10, height: 10, bytes: 10 });
  is("a new link picture over the old one is refused", await answer(await (await route("link-image"))(json("/api/store/link-image", locked, { action: "attach", id: linkId, path: picture("2"), width: 10, height: 10 }))), LOCKED);
  await setPhotoId(OWNER, "a".repeat(32));
  const photo = await route("photo");
  is("removing the store photo is refused", await answer(await photo(json("/api/store/photo", locked, { remove: true }))), LOCKED);
  is("a new store photo over it is refused", await answer(await photo(json("/api/store/photo", locked, { photo: "data:image/png;base64,AAAA" }))), LOCKED);
  const pageRoutes: [string, Record<string, unknown>][] = [
    ["forms", { action: "remove", id: "x" }],
    ["site-page", { action: "remove", id: "pagepage01" }],
    ["saved-blocks", { action: "remove", id: "x" }],
    ["links", { action: "remove", id: linkId }],
    ["link-image", { action: "remove", id: linkId }],
    ["short-links", { action: "remove", code: "x" }],
    ["blog", { action: "delete", id: "x" }],
    ["answers", { clear: true }],
    ["assistant-settings", { clear: true }],
  ];
  for (const [path, body] of pageRoutes) is(`${path}: ${JSON.stringify(body)} is refused`, await answer(await (await route(path))(json(`/api/store/${path}`, locked, body))), LOCKED);
  is("saving a form is not", (await answer(await (await route("forms"))(json("/api/store/forms", locked, { form: { name: "Survey", fields: [{ id: "gggggg", type: "short", label: "Your name", required: true }] } }))))[1] !== "locked", true);

  part("Notes, tasks, deals, pitches, segments, drafts and review photos");
  const rest: [string, Record<string, unknown>][] = [
    ["person", { action: "unnote", person: "x", id: "x" }],
    ["person-tasks", { action: "remove", person: "x", id: "x" }],
    ["crm", { action: "undeal", id: "x" }],
    ["notes", { action: "remove", id: "x" }],
    ["spend", { action: "remove", id: "x" }],
    ["outreach", { action: "drop", id: "x" }],
    ["mail", { action: "segment-remove", id: "x" }],
    ["mail", { action: "draft-remove", id: "x" }],
    ["reviews", { action: "photo", product: "x", id: "x" }],
  ];
  for (const [path, body] of rest) is(`${path}: ${String(body.action)} is refused`, await answer(await (await route(path))(json(`/api/store/${path}`, locked, body))), LOCKED);

  part("A passkey change from a locked session does not spend the owner's");
  const passkeyRequest = (session: string) =>
    new NextRequest(`${ORIGIN}/api/auth/passkey`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "remove", id: "a-passkey" }) });
  // More than the hour's 30 changes (CHANGES_PER_HOUR in the route).
  for (let i = 0; i < 31; i += 1) await passkey(passkeyRequest(locked));
  is("the locked session is told locked, every time", await answer(await passkey(passkeyRequest(locked))), LOCKED);
  is("and the owner's own change is not refused for the hour", (await answer(await passkey(passkeyRequest(full))))[1] !== "rate_limited", true);

  part("Said the same way everywhere, and true");
  const files = ["app/signin/code/page.tsx", "app/signin/lost/page.tsx", "app/studio/page.tsx", "lib/two-step.ts", "lib/recovery-address.ts", "lib/help-content.ts", "lib/feature-pages.ts"];
  const root = process.cwd();
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    is(`${file} says the one list`, /\$\{LOCKED_LIST(_START)?\}/.test(text) && !text.includes("deleting a person or a product") && !text.includes("sending to your list"), true);
  }
  is("the list names imports, passkeys, two-step login, email to members and deleting for good", ["imports", "passkeys", "two-step login", "sending email to your list or your members", "deleting anything for good"].every((w) => LOCKED_LIST.includes(w)), true);
  is("and starts a sentence with a capital", LOCKED_LIST_START.startsWith("Payments, your plan"), true);

  part("Every route that deletes is held");
  // How each route under app/api/store that deletes for good is kept from a locked session:
  // "need:X", the whole permission waits; "act:need:action", that action waits (checked through
  // lockedOut, and by a request above); "lockedFor", the route asks lib/two-step.ts itself; or
  // "not:reason", what it deletes is not the creator's store's to keep.
  const HELD: Record<string, string[]> = {
    "affiliates": ["need:settings"],
    "agreements": ["need:send"],
    "answers": ["act:page:clear"],
    "assistant": ["not:a buyer deleting their own conversation with the assistant"],
    "assistant-settings": ["act:page:clear"],
    "blog": ["act:page:delete"],
    "bundle": ["act:products:clear", "not:a bundle made in the same request is taken back when its pictures fail"],
    "calendar": ["need:settings"],
    "community": ["lockedFor"],
    "community/chat": ["lockedFor"],
    "community/events": ["act:events:cancel", "act:events:delete", "lockedFor"],
    "community/manage": ["act:community:report-delete", "need:settings"],
    "course": ["act:products:lesson-remove", "act:products:module-remove", "act:products:media-remove", "act:products:task-remove", "act:products:cm-delete", "lockedFor"],
    "course/comment": ["lockedFor"],
    "course/task": ["not:a student replacing or taking back their own handed-in work"],
    "crm": ["act:orders:undeal"],
    "file/attach": ["act:products:detach", "lockedFor"],
    "forms": ["act:page:remove"],
    "host-calendar": ["not:a team member's own calendar connection, added again at will"],
    "image": ["act:products:remove", "lockedFor"],
    "keys": ["act:products:clear"],
    "link-image": ["act:page:remove", "lockedFor"],
    "links": ["act:page:remove"],
    "mail": ["act:draft:segment-remove", "act:draft:draft-remove", "need:send"],
    "notes": ["act:stats:remove"],
    "numbers-links": ["need:settings"],
    "option": ["act:products:remove"],
    "outreach": ["act:draft:drop"],
    "page": ["lockedFor"],
    "page-funnels": ["act:products:remove"],
    "payment-requests": ["need:send"],
    "person": ["act:orders:unnote", "need:erase"],
    "person-tasks": ["act:orders:remove"],
    "phone": ["not:a team member's own phone, added again at will"],
    "photo": ["act:page:remove", "lockedFor"],
    "podcast": ["act:products:remove"],
    "product": ["act:products:remove"],
    "review": ["not:a buyer deleting their own review, proved by their order"],
    "reviews": ["act:reviews:photo"],
    "saved-blocks": ["act:page:remove"],
    "short-links": ["act:page:remove"],
    "site-page": ["act:page:remove", "lockedFor"],
    "spend": ["act:stats:remove"],
    "stores": ["need:delete", "not:leaving a team the person was invited to, which deletes nothing of the store"],
    "stream/captions": ["act:products:remove"],
    "team": ["need:team"],
    "webhooks": ["need:settings"],
  };
  const DELETES = /\bdel\(|dropStream\(|dropTask\(|removeProduct\(|deletePost\(|deleteComment\(|\bdrop[A-Z][A-Za-z]*\(|remove[A-Z][A-Za-z]*\(|delete[A-Z][A-Za-z]*\(|clear[A-Z][A-Za-z]*\(/;
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const at = join(dir, name);
      return statSync(at).isDirectory() ? walk(at) : name === "route.ts" ? [at] : [];
    });
  const base = join(root, "app/api/store");
  const deleting = walk(base)
    .filter((file) => DELETES.test(readFileSync(file, "utf8")))
    .map((file) => relative(base, file).replace(/\/route\.ts$/, ""))
    .sort();
  is("every route that deletes is named here (a new one has to say how it is held)", deleting.filter((r) => !Object.hasOwn(HELD, r)), []);
  is("and none named here is gone", Object.keys(HELD).filter((r) => !deleting.includes(r)), []);
  const wrong: string[] = [];
  for (const [r, ways] of Object.entries(HELD)) {
    const text = readFileSync(join(base, r, "route.ts"), "utf8");
    for (const way of ways) {
      const [kind, a, b] = way.split(":");
      if (kind === "need" && !(LOCKED_NEEDS.includes(a) && text.includes(`"${a}"`))) wrong.push(`${r} ${way}`);
      if (kind === "act" && !lockedOut(a, b, r)) wrong.push(`${r} ${way}`);
      if (kind === "lockedFor" && !/lockedFor\(request/.test(text)) wrong.push(`${r} ${way}`);
      if (kind === "not" && (a ?? "").length < 20) wrong.push(`${r} ${way}`);
    }
  }
  is("each one held the way it says", wrong, []);
  const named = new Set(Object.values(HELD).flat().filter((w) => w.startsWith("act:")).map((w) => w.split(":").slice(1).join(":")));
  const unused = Object.entries(LOCKED_ACTIONS).flatMap(([need, list]) => list.filter((a) => ![...named].some((n) => n === `${need}:${a.replace(/^[a-z/-]+:/, "")}`) && !["replace", "move", "email", "delete", "delete-comment", "unsay", "clear"].includes(a)).map((a) => `${need}:${a}`));
  is("and every action LOCKED_ACTIONS names is one a route here uses (the in-route ones are asked through lockedFor)", unused, []);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
