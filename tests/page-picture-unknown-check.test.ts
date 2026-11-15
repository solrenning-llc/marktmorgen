/**
 * Claude 2's review of #2843 at b25d768db (6750890970, MEDIUM): a page save checks each picture it takes from the
 * picture door once (lib/picture-check.ts), but any failure of that check, a Blob timeout or a 5xx as much as a file
 * that is not a picture, was read as "not a picture": the creator's fresh upload was deleted, its note was gone, and
 * every save tried again was refused for good. An unknown check must keep the file and leave the picture checkable by a
 * later save, a bounded number of times, each later check paid for as a studio request so the studio-blob line holds;
 * only a file that really is not a picture is deleted.
 *
 * The real door, page routes and Redis stub; only the file store is the in-memory one (tests/failure-cleanup-world.ts).
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, imageFolder, setProductPage, setSitePages, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { calls, failNext, files } from "./failure-cleanup-world";
import { done, is, part } from "./check";
import { POST as door } from "@/app/api/store/image/upload/route";
import { POST as pageRoute } from "@/app/api/store/page/route";
import { POST as sitePage } from "@/app/api/store/site-page/route";

const OWNER = "page.unknown@example.com";
const ORIGIN = "https://marktmorgen.com";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

const post = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const result = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, "pageunknown", "Page Unknown", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Guide", "", "19", null);
  if (!made.ok) throw new Error("setup");
  const id = made.product.id;
  if (!(await setProductPage(OWNER, id, true)).ok) throw new Error("setup");
  if (!(await setSitePages(OWNER, [{ id: "pagepage01", slug: "about", title: "About", nav: true, target: "", from: -1 }])).ok) throw new Error("setup");
  const session = await openSession(OWNER);
  const folder = await imageFolder(OWNER);
  let n = 0;
  const upload = async (payload: Record<string, string>, bytes = JPEG) => {
    const pathname = `images/${folder}/${(++n).toString(16).padStart(32, "0")}.jpg`;
    const asked = await door(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: JSON.stringify(payload), multipart: false } }));
    if (asked.status !== 200) throw new Error(`door ${asked.status}`);
    files.set(pathname, { bytes, contentType: "image/jpeg", at: Date.now() + 1 });
    return pathname;
  };
  const page = (paths: string[]) => ({ blocks: [{ id: "pics0001", kind: "pictures", heading: "", items: paths.map((path) => ({ path, width: 1200, height: 800, alt: "A page", caption: "" })) }] });
  const saveProduct = async (paths: string[]) => result(await pageRoute(post("/api/store/page", session, { id, page: page(paths) })));
  const saveSite = async (paths: string[]) => result(await sitePage(post("/api/store/site-page", session, { action: "save", id: "pagepage01", page: page(paths) })));
  const studioUsed = async () => (await allowanceUsed((await storeForEmail(OWNER))!, "studio")) ?? -1;

  for (const [where, save] of [["a product's page", saveProduct], ["a store page", saveSite]] as const) {
    part(`${where}: the check's head meets a passing Blob error`);
    const fresh = await upload({ productId: id });
    failNext.head.set(fresh, 1);
    const first = await save([fresh]);
    is(`${where}: the save is refused as not known, never as "not a picture"`, first, [500, "server_error"]);
    is(`${where}: and the creator's fresh picture is kept`, files.has(fresh), true);
    const usedBefore = await studioUsed();
    const second = await save([fresh]);
    is(`${where}: Blob healthy again, the save tried again goes through`, second, [200, "ok"]);
    is(`${where}: the check made again is paid as one more studio request`, (await studioUsed()) - usedBefore, 2);

    part(`${where}: the check's read meets a passing Blob error, twice`);
    const twice = await upload({ productId: id });
    failNext.get.set(twice, 2);
    is(`${where}: refused as not known`, await save([twice]), [500, "server_error"]);
    is(`${where}: refused as not known again, the second check too`, await save([twice]), [500, "server_error"]);
    is(`${where}: the file is still kept`, files.has(twice), true);
    calls.head = 0;
    calls.get = 0;
    is(`${where}: a third save: refused, and the file store is not asked again (each picture checked at most twice)`, [await save([twice]), calls.head + calls.get], [[400, "pictures"], 0]);
    is(`${where}: and still nothing deleted`, files.has(twice), true);

    part(`${where}: a file that is not a picture is still deleted, as before`);
    const fake = await upload({ productId: id }, new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    is(`${where}: refused as not a picture`, await save([fake]), [400, "pictures"]);
    is(`${where}: and deleted`, files.has(fake), false);
  }
  done();
}

void main();
