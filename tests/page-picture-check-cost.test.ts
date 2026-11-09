/**
 * MR, external-cost audit gap 1 (Claude 5, 6 November 2026): saving a product's page or a store page checks each new
 * picture in the file store (lib/picture-check.ts, isStoredPicture: a head, then a get of its first bytes) before the
 * page is written. The checks are paid Blob operations (a head is a Simple Operation the SDK may try eleven times; a
 * get is a read counted whole, as the picture-uploads line counts it), and a save is one studio request.
 *
 * What has to hold, whatever the fix: a picture comes in through the picture door once, so the file store is asked
 * about it a bounded number of times, never once more for every save that names it again. A save that fails after
 * the checks (a picture the door never let in, at the end, so the claim refuses) must not let the same pictures be checked
 * again and again: with MAX_PAGE_PICTURES (24) a save, 2,000 studio requests a month on Creator would be 48,000
 * checks, about US$ 5 a month with the read counted whole, past the owner's US$ 66 for the first year refunded.
 *
 * Each check sends the real route; only the file store is the in-memory one (tests/failure-cleanup-world.ts).
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, addStoreLink, claimHandle, ensureStatsId, imageFolder, setProductImage, setProductPage, setSitePages, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { MAX_PAGE_PICTURES, MAX_PICTURES } from "@/lib/sales-page";
import { store as redis } from "./redis-stub";
import { calls, files, outage } from "./failure-cleanup-world";
import { done, is, part } from "./check";
import { POST as door } from "@/app/api/store/image/upload/route";
import { POST as pageRoute } from "@/app/api/store/page/route";
import { POST as sitePage } from "@/app/api/store/site-page/route";
import { POST as productImage } from "@/app/api/store/image/route";
import { POST as linkImage } from "@/app/api/store/link-image/route";

const OWNER = "page.checks@example.com";
const ORIGIN = "https://marktmorgen.com";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const SAVES = 10;

const post = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const result = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];
const checks = () => calls.head + calls.get;

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, "pagechecks", "Page Checks", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Guide", "", "19", null);
  if (!made.ok) throw new Error("setup");
  const id = made.product.id;
  if (!(await setProductPage(OWNER, id, true)).ok) throw new Error("setup");
  const listed = await setSitePages(OWNER, [{ id: "pagepage01", slug: "about", title: "About", nav: true, target: "", from: -1 }]);
  if (!listed.ok) throw new Error("setup");
  const session = await openSession(OWNER);
  const folder = await imageFolder(OWNER);
  let n = 0;
  /** A picture let in through the door, as the studio's editors do it, and stored just after. */
  const upload = async (payload: Record<string, string>) => {
    const pathname = `images/${folder}/${(++n).toString(16).padStart(32, "0")}.jpg`;
    const asked = await door(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: JSON.stringify(payload), multipart: false } }));
    if (asked.status !== 200) throw new Error(`door ${asked.status}`);
    files.set(pathname, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
    return pathname;
  };
  /** The pictures in blocks of MAX_PICTURES, as the editor sends them: a page holds MAX_PAGE_PICTURES in all. */
  const pictures = (block: string, paths: string[]) => ({
    blocks: Array.from({ length: Math.ceil(paths.length / MAX_PICTURES) }, (_, i) => ({
      id: `${block.slice(0, 7)}${i}`, kind: "pictures", heading: "",
      items: paths.slice(i * MAX_PICTURES, (i + 1) * MAX_PICTURES).map((path) => ({ path, width: 1200, height: 800, alt: "A page", caption: "" })),
    })),
  });
  // A picture in this store's own folder that the door never let in: stored, so it passes the checks, and then the
  // claim refuses it (lib/sales-page-store.ts, claimNewPictures). Last, so every picture before it was checked first.
  const stray = `images/${folder}/${"e".repeat(32)}.jpg`;
  files.set(stray, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });

  part("A product's page");
  const good: string[] = [];
  for (let i = 0; i < MAX_PAGE_PICTURES - 1; i += 1) good.push(await upload({ productId: id }));
  calls.head = 0;
  calls.get = 0;
  const answers: unknown[] = [];
  for (let i = 0; i < SAVES; i += 1) answers.push(await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0001", [...good, stray]) }))));
  is("every save naming a picture the door never let in is refused", answers.every((a) => JSON.stringify(a) === JSON.stringify([400, "pictures"])), true);
  is(`the file store is asked about each picture let in through the door at most once (head and get), not once a save: ${checks()} calls for ${good.length} pictures over ${SAVES} saves`, checks() <= 2 * (good.length + 1), true);

  part("A store page");
  const site: string[] = [];
  for (let i = 0; i < MAX_PAGE_PICTURES - 1; i += 1) site.push(await upload({ pageId: "pagepage01" }));
  calls.head = 0;
  calls.get = 0;
  const siteAnswers: unknown[] = [];
  for (let i = 0; i < SAVES; i += 1) siteAnswers.push(await result(await sitePage(post("/api/store/site-page", session, { action: "save", id: "pagepage01", page: pictures("pics0002", [...site, stray]) }))));
  is("every save naming a picture the door never let in is refused", siteAnswers.every((a) => JSON.stringify(a) === JSON.stringify([400, "pictures"])), true);
  is(`the file store is asked about each picture let in through the door at most once (head and get), not once a save: ${checks()} calls for ${site.length} pictures over ${SAVES} saves`, checks() <= 2 * (site.length + 1), true);

  part("A file the door let in that is not a picture: refused, let go of and deleted, and never put on unchecked later");
  const notPicture = await upload({ productId: id });
  files.set(notPicture, { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]), contentType: "image/jpeg", at: Date.now() + 1 });
  calls.head = 0;
  calls.get = 0;
  is("a page with it: refused", await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0004", [notPicture]) }))), [400, "pictures"]);
  is("checked once: a head and a get", [calls.head, calls.get], [1, 1]);
  is("and deleted, since this save took it from the door and it is nobody else's", files.has(notPicture), false);
  files.set(notPicture, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
  is("the same name sent again, even with a picture there now: refused, it is neither fresh from the door nor this page's", await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0004", [notPicture]) }))), [400, "pictures"]);
  const siteBad = await upload({ pageId: "pagepage01" });
  files.set(siteBad, { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]), contentType: "image/jpeg", at: Date.now() + 1 });
  is("the same on a store page: refused", await result(await sitePage(post("/api/store/site-page", session, { action: "save", id: "pagepage01", page: pictures("pics0005", [siteBad]) }))), [400, "pictures"]);
  is("and deleted", files.has(siteBad), false);

  part("And a page saved as it should be still saves");
  const one = await upload({ productId: id });
  calls.head = 0;
  calls.get = 0;
  is("a page with one new picture through the door: saved", await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0003", [one]) }))), [200, "ok"]);
  is("its picture was checked once: a head and a get", [calls.head, calls.get], [1, 1]);
  is("saved again as it is: nothing new to check", [await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0003", [one]) }))), calls.head + calls.get], [[200, "ok"], 2]);

  // C1-20261107-1550-TODOS-10 (Claude 4 on #2848, 6711058709): a product's or a link's record is written only after its
  // files passed every check, so a name it already shows, sent again and not fresh from the door, is answered from the
  // record: the file store is not asked again. Every read is then of a file the request took from the door, once
  // (tests/plan-cost-registry.ts, the studio-blob line).
  part("A product's own picture and copies, sent again: answered from its record, not read again");
  const shown = async () => (await readListing((await storeForEmail(OWNER))!, id))?.image ?? null;
  const main = await upload({ productId: id });
  const smaller = await upload({ productId: id });
  const thumbnail = await upload({ productId: id });
  const attachBody = { action: "attach", id, path: main, width: 1200, height: 800, alt: "A guide", small: { path: smaller, width: 800 }, thumb: { path: thumbnail, width: 240 } };
  calls.head = 0;
  calls.get = 0;
  is("attached fresh from the door: each of its three files read once", [await result(await productImage(post("/api/store/image", session, attachBody))), calls.get], [[200, "ok"], 3]);
  calls.head = 0;
  calls.get = 0;
  const again: unknown[] = [];
  for (let i = 0; i < SAVES; i += 1) again.push(await result(await productImage(post("/api/store/image", session, attachBody))));
  is("sent again and again: every time accepted", again.every((a) => JSON.stringify(a) === JSON.stringify([200, "ok"])), true);
  is(`and the file store never asked about them again: ${calls.head} heads and ${calls.get} reads over ${SAVES} sends`, [calls.head, calls.get], [0, 0]);
  const kept = await shown();
  is("the record keeps the picture, both copies and their checked sizes", [kept?.path, kept?.bytes, kept?.small?.path, kept?.small?.bytes, kept?.thumb?.path, kept?.thumb?.bytes], [main, JPEG.length, smaller, JPEG.length, thumbnail, JPEG.length]);
  is("a copy that would not fit its place is still left out (a kept thumbnail is not taken as wider than its picture)", await (async () => {
    const answer = await result(await productImage(post("/api/store/image", session, { ...attachBody, thumb: { path: thumbnail, width: 1300 } })));
    return [answer, (await shown())?.thumb ?? null];
  })(), [[200, "ok"], null]);
  // Rule 24: a record whose size cannot be read is not taken as checked, and not read on the browser's say-so either
  // (a read the door did not pay for, repeatable on every send): refused, the record left as it was, nothing deleted.
  if (kept) await setProductImage(OWNER, id, { ...kept, bytes: Number.NaN });
  calls.head = 0;
  calls.get = 0;
  is("a record with no readable size: not taken as checked, refused without a read, the record and its files kept", [await result(await productImage(post("/api/store/image", session, { ...attachBody, small: undefined, thumb: undefined }))), calls.head + calls.get, (await shown())?.path, (await shown())?.bytes, files.has(main)], [[400, "invalid"], 0, main, 0, true]);

  part("A link's picture: its own, sent again, not read again; one neither fresh nor its own refused before any read");
  const linked = await addStoreLink(OWNER, "My podcast", "https://example.com/pod");
  if (!linked.ok) throw new Error("setup");
  const linkId = linked.store.links[0].id;
  const linkPicture = await upload({ linkId });
  const linkBody = (path: string) => ({ action: "attach", id: linkId, path, width: 320, height: 180 });
  calls.head = 0;
  calls.get = 0;
  is("attached fresh from the door: read once", [await result(await linkImage(post("/api/store/link-image", session, linkBody(linkPicture)))), calls.get], [[200, "ok"], 1]);
  calls.head = 0;
  calls.get = 0;
  for (let i = 0; i < SAVES; i += 1) await linkImage(post("/api/store/link-image", session, linkBody(linkPicture)));
  is(`its own picture sent again: the file store never asked again (${calls.head} heads, ${calls.get} reads)`, [calls.head, calls.get], [0, 0]);
  calls.head = 0;
  calls.get = 0;
  is("the product's picture named for the link: refused as another record's, and never read", [await result(await linkImage(post("/api/store/link-image", session, linkBody(main)))), calls.head, calls.get], [[400, "in_use"], 0, 0]);
  // Claude 2 on #2843 (6750890970, MEDIUM): a passing outage of the file store is unknown, never "not a picture". The
  // creator's fresh picture is kept, the save is refused as one to try again (server_error: "Try again in a moment"),
  // and the save tried again checks it and saves, within the one check its note is counted at (tests/plan-cost-registry.ts,
  // pictureCheckBlob: a head with every try, a read, and the clean-up head's share). Only a read that proves a file is
  // not a picture deletes it, and only a file stored after its note (the second check dropTakenPictures makes).
  part("A passing outage of the file store while a page is saved: nothing deleted, refused to try again, and the retry saves");
  const blip = await upload({ productId: id });
  outage.head.add(blip);
  calls.head = 0;
  calls.get = 0;
  is("the head fails once: refused as one to try again", await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0006", [blip]) }))), [500, "server_error"]);
  is("and the creator's fresh picture is kept", files.has(blip), true);
  is("the save tried again: checked and saved", await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0006", [blip]) }))), [200, "ok"]);
  is("asked about within one check in all: the failed head, then a head and a read", [calls.head, calls.get], [2, 1]);
  is("saved again as it is: nothing new to check", [await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0006", [blip]) }))), calls.head + calls.get], [[200, "ok"], 3]);

  const siteBlip = await upload({ pageId: "pagepage01" });
  outage.head.add(siteBlip);
  is("the same on a store page: refused as one to try again", await result(await sitePage(post("/api/store/site-page", session, { action: "save", id: "pagepage01", page: pictures("pics0007", [siteBlip]) }))), [500, "server_error"]);
  is("the picture kept", files.has(siteBlip), true);
  is("and the save tried again saves", await result(await sitePage(post("/api/store/site-page", session, { action: "save", id: "pagepage01", page: pictures("pics0007", [siteBlip]) }))), [200, "ok"]);

  const twice = await upload({ productId: id });
  outage.head.add(twice);
  calls.head = 0;
  calls.get = 0;
  is("an outage on the first try: refused to try again", await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0008", [twice]) }))), [500, "server_error"]);
  outage.head.add(twice);
  is("and again on the second: refused to try again, still kept", [await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0008", [twice]) }))), files.has(twice)], [[500, "server_error"], true]);
  is("a third save: it is not given back twice, so it is refused as never checked, and still kept", [await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0008", [twice]) }))), files.has(twice)], [[400, "pictures"], true]);
  is("two heads in all and no read: within its one check", [calls.head, calls.get], [2, 0]);

  const unread = await upload({ productId: id });
  outage.get.add(unread);
  calls.head = 0;
  calls.get = 0;
  is("the read fails: refused to try again, and kept", [await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0009", [unread]) }))), files.has(unread)], [[500, "server_error"], true]);
  is("its one read spent, it is never read again: a later save is refused as never checked, and it is still kept", [await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0009", [unread]) }))), files.has(unread), calls.head, calls.get], [[400, "pictures"], true, 1, 1]);

  const before = await upload({ productId: id });
  files.set(before, { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]), contentType: "image/jpeg", at: 1 });
  is("a file that is not a picture but was stored before its note: refused", await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0010", [before]) }))), [400, "pictures"]);
  is("and kept: only a file stored after the door noted it is this save's to delete", files.has(before), true);

  // Claude 2 on #2843 (LOW 2): a copy the product already shows whose size its record cannot vouch for (a legacy
  // bytes 0) is left out, unread, as a failing copy is; the picture itself is not refused for it.
  part("A product's own copy with a size its record cannot vouch for: left out, unread, the picture still attached");
  const second = await addProduct(OWNER, "Second guide", "", "19", null);
  if (!second.ok) throw new Error("setup");
  const otherId = second.product.id;
  const ownMain = await upload({ productId: otherId });
  const ownSmall = await upload({ productId: otherId });
  const ownBody = { action: "attach", id: otherId, path: ownMain, width: 1200, height: 800, alt: "A second guide", small: { path: ownSmall, width: 800 } };
  is("attached fresh from the door", await result(await productImage(post("/api/store/image", session, ownBody))), [200, "ok"]);
  const ownImage = (await readListing((await storeForEmail(OWNER))!, otherId))?.image ?? null;
  if (!ownImage?.small) throw new Error("setup");
  await setProductImage(OWNER, otherId, { ...ownImage, small: { ...ownImage.small, bytes: 0 } });
  calls.head = 0;
  calls.get = 0;
  const answered = await result(await productImage(post("/api/store/image", session, ownBody)));
  const after = (await readListing((await storeForEmail(OWNER))!, otherId))?.image ?? null;
  is("sent again: the picture attached, the copy left out, and nothing read", [answered, after?.path, after?.small ?? null, calls.head, calls.get], [[200, "ok"], ownMain, null, 0, 0]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
