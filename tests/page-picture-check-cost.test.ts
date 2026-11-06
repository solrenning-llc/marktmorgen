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
import { addProduct, claimHandle, ensureStatsId, imageFolder, setProductPage, setSitePages } from "@/lib/store";
import { MAX_PAGE_PICTURES, MAX_PICTURES } from "@/lib/sales-page";
import { store as redis } from "./redis-stub";
import { calls, files } from "./failure-cleanup-world";
import { done, is, part } from "./check";
import { POST as door } from "@/app/api/store/image/upload/route";
import { POST as pageRoute } from "@/app/api/store/page/route";
import { POST as sitePage } from "@/app/api/store/site-page/route";

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

  part("And a page saved as it should be still saves");
  const one = await upload({ productId: id });
  calls.head = 0;
  calls.get = 0;
  is("a page with one new picture through the door: saved", await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0003", [one]) }))), [200, "ok"]);
  is("its picture was checked once: a head and a get", [calls.head, calls.get], [1, 1]);
  is("saved again as it is: nothing new to check", [await result(await pageRoute(post("/api/store/page", session, { id, page: pictures("pics0003", [one]) }))), calls.head + calls.get], [[200, "ok"], 2]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
