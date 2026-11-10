/**
 * A file the browser names is put on a record only when it is new or already that record's own (4 November 2026,
 * after an independent review proved, on the real routes, that putting another record's picture on a second record
 * and then taking it off deleted the first record's file).
 *
 * A store's pictures share one folder (images/<folder>/), and a product's file and its episodes share the product's
 * folder; the routes checked only the folder. The fix, in one rule: a picture goes on a product, a link or a page
 * only when this request takes it from the picture door (lib/picture-door.ts), or when that record shows it already;
 * an episode's audio is never another episode's, nor the product's file. Each check below sends the real route a
 * real request from the creator's own session, with synthetic files in a file store held in memory
 * (tests/failure-cleanup-world.ts), and reads what is left:
 *
 *   - product to product: another product's picture refused, and replacing or removing the second one's keeps it;
 *   - a link: a product's picture refused, and taking the link off keeps it;
 *   - an option: a product's file is outside the option's folder, refused as before;
 *   - a product removed: what it was refused is not deleted with it;
 *   - a product's page and a site page: a product's or a link's picture in a block refused, so taking the block off
 *     (or removing the page) keeps it;
 *   - a podcast's episodes in the product's folder: one episode never takes another's audio (and a podcast takes
 *     no file, so the product's file and an episode never meet);
 *   - a buyer's review photo, in the same picture folder: refused on a product, a link and a page;
 *   - and what keeps working: a new picture through the door; keeping and replacing a record's own picture; a picture
 *     put on before this rule (never noted) still shown and replaceable; a page's save tried again;
 *   - a try that failed half way spends the door and deletes nothing: tried again it is refused, and the creator is
 *     told, neutrally and truly, to choose the picture again (never handed back to the door: a name noted again could
 *     be deleted by a later failure, the very thing this file guards against).
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addOption, addProduct, addStoreLink, claimHandle, ensureStatsId, imageFolder, setProductImage, setSitePages, storeFolder, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { fileFolder } from "@/lib/product-file";
import { keepReviewPhoto } from "@/lib/review-photo";
import { readPodcast, savePodcast } from "@/lib/podcast";
import { picturePaths } from "@/lib/sales-page";
import { readPage } from "@/lib/sales-page-store";
import { siteKey } from "@/lib/site-page-rules";
import { store as redis } from "./redis-stub";
import { files } from "./failure-cleanup-world";
import { done, is, part } from "./check";
import { POST as productImage } from "@/app/api/store/image/route";
import { POST as door } from "@/app/api/store/image/upload/route";
import { POST as linkImage } from "@/app/api/store/link-image/route";
import { POST as links } from "@/app/api/store/links/route";
import { POST as productRoute } from "@/app/api/store/product/route";
import { POST as optionRoute } from "@/app/api/store/option/route";
import { POST as pageRoute } from "@/app/api/store/page/route";
import { POST as sitePage } from "@/app/api/store/site-page/route";
import { POST as fileAttach } from "@/app/api/store/file/attach/route";
import { POST as podcast } from "@/app/api/store/podcast/route";

const OWNER = "owner.paths@example.com";
const ORIGIN = "https://marktmorgen.com";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
/** A buyer's photo as the review form sends it: a JPEG that says it is 100 by 100. */
const REVIEW_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 100, 0, 100, 3, ...new Array(12).fill(0)]).toString("base64");

const post = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const result = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, "ownerpaths", "Owner Paths", "");
  await ensureStatsId(OWNER);
  const made = await Promise.all(["Guide", "Course", "Workbook", "Old one", "Show"].map((title) => addProduct(OWNER, title, "", "19", null)));
  if (!made.every((m) => m.ok)) throw new Error("setup");
  const [a, b, c, legacy, show] = made.map((m) => (m.ok ? m.product.id : ""));
  const one = await addStoreLink(OWNER, "My podcast", "https://example.com/pod");
  const two = await addStoreLink(OWNER, "My blog", "https://example.com/blog");
  if (!one.ok || !two.ok) throw new Error("setup");
  const [linkOne, linkTwo] = two.store.links.map((link) => link.id);
  const session = await openSession(OWNER);
  const folder = await imageFolder(OWNER);
  let n = 0;
  const name = () => `images/${folder}/${(++n).toString(16).padStart(32, "0")}.jpg`;
  /** A picture let in through the door, as the studio's editors do it, and stored just after. */
  const upload = async (payload: Record<string, string>) => {
    const pathname = name();
    const asked = await door(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: JSON.stringify(payload), multipart: false } }));
    if (asked.status !== 200) throw new Error(`door ${asked.status}`);
    files.set(pathname, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
    return pathname;
  };
  const attach = (id: string, path: string, more: Record<string, unknown> = {}) =>
    productImage(post("/api/store/image", session, { action: "attach", id, path, width: 1200, height: 800, ...more })).then(result);
  const linkAttach = (id: string, path: string) => linkImage(post("/api/store/link-image", session, { action: "attach", id, path, width: 320, height: 180 })).then(result);
  const shownOn = async (id: string) => (await readListing((await storeForEmail(OWNER))!, id))?.image ?? null;
  const pictures = (id: string, paths: string[]) => ({ blocks: [{ id, kind: "pictures", heading: "", items: paths.map((path) => ({ path, width: 1200, height: 800, alt: "A page", caption: "" })) }] });

  part("Product to product");
  const aPicture = await upload({ productId: a });
  const aSmall = await upload({ productId: a });
  is("a new picture, with its smaller copy, through the door on product A", await attach(a, aPicture, { small: { path: aSmall, width: 400 } }), [200, "ok"]);
  is("A shows both", [(await shownOn(a))?.path, (await shownOn(a))?.small?.path], [aPicture, aSmall]);
  is("A's picture named for product B: refused", await attach(b, aPicture), [400, "in_use"]);
  is("and B shows nothing", await shownOn(b), null);
  const bPicture = await upload({ productId: b });
  is("B's own new picture, with A's smaller copy as its copy: put on without the copy", await attach(b, bPicture, { small: { path: aSmall, width: 400 } }), [200, "ok"]);
  is("so B shows no copy", (await shownOn(b))?.small ?? null, null);
  is("B's picture taken off", await result(await productImage(post("/api/store/image", session, { action: "remove", id: b }))), [200, "ok"]);
  is("A's picture and smaller copy are still there", [files.has(aPicture), files.has(aSmall)], [true, true]);
  is("B's own picture is deleted with it", files.has(bPicture), false);
  is("A keeps its own picture, sent again", await attach(a, aPicture, { small: { path: aSmall, width: 400 } }), [200, "ok"]);
  is("and still shows both", [files.has(aPicture), files.has(aSmall), (await shownOn(a))?.small?.path], [true, true, aSmall]);

  part("A link");
  is("A's picture on a link: refused", await linkAttach(linkOne, aPicture), [400, "in_use"]);
  const linkPicture = await upload({ linkId: linkTwo });
  is("a new picture through the door on the other link", await linkAttach(linkTwo, linkPicture), [200, "ok"]);
  is("the link's picture on product B: refused", await attach(b, linkPicture), [400, "in_use"]);
  is("the first link taken off", await result(await links(post("/api/store/links", session, { action: "remove", id: linkOne }))), [200, "ok"]);
  is("A's picture is still there", files.has(aPicture), true);
  is("the other link keeps its own picture, sent again", await linkAttach(linkTwo, linkPicture), [200, "ok"]);
  const linkNext = await upload({ linkId: linkTwo });
  is("and replaces it with a new one", await linkAttach(linkTwo, linkNext), [200, "ok"]);
  is("the replaced picture, its own, is deleted; the new one is kept", [files.has(linkPicture), files.has(linkNext)], [false, true]);

  part("An option");
  const added = await addOption(OWNER, c, "Basic", "19");
  if (!added.ok) throw new Error("option");
  const optionId = (await readListing(added.store, c))!.options[0].id;
  const productFile = `${fileFolder(await storeFolder(OWNER), c)}${"f".repeat(20)}.pdf`;
  files.set(productFile, { bytes: PDF, contentType: "application/pdf" });
  is("product C's file put on", await result(await fileAttach(post("/api/store/file/attach", session, { id: c, pathname: productFile, name: "guide.pdf" }))), [200, "ok"]);
  is("C's file named for its option: refused, it is not in the option's folder", await result(await fileAttach(post("/api/store/file/attach", session, { id: optionId, pathname: productFile, name: "guide.pdf" }))), [400, "invalid"]);
  is("the option removed", await result(await optionRoute(post("/api/store/option", session, { action: "remove", id: optionId }))), [200, "ok"]);
  is("C's file is still there", files.has(productFile), true);

  part("A product's page and a site page");
  is("a product's page with A's picture in a block: refused", await result(await pageRoute(post("/api/store/page", session, { id: b, page: pictures("pics0001", [aPicture]) }))), [400, "pictures"]);
  is("with a link's picture: refused", await result(await pageRoute(post("/api/store/page", session, { id: b, page: pictures("pics0001", [linkNext]) }))), [400, "pictures"]);
  const pagePicture = await upload({ productId: b });
  is("with a new picture through the door: saved", await result(await pageRoute(post("/api/store/page", session, { id: b, page: pictures("pics0001", [pagePicture]) }))), [200, "ok"]);
  is("saved again as it is", await result(await pageRoute(post("/api/store/page", session, { id: b, page: pictures("pics0001", [pagePicture]) }))), [200, "ok"]);
  is("the page's picture on product C: refused", await attach(c, pagePicture), [400, "in_use"]);
  is("the block taken off", await result(await pageRoute(post("/api/store/page", session, { id: b, page: { blocks: [] } }))), [200, "ok"]);
  is("the page's own picture is deleted; A's and the link's are still there", [files.has(pagePicture), files.has(aPicture), files.has(linkNext)], [false, true, true]);
  const listed = await setSitePages(OWNER, [{ id: "pagepage01", slug: "about", title: "About", nav: true, target: "", from: -1 }]);
  if (!listed.ok) throw new Error("site page");
  const save = (paths: string[]) => sitePage(post("/api/store/site-page", session, { action: "save", id: "pagepage01", page: pictures("pics0002", paths) })).then(result);
  is("a site page with A's picture in a block: refused", await save([aPicture]), [400, "pictures"]);
  is("with a link's picture: refused", await save([linkNext]), [400, "pictures"]);
  const siteNew = await upload({ pageId: "pagepage01" });
  is("with a new one and A's together: refused, nothing written", await save([siteNew, aPicture]), [400, "pictures"]);
  is("and the new one alone, tried again, is saved: taken by the save before, it is the page's", await save([siteNew]), [200, "ok"]);
  is("the site page shows it", picturePaths(await readPage(listed.store.statsId!, siteKey("pagepage01"))), [siteNew]);
  is("the site page removed", await result(await sitePage(post("/api/store/site-page", session, { action: "remove", id: "pagepage01" }))), [200, "ok"]);
  is("its own picture is deleted; A's and the link's are still there", [files.has(siteNew), files.has(aPicture), files.has(linkNext)], [false, true, true]);

  part("A product removed");
  is("A's picture on product B, then B removed", await attach(b, aPicture), [400, "in_use"]);
  is("B removed", await result(await productRoute(post("/api/store/product", session, { action: "remove", id: b }))), [200, "ok"]);
  is("A's picture and smaller copy are still there", [files.has(aPicture), files.has(aSmall)], [true, true]);

  part("A product's episodes share the product's folder");
  is("the show made a podcast", await result(await podcast(post("/api/store/podcast", session, { action: "enable", id: show }))), [200, "ok"]);
  const showFolder = fileFolder(await storeFolder(OWNER), show);
  const audio = `${showFolder}${"e".repeat(20)}.mp3`;
  const other = `${showFolder}${"d".repeat(20)}.mp3`;
  files.set(audio, { bytes: MP3, contentType: "audio/mpeg" });
  files.set(other, { bytes: MP3, contentType: "audio/mpeg" });
  is("an episode put out", await result(await podcast(post("/api/store/podcast", session, { action: "add", id: show, pathname: audio, title: "Episode one", notes: "" }))), [200, "ok"]);
  // Since 5 November 2026 the file route names the episode's audio first (tests/picture-owner-followup.test.ts).
  is("the episode's audio as the product's file: refused, it is an episode's audio", await result(await fileAttach(post("/api/store/file/attach", session, { id: show, pathname: audio, name: "audio.mp3" }))), [400, "in_use"]);
  const showOwn = `${showFolder}${"a".repeat(20)}.pdf`;
  files.set(showOwn, { bytes: PDF, contentType: "application/pdf" });
  is("a file of its own on the podcast: refused, a podcast takes no file", await result(await fileAttach(post("/api/store/file/attach", session, { id: show, pathname: showOwn, name: "guide.pdf" }))), [400, "course"]);
  is("the same audio as a second episode: refused", await result(await podcast(post("/api/store/podcast", session, { action: "add", id: show, pathname: audio, title: "Episode two", notes: "" }))), [400, "in_use"]);
  is("a second episode with its own audio", await result(await podcast(post("/api/store/podcast", session, { action: "add", id: show, pathname: other, title: "Episode two", notes: "" }))), [200, "ok"]);
  const listed0 = (await readPodcast((await readListing((await storeForEmail(OWNER))!, show))!.podcast!.id))!;
  is("two episodes", listed0.episodes.length, 2);
  // Two episodes already playing one audio, as could have been written before this rule.
  await savePodcast({ ...listed0, episodes: [...listed0.episodes, { ...listed0.episodes[0], id: "abcdef012345", title: "Episode one again" }] });
  is("the copy removed", await result(await podcast(post("/api/store/podcast", session, { action: "remove", id: show, episode: "abcdef012345" }))), [200, "ok"]);
  is("the audio the first episode still plays is kept", files.has(audio), true);
  is("the second episode removed", await result(await podcast(post("/api/store/podcast", session, { action: "remove", id: show, episode: listed0.episodes[1].id }))), [200, "ok"]);
  is("its own audio is deleted", files.has(other), false);

  part("A buyer's review photo, in the same picture folder");
  const photo = await keepReviewPhoto(OWNER, REVIEW_JPEG);
  if (photo === "photo") throw new Error("review photo");
  is("stored in the store's picture folder", photo.path.startsWith(`images/${folder}/`), true);
  is("on product C: refused", await attach(c, photo.path), [400, "in_use"]);
  is("on a link: refused", await linkAttach(linkTwo, photo.path), [400, "in_use"]);
  is("in a block on a product's page: refused", await result(await pageRoute(post("/api/store/page", session, { id: c, page: pictures("pics0003", [photo.path]) }))), [400, "pictures"]);
  is("the photo is still there", files.has(photo.path), true);

  part("A picture put on before this rule, never noted, stays its record's");
  const old = name();
  files.set(old, { bytes: JPEG, contentType: "image/jpeg" });
  await setProductImage(OWNER, legacy, { path: old, width: 1200, height: 800, alt: "", bytes: JPEG.length, small: null });
  is("still shown", (await shownOn(legacy))?.path, old);
  is("sent again: kept", await attach(legacy, old), [200, "ok"]);
  is("and still there", files.has(old), true);
  const replacement = await upload({ productId: legacy });
  is("replaced by a new one", await attach(legacy, replacement), [200, "ok"]);
  is("the old one, its own, is deleted; the new one shown", [files.has(old), (await shownOn(legacy))?.path], [false, replacement]);

  part("A try that failed half way, then tried again");
  const early = name();
  const askedEarly = await door(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname: early, clientPayload: JSON.stringify({ productId: c }), multipart: false } }));
  is("the door opened", askedEarly.status, 200);
  is("put on before the file store has it: fails on our side", await attach(c, early), [500, "server_error"]);
  files.set(early, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
  is("tried again: refused, the door was spent", await attach(c, early), [400, "in_use"]);
  is("and nothing was deleted", files.has(early), true);
  const another = await upload({ productId: c });
  is("the same picture chosen again from the device (a new upload): put on", await attach(c, another), [200, "ok"]);

  part("A take from the door that cannot be confirmed: refused before anything is written");
  // The file store's Redis failing on the picture door's read and removal (ZSCORE + ZREM), once: before the removal
  // ran, or after it ran with its answer lost. Before 4 November 2026 the failure was swallowed, so a picture could
  // go on a record with its note still on the list, and a later refused request naming it deleted it.
  const unfailed = redis.pipeline;
  const takeFails = async <T>(removalRan: boolean, run: () => Promise<T>): Promise<T> => {
    redis.pipeline = async (commands) => {
      if (commands.some((command) => command[0] === "ZSCORE" && String(command[1]).startsWith("nl:pictures:doors:"))) {
        if (removalRan) await unfailed(commands);
        throw new Error("Redis request failed with status 503");
      }
      return unfailed(commands);
    };
    try {
      return await run();
    } finally {
      redis.pipeline = unfailed;
    }
  };
  const refusedLink = (path: string) => linkImage(post("/api/store/link-image", session, { action: "attach", id: linkTwo, path, width: 0, height: 0 })).then(result);
  const cBefore = (await shownOn(c))?.path;
  const blinked = await upload({ productId: c });
  is("a new picture on product C while the door cannot be read: refused, server_error", await takeFails(false, () => attach(c, blinked)), [500, "server_error"]);
  is("and C still shows what it showed", (await shownOn(c))?.path, cBefore);
  is("tried again once the store answers: put on, the note was still there", await attach(c, blinked), [200, "ok"]);
  is("a refused link request naming it later", await refusedLink(blinked), [400, "invalid"]);
  is("and C's picture is still there", [files.has(blinked), (await shownOn(c))?.path], [true, blinked]);
  is("C's own picture sent again while the door cannot be read: refused, server_error", await takeFails(false, () => attach(c, blinked)), [500, "server_error"]);
  is("and still shown and there", [files.has(blinked), (await shownOn(c))?.path], [true, blinked]);
  const lost = await upload({ productId: c });
  is("the removal ran but its answer was lost: refused, server_error", await takeFails(true, () => attach(c, lost)), [500, "server_error"]);
  is("tried again: refused, the door was spent", await attach(c, lost), [400, "in_use"]);
  is("and the file is kept, C's picture is unchanged", [files.has(lost), (await shownOn(c))?.path], [true, blinked]);
  const linkBlink = await upload({ linkId: linkTwo });
  is("a new picture on a link while the door cannot be read: refused, server_error", await takeFails(false, () => linkAttach(linkTwo, linkBlink)), [500, "server_error"]);
  is("and the link keeps its own", (await storeForEmail(OWNER))!.links.find((link) => link.id === linkTwo)?.image?.path, linkNext);
  const pageBlink = await upload({ productId: c });
  is("a new picture on a product's page while the door cannot be read: refused, server_error", await takeFails(false, async () => result(await pageRoute(post("/api/store/page", session, { id: c, page: pictures("pics0004", [pageBlink]) })))), [500, "server_error"]);
  is("tried again once the store answers: saved", await result(await pageRoute(post("/api/store/page", session, { id: c, page: pictures("pics0004", [pageBlink]) }))), [200, "ok"]);
  is("a refused link request naming the page's picture later", await refusedLink(pageBlink), [400, "invalid"]);
  is("and the page's picture is still there", files.has(pageBlink), true);

  part("What the creator reads");
  const messageOf = (file: string, key: string) => readFileSync(file, "utf8").match(new RegExp(`\\n  ${key}: [\`"]([^\`"]*)[\`"]`))?.[1] ?? "";
  for (const file of ["components/product-image-editor.tsx", "components/link-picture.tsx"]) {
    is(`${file}: the refusal says what to do, and claims nothing it cannot know`, messageOf(file, "in_use"), "That picture could not be used here. Choose it from your device again.");
  }
  is("the page editor says what to do when a picture is not kept", messageOf("components/page-editor.tsx", "pictures").includes("Add the picture again from your device, then save."), true);

  part("A picture taken once is never fresh again");
  is("a door asked for a name already stored is refused", (await door(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname: aPicture, clientPayload: JSON.stringify({ productId: c }), multipart: false } }))).status, 400);
  is("and A's picture on C is still refused", await attach(c, aPicture), [400, "in_use"]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
