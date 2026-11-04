/**
 * A session let in without the second step (lib/two-step.ts, enterLocked)
 * keeps "products": it may edit them, hide them and change their order. It
 * may not destroy them (506 [SG1], MM-SA-14): removing a product deletes its
 * files, its course lessons, the work its students handed in, its reviews and
 * its page for good, and putting a link on a product deletes the file the
 * link replaces. Both are refused with the studio's own "locked" answer while
 * the session is locked; a full session still does both, and the roles that
 * may remove a product are the same as before.
 *
 * What fails here:
 *   - a locked session removing a product, or anything of it going;
 *   - a locked session replacing a product's file with a link;
 *   - a locked session refused an ordinary edit, or a link on a product with no file;
 *   - a full session refused the removal.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { SESSION_COOKIE, emailForSession, openSession } from "@/lib/auth";
import { finishSetup, lockedUntil, startSetup } from "@/lib/two-step";
import { addOption, addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, productFile, setProductFile, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { readCourse } from "@/lib/course";
import { addComment, readComment } from "@/lib/lesson-comments";
import { readPodcast, savePodcast } from "@/lib/podcast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { POST as callback } from "@/app/api/auth/callback/route";
import { POST as codeRoute } from "@/app/api/auth/code/route";
import { POST as productRoute } from "@/app/api/store/product/route";
import { POST as optionRoute } from "@/app/api/store/option/route";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { POST as podcastRoute } from "@/app/api/store/podcast/route";
import { POST as attachRoute } from "@/app/api/store/file/attach/route";
import { POST as sitePageRoute } from "@/app/api/store/site-page/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_locked_product_only_a_stand_in";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const host = new URL(String(input instanceof Request ? input.url : input)).hostname;
  if (host === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  if (host === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
const nowCode = (secret: string) => codeAt(base32Decode(secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));
const form = (url: string, fields: Record<string, string>, cookie = "") =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields) });
const cookieOf = (response: Response, name: string) => (response.headers.get("set-cookie") ?? "").match(new RegExp(`${name}=([^;]*)`))?.[1] ?? "";

async function lockedSessionFor(email: string): Promise<string> {
  const token = sha(String(Math.random()));
  await redis.pipeline([["SET", `nl:auth:link:${sha(`nimbus-auth-link:${token}`).slice(0, 40)}`, email, "EX", 900]]);
  const hold = cookieOf(await callback(form("https://marktmorgen.com/api/auth/callback", { token })), "nl_2fa");
  return cookieOf(await codeRoute(form("https://marktmorgen.com/api/auth/code", { action: "reset" }, `nl_2fa=${hold}`)), "nl_session");
}

async function product(session: string, body: Record<string, unknown>): Promise<{ status: number; error?: string }> {
  const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  return { status: response.status, error: ((await response.json()) as { error?: string }).error };
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "owner@locked-product.example";
  const BACKUP = "owner.backup@locked-product.example";
  await claimHandle(OWNER, "locked-product", "Locked Product", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1LockedProdXXX", true);
  await setSubscription(OWNER, { customerId: "cus_lockedproduct", subscriptionId: "sub_lockedproduct", active: true, tier: "creator", period: paidPeriod() });
  const started = await startSetup(OWNER, "c".repeat(64), BACKUP);
  if (typeof started === "string") throw new Error(`setup: ${started}`);
  const finished = await finishSetup(OWNER, "c".repeat(64), nowCode(started.secret), codeTo(BACKUP));
  if (typeof finished === "string") throw new Error(`finish: ${finished}`);

  const added = await addProduct(OWNER, "Field Guide", "Plants of the coast.", "20");
  if (!added.ok) throw new Error("no product");
  const id = added.product.id;
  const file = { pathname: `stores/locked-product/${id}/guide.pdf`, name: "guide.pdf", bytes: 1_000, contentType: "application/pdf", addedAt: "2026-10-01T00:00:00.000Z" };
  const put = await setProductFile(OWNER, id, file);
  if (!put.ok) throw new Error("no file");
  const plain = await addProduct(OWNER, "Coast Walk", "A walk.", "10");
  if (!plain.ok) throw new Error("no second product");
  const listing = async (which: string) => readListing((await storeForEmail(OWNER))!, which);

  const locked = await lockedSessionFor(OWNER);
  is("the session is the owner's, and locked", [await emailForSession(locked), (await lockedUntil(locked)) > 0], [OWNER, true]);

  part("A locked session cannot remove a product");
  is("refused with the studio's locked answer", await product(locked, { action: "remove", id }), { status: 403, error: "locked" });
  const kept = await listing(id);
  is("the product is still there, with its file", [kept?.id, kept?.file?.pathname], [id, file.pathname]);
  is("and the studio says why in its own words", typeof STUDIO_MESSAGES.locked === "string" && STUDIO_MESSAGES.locked.includes("second step"), true);

  part("Nor delete a product's file by putting a link in its place");
  is("refused while the product holds a file", await product(locked, { action: "link", id, link: "https://example.com/guide" }), { status: 403, error: "locked" });
  is("the file is still on the product", (await listing(id))?.file?.pathname, file.pathname);

  part("What a locked session keeps");
  is("an ordinary edit is saved", (await product(locked, { action: "edit", id, title: "Field Guide, second edition", summary: "Plants of the coast.", price: "20" })).status, 200);
  is("a link on a product with no file is saved (nothing is deleted)", (await product(locked, { action: "link", id: plain.product.id, link: "https://example.com/walk" })).status, 200);
  is("hiding a product is saved", (await product(locked, { action: "visibility", id: plain.product.id, hidden: true })).status, 200);

  part("A full session still removes it, and the roles are unchanged");
  const full = await openSession(OWNER);
  is("removed", (await product(full, { action: "remove", id })).status, 200);
  is("and gone", await listing(id), null);
  is("the route still asks for the products permission, so the roles that may remove one are unchanged", readFileSync("app/api/store/product/route.ts", "utf8").includes('guardStoreWrite(request, "products", 40_000)'), true);

  // The other routes "products" and "page" keep open that delete for good what they otherwise only edit.
  const asStore = <T,>(route: (r: NextRequest) => Promise<T>, path: string) => async (session: string, body: Record<string, unknown>) => {
    const response = (await route(new NextRequest(`https://marktmorgen.com/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }))) as unknown as Response;
    return { status: response.status, error: ((await response.json().catch(() => ({}))) as { error?: string }).error };
  };
  const option = asStore(optionRoute, "option");
  const course = asStore(courseRoute, "course");
  const podcast = asStore(podcastRoute, "podcast");
  const attach = asStore(attachRoute, "file/attach");
  const sitePage = asStore(sitePageRoute, "site-page");
  const LOCKED = { status: 403, error: "locked" };

  part("A price option that holds a file is not removed by a locked session");
  const priced = await addProduct(OWNER, "Seed Packs", "Seeds.", "15");
  if (!priced.ok) throw new Error("no priced product");
  if (!(await addOption(OWNER, priced.product.id, "Deluxe", "30")).ok) throw new Error("no option");
  const optionId = (await listing(priced.product.id))?.options[0]?.id ?? "";
  const optionFile = { pathname: `stores/locked-product/${optionId}/deluxe.zip`, name: "deluxe.zip", bytes: 2_000, contentType: "application/zip", addedAt: "2026-10-01T00:00:00.000Z" };
  if (!(await setProductFile(OWNER, optionId, optionFile)).ok) throw new Error("no option file");
  is("refused as locked", await option(locked, { action: "remove", id: optionId }), LOCKED);
  is("the option and its file are still there", (await productFile(OWNER, optionId))?.file.pathname, optionFile.pathname);
  is("nor is the file taken off it through the upload route", await attach(locked, { id: optionId, detach: true }), LOCKED);
  is("still there", (await productFile(OWNER, optionId))?.file.pathname, optionFile.pathname);
  is("a full session removes the option", (await option(full, { action: "remove", id: optionId })).status, 200);
  is("and it is gone", (await listing(priced.product.id))?.options.length, 0);

  part("A product's own file is not taken off by a locked session");
  const sold = await addProduct(OWNER, "Tide Tables", "Tides.", "12");
  if (!sold.ok) throw new Error("no sold product");
  const soldFile = { pathname: `stores/locked-product/${sold.product.id}/tides.pdf`, name: "tides.pdf", bytes: 1_500, contentType: "application/pdf", addedAt: "2026-10-01T00:00:00.000Z" };
  if (!(await setProductFile(OWNER, sold.product.id, soldFile)).ok) throw new Error("no sold file");
  is("refused as locked", await attach(locked, { id: sold.product.id, detach: true }), LOCKED);
  is("the file is still on it", (await listing(sold.product.id))?.file?.pathname, soldFile.pathname);
  is("a full session takes it off", (await attach(full, { id: sold.product.id, detach: true })).status, 200);

  part("A course's lessons, assignments and students' comments are not deleted by a locked session");
  const taught = await addProduct(OWNER, "Botany Course", "A course.", "40");
  if (!taught.ok) throw new Error("no course product");
  const cid = taught.product.id;
  is("a course is set up", (await course(full, { action: "enable", id: cid })).status, 200);
  await course(full, { action: "edit", id: cid, op: "module-add", title: "Week one" });
  const courseId = (await listing(cid))?.course?.id ?? "";
  const moduleId = (await readCourse(courseId))?.modules[0]?.id ?? "";
  await course(full, { action: "edit", id: cid, op: "lesson-add", moduleId, title: "Leaves" });
  const lessonId = (await readCourse(courseId))?.modules[0]?.lessons[0]?.id ?? "";
  is("with a lesson that has an assignment", (await course(full, { action: "task", id: cid, lessonId, task: { prompt: "Press a leaf and photograph it." } })).status, 200);
  const said = await addComment({ courseId, lessonId, by: "student-key-0001", name: "Sam", text: "Which leaves work best?", room: (await storeForEmail(OWNER))! });
  if (!said.ok) throw new Error("no comment");
  const commentId = said.comment.id;
  is("taking the assignment off (and the work handed in) is refused", await course(locked, { action: "task", id: cid, lessonId, task: null }), LOCKED);
  is("deleting a student's comment is refused", await course(locked, { action: "cm-delete", id: cid, comment: commentId }), LOCKED);
  is("removing the lesson is refused", await course(locked, { action: "edit", id: cid, op: "lesson-remove", lessonId }), LOCKED);
  const still = await readCourse(courseId);
  is("the lesson, its assignment and the comment are all still there", [still?.modules[0]?.lessons[0]?.id, Boolean(still?.modules[0]?.lessons[0]?.task), (await readComment(courseId, commentId))?.id], [lessonId, true, commentId]);
  is("hiding the comment is still open", (await course(locked, { action: "cm-hide", id: cid, comment: commentId, hidden: true })).status, 200);
  is("renaming the lesson is still open", (await course(locked, { action: "edit", id: cid, op: "lesson-edit", lessonId, title: "Leaves and stems" })).status, 200);
  is("a full session removes the lesson", (await course(full, { action: "edit", id: cid, op: "lesson-remove", lessonId })).status, 200);

  part("A podcast episode is not deleted by a locked session");
  const show = await addProduct(OWNER, "Coast Podcast", "A show.", "8");
  if (!show.ok) throw new Error("no podcast product");
  is("a podcast is set up", (await podcast(full, { action: "enable", id: show.product.id })).status, 200);
  const podcastId = (await listing(show.product.id))?.podcast?.id ?? "";
  await savePodcast({ id: podcastId, episodes: [{ id: "ep0000000001", title: "Episode one", notes: "", pathname: `stores/locked-product/${show.product.id}/one.mp3`, bytes: 3_000, contentType: "audio/mpeg", at: 1_790_000_000 }] });
  is("refused as locked", await podcast(locked, { action: "remove", id: show.product.id, episode: "ep0000000001" }), LOCKED);
  is("the episode is still there", (await readPodcast(podcastId))?.episodes.length, 1);
  is("a full session removes it", (await podcast(full, { action: "remove", id: show.product.id, episode: "ep0000000001" })).status, 200);
  is("and it is gone", (await readPodcast(podcastId))?.episodes.length, 0);

  part("A page of the site is not deleted by a locked session");
  const made = await sitePage(locked, { action: "add", title: "About the coast" });
  is("a locked session may add a page", made.status, 200);
  const pageId = (await storeForEmail(OWNER))?.sitePages[0]?.id ?? "";
  is("but not delete one", await sitePage(locked, { action: "remove", id: pageId }), LOCKED);
  is("the page is still there", (await storeForEmail(OWNER))?.sitePages.map((p) => p.id), [pageId]);
  is("a full session deletes it", (await sitePage(full, { action: "remove", id: pageId })).status, 200);
  is("and it is gone", (await storeForEmail(OWNER))?.sitePages.length, 0);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
