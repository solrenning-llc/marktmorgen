/**
 * The four LOWs left open on #2801 (Codex N1 6889205223, held by Codex X6 since; Claude 3 6911524454), synthetic only:
 *
 *   1. a thumbnail copy refused after its check is cleaned with no second head: the cleanup takes the age the
 *      request already read (dropTakenPictures' `known`), so the attaching request asks the file store about it once,
 *      as the line picture-thumbnails prices;
 *   2. the copy to the pictures' own bucket reads and writes at most PICTURE_R2_FILES_PER_ATTACH files, the picture,
 *      its smaller copy and its thumbnail, and refuses more;
 *   3. what the storage meter counts: filesHeld lists `stores/` only, so the thumbnail in `images/` is not in it, and
 *      encanto-thumbs no longer says it is;
 *   4. a link picture whose read fails as an outage says "could not be checked just now, try again", keeps the file,
 *      and is not a bare server error; the door's note was taken, so the creator chooses it again.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, addStoreLink, claimHandle, ensureStatsId, imageFolder } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { files, heads, deleted, unreadable } from "./failure-cleanup-world";
import * as r2copy from "@/lib/picture-r2-copy";
import { done, is, part } from "./check";
import { POST as linkImage } from "@/app/api/store/link-image/route";
import { POST as productImage } from "@/app/api/store/image/route";
import { POST as door } from "@/app/api/store/image/upload/route";

const OWNER = "thumb.leves@example.com";
const ORIGIN = "https://marktmorgen.com";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

const post = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const result = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string; ok?: boolean }).error ?? "ok"];

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, "thumbleves", "Thumb Leves", "");
  await ensureStatsId(OWNER);
  const product = await addProduct(OWNER, "Guide", "", "19", null);
  const added = await addStoreLink(OWNER, "My podcast", "https://example.com/pod");
  if (!product.ok || !added.ok) throw new Error("setup");
  const linkId = added.store.links[0].id;
  const session = await openSession(OWNER);
  const folder = await imageFolder(OWNER);
  const picture = (n: string) => `images/${folder}/${n.repeat(32)}.jpg`;
  const ask = (pathname: string, payload: Record<string, string>) =>
    door(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: JSON.stringify(payload), multipart: false } }));
  const fresh = async (pathname: string, payload: Record<string, string>, bytes: Uint8Array, contentType: string) => {
    await ask(pathname, payload);
    files.set(pathname, { bytes, contentType, at: Date.now() + 1 });
  };

  part("1. A thumbnail refused after its check is cleaned with no second head");
  const big = picture("a");
  const small = picture("b");
  const thumb = picture("c");
  await fresh(big, { productId: product.product.id }, JPEG, "image/jpeg");
  await fresh(small, { productId: product.product.id }, JPEG, "image/jpeg");
  // Said to be a JPEG, its bytes are not: refused by its own check, and fresh from the door, so it is deleted.
  await fresh(thumb, { productId: product.product.id }, MP3, "image/jpeg");
  heads.clear();
  const attached = await result(await productImage(post("/api/store/image", session, {
    action: "attach", id: product.product.id, path: big, width: 1200, height: 800, small: { path: small, width: 800 }, thumb: { path: thumb, width: 240 },
  })));
  is("the picture is put on without the refused thumbnail", attached, [200, "ok"]);
  is("the refused thumbnail is deleted", [files.has(thumb), deleted.includes(thumb)], [false, true]);
  is("and the attaching request asked the file store about it once, as picture-thumbnails prices", heads.get(thumb) ?? 0, 1);

  part("2. The copy to the pictures' own bucket: at most the picture, its smaller copy and its thumbnail");
  const reads: string[] = [];
  const read = async (path: string) => (reads.push(path), JPEG);
  const { copyAttachedPicture } = r2copy;
  is("three files is the most an attached picture has", (r2copy as Record<string, unknown>).PICTURE_R2_FILES_PER_ATTACH, 3);
  is("off: nothing read", [await copyAttachedPicture([big, small, thumb], { config: null, read }), reads.length], [false, 0]);
  const config = { endpoint: "https://r2.test", bucket: "pictures", origin: "https://images.test", key: { id: "k", secret: "s" } };
  is(
    "more files than a picture has: refused before anything is read",
    [await copyAttachedPicture([big, small, thumb, picture("d")], { config, read }), reads.length],
    [false, 0],
  );

  part("3. What the storage meter counts");
  const meter = readFileSync("lib/file-store.ts", "utf8");
  is("filesHeld lists the store's files folder only", /prefix: `stores\/\$\{folder\}\/`/.test(meter) && !/prefix: `images\//.test(meter), true);
  const claim = readFileSync("tests/encanto-thumbs.test.ts", "utf8");
  is("encanto-thumbs no longer says the storage meter counts the thumbnail", /so the storage meter counts it/.test(claim), false);

  part("4. A link picture whose read fails as an outage");
  const linked = picture("e");
  await fresh(linked, { linkId }, JPEG, "image/jpeg");
  unreadable.add(linked);
  is(
    "says it could not be checked just now, not a bare server error",
    await result(await linkImage(post("/api/store/link-image", session, { action: "attach", id: linkId, path: linked, width: 320, height: 180 }))),
    [503, "check_unavailable"],
  );
  is("and the file is kept: unknown is never \"not a picture\"", files.has(linked), true);
  const words = readFileSync("components/link-picture.tsx", "utf8");
  is(
    "the link's picture form says it in plain words",
    /check_unavailable: "That picture could not be checked just now, so nothing was saved\. Choose it from your device again in a moment\."/.test(words),
    true,
  );
  unreadable.clear();
  const again = picture("f");
  await fresh(again, { linkId }, JPEG, "image/jpeg");
  is("chosen again once the store answers, it is put on", await result(await linkImage(post("/api/store/link-image", session, { action: "attach", id: linkId, path: again, width: 320, height: 180 }))), [200, "ok"]);

  done();
}

void main();
