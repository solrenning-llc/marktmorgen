/**
 * Codex N1 on #2843 (N1-20261119-0430, LOW 3): a picture whose check did not finish is put back on the door once, and
 * the save tried again checks it again only paid for as a studio request (lib/picture-check.ts, pictureChecker). When
 * that payment is refused because the studio's requests are used, the save was answered with the generic
 * server_error, as if something broke on our side. It now says why, with the studio's own words (studio_used, 429),
 * and nothing is loosened: the picture is still not checked, not put on the page, and stays on the door for a later
 * save. A count that cannot be read stays server_error.
 *
 * Each check sends the real route; only the file store is the in-memory one (tests/failure-cleanup-world.ts).
 * Synthetic data only.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, imageFolder, setProductPage, setSitePages, storeForEmail } from "@/lib/store";
import { allowancesUsedStrict } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { calls, failNext, files } from "./failure-cleanup-world";
import { done, is, part } from "./check";
import { POST as door } from "@/app/api/store/image/upload/route";
import { POST as pageRoute } from "@/app/api/store/page/route";
import { POST as sitePage } from "@/app/api/store/site-page/route";

const OWNER = "page.recheck@example.com";
const ORIGIN = "https://marktmorgen.com";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

const post = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const answer = async (response: Response) => {
  const body = (await response.json().catch(() => ({}))) as { error?: string; message?: unknown };
  return { status: response.status, error: body.error ?? "ok", message: typeof body.message === "string" ? body.message : "" };
};

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, "pagerecheck", "Page Recheck", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Guide", "", "19", null);
  if (!made.ok) throw new Error("setup");
  const id = made.product.id;
  if (!(await setProductPage(OWNER, id, true)).ok) throw new Error("setup");
  if (!(await setSitePages(OWNER, [{ id: "pagepage01", slug: "about", title: "About", nav: true, target: "", from: -1 }])).ok) throw new Error("setup");
  const session = await openSession(OWNER);
  const folder = await imageFolder(OWNER);
  const doors = `nl:pictures:doors:${folder}`;
  let n = 0;
  const upload = async (payload: Record<string, string>) => {
    const pathname = `images/${folder}/${(++n).toString(16).padStart(32, "0")}.jpg`;
    const asked = await door(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: JSON.stringify(payload), multipart: false } }));
    if (asked.status !== 200) throw new Error(`door ${asked.status}`);
    files.set(pathname, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
    return pathname;
  };
  const pictures = (block: string, paths: string[]) => ({
    blocks: [{ id: block, kind: "pictures", heading: "", items: paths.map((path) => ({ path, width: 1200, height: 800, alt: "A page", caption: "" })) }],
  });
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  const owner = async (path: string) => (await redis.pipeline([["HGET", `nl:product:pics:${statsId}`, path]]))[0];
  const noted = async (path: string) => (await redis.pipeline([["ZSCORE", doors, path]]))[0];
  /** Leaves the studio's window `left` requests: the save's own, and none for a check made again. */
  const leave = async (left: number) => {
    const [studio] = (await allowancesUsedStrict((await storeForEmail(OWNER))!, ["studio"])) ?? [];
    if (!studio) throw new Error("no studio count");
    const keys = redis.keys().filter((key) => key.startsWith("nl:allow:studio:"));
    if (keys.length !== 1) throw new Error(`studio counters: ${keys.length}`);
    redis.run(["SET", keys[0], String(studio.figure - left)]);
    return keys[0];
  };

  for (const [where, save, payload] of [
    ["a product's page", (paths: string[]) => pageRoute(post("/api/store/page", session, { id, page: pictures("picsre01", paths) })), { productId: id }],
    ["a store page", (paths: string[]) => sitePage(post("/api/store/site-page", session, { action: "save", id: "pagepage01", page: pictures("picsre02", paths) })), { pageId: "pagepage01" }],
  ] as const) {
    part(`On ${where}: a check made again that the studio's requests cannot pay for`);
    const picture = await upload(payload);
    failNext.head.set(picture, 1);
    is("a check that does not finish: the save is answered server_error", (await answer(await save([picture]))).status, 500);
    is("and the picture is put back on the door once", Number.isInteger(Number(await noted(picture))), false);
    const counter = await leave(1);
    calls.head = 0;
    calls.get = 0;
    const refused = await answer(await save([picture]));
    is("[CORRETO] the save tried again with no request left for the check says the studio's requests are used, not server_error", [refused.status, refused.error], [429, "studio_used"]);
    is("[CORRETO] with the studio's own words", refused.message.length > 0, true);
    is("nothing is checked", calls.head + calls.get, 0);
    is("the picture is not the page's", await owner(picture), null);
    is("and it stays on the door, put back once, for a later save", Number.isInteger(Number(await noted(picture))), false);
    redis.run(["DEL", counter]);
    is("with requests again, the next save checks it and puts it on", (await answer(await save([picture]))).status, 200);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
