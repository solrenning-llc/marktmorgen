/**
 * A request that fails never deletes a file the browser named unless that request took it as a fresh upload
 * (4 November 2026, after a review proved a member with only "page" deleting a product's picture).
 *
 * A store's pictures share one folder, and a product's files and its episodes share the product's folder; the
 * routes only check the folder. So a path the browser sends on a failed request may be another record's file.
 * Each check sends the real route a real request from the creator's own session, with synthetic files in a file
 * store held in memory (tests/failure-cleanup-world.ts), and reads what is left:
 *
 *   - a link's picture refused (no size, or no such link) with a product's picture named: the picture stays;
 *   - a product's picture refused (no such product) with another product's picture named: it stays;
 *   - a smaller copy refused (as wide as the picture) that is another product's smaller copy: it stays;
 *   - an episode refused (no title) naming another episode's audio: the audio stays;
 *   - and what is still cleaned: a picture let in through the door for this request, then refused, is deleted;
 *     once put on something it is never taken as fresh again, and a door asked for a picture already stored is
 *     refused, even in the same second the picture was stored;
 *   - each store's list: a stale note is never taken, one store's doors never push out another's, and the list
 *     expires a window after its last note.
 *
 * The inventory at the end reads every deletion in app/api/store, and in the lib files those routes delete through,
 * and holds each to a reason it cannot reach a file the browser named that belongs to another record, so a new
 * one fails here until somebody says which; and each route taking from the door takes before it deletes.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, addStoreLink, claimHandle, ensureStatsId, imageFolder, setProductImage, storeFolder } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { fileFolder } from "@/lib/product-file";
import { store as redis } from "./redis-stub";
import { files } from "./failure-cleanup-world";
import { PICTURE_DOOR_MAX, PICTURE_DOOR_SECONDS, notePictureDoor, takePictureDoor } from "@/lib/picture-door";
import { done, is, part } from "./check";
import { POST as linkImage } from "@/app/api/store/link-image/route";
import { POST as productImage } from "@/app/api/store/image/route";
import { POST as door } from "@/app/api/store/image/upload/route";
import { POST as podcast } from "@/app/api/store/podcast/route";
import { storeForEmail } from "@/lib/store";

const OWNER = "cleanup.maker@example.com";
const ORIGIN = "https://marktmorgen.com";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);

const post = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const result = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string; ok?: boolean }).error ?? "ok"];

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, "cleanupshop", "Cleanup Shop", "");
  await ensureStatsId(OWNER);
  const a = await addProduct(OWNER, "Guide", "", "19", null);
  const b = await addProduct(OWNER, "Course", "", "29", null);
  const added = await addStoreLink(OWNER, "My podcast", "https://example.com/pod");
  if (!a.ok || !b.ok || !added.ok) throw new Error("setup");
  const linkId = added.store.links[0].id;
  const session = await openSession(OWNER);
  const folder = await imageFolder(OWNER);
  const picture = (n: string) => `images/${folder}/${n.repeat(32)}.jpg`;

  // Product A's picture and its smaller copy, already on the product.
  const big = picture("a");
  const small = picture("b");
  files.set(big, { bytes: JPEG, contentType: "image/jpeg" });
  files.set(small, { bytes: JPEG, contentType: "image/jpeg" });
  const placed = await setProductImage(OWNER, a.product.id, { path: big, width: 1200, height: 800, alt: "", bytes: JPEG.length, small: { path: small, width: 400, bytes: JPEG.length } });
  is("product A has its picture and smaller copy", placed.ok && (await readListing((await storeForEmail(OWNER))!, a.product.id))?.image?.small?.path, small);

  part("A link's picture refused never deletes a product's picture");
  is("no size: refused", await result(await linkImage(post("/api/store/link-image", session, { action: "attach", id: linkId, path: big, width: 0, height: 0 }))), [400, "invalid"]);
  is("and product A's picture is still there", files.has(big), true);
  is("no such link: refused", await result(await linkImage(post("/api/store/link-image", session, { action: "attach", id: "nope", path: big, width: 320, height: 180 }))), [404, "unknown"]);
  is("and product A's picture is still there", files.has(big), true);

  part("A product's picture refused never deletes another product's picture");
  is("no such product: refused", await result(await productImage(post("/api/store/image", session, { action: "attach", id: "nope", path: big, width: 1200, height: 800, small: { path: small, width: 400 } }))), [404, "unknown"]);
  is("and product A's picture and smaller copy are still there", [files.has(big), files.has(small)], [true, true]);
  const own = picture("c");
  // Let in through the door, as a new picture must be since 4 November 2026 (tests/picture-owner-paths.test.ts).
  await door(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname: own, clientPayload: JSON.stringify({ productId: b.product.id }), multipart: false } }));
  files.set(own, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
  is("product B's own picture, with A's smaller copy said to be as wide: put on without the copy", await result(await productImage(post("/api/store/image", session, { action: "attach", id: b.product.id, path: own, width: 1200, height: 800, small: { path: small, width: 5000 } }))), [200, "ok"]);
  is("and product A's smaller copy is still there", files.has(small), true);

  part("An episode refused never deletes another episode's audio");
  is("product A made a podcast", await result(await podcast(post("/api/store/podcast", session, { action: "enable", id: a.product.id }))), [200, "ok"]);
  const audio = `${fileFolder(await storeFolder(OWNER), a.product.id)}${"e".repeat(20)}.mp3`;
  files.set(audio, { bytes: MP3, contentType: "audio/mpeg" });
  is("an episode put out", await result(await podcast(post("/api/store/podcast", session, { action: "add", id: a.product.id, pathname: audio, title: "Episode one", notes: "" }))), [200, "ok"]);
  is("the same audio again with no title: refused (another episode's audio)", await result(await podcast(post("/api/store/podcast", session, { action: "add", id: a.product.id, pathname: audio, title: "", notes: "" }))), [400, "in_use"]);
  is("and the episode's audio is still there", files.has(audio), true);

  part("A fresh upload refused is still cleaned, and only while fresh");
  const ask = (pathname: string, payload: Record<string, string>) =>
    door(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: JSON.stringify(payload), multipart: false } }));
  const fresh = picture("d");
  is("the door opened for the link's picture", (await ask(fresh, { linkId })).status, 200);
  files.set(fresh, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
  is("refused for no size", await result(await linkImage(post("/api/store/link-image", session, { action: "attach", id: linkId, path: fresh, width: 0, height: 0 }))), [400, "invalid"]);
  is("and the upload nothing shows is deleted", files.has(fresh), false);
  const lost = picture("f");
  is("the door opened for product B's picture", (await ask(lost, { productId: b.product.id })).status, 200);
  files.set(lost, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
  is("put on a product that is not there: refused", await result(await productImage(post("/api/store/image", session, { action: "attach", id: "nope", path: lost, width: 1200, height: 800 }))), [404, "unknown"]);
  is("and the upload is deleted", files.has(lost), false);
  const kept = picture("1");
  await ask(kept, { productId: b.product.id });
  files.set(kept, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
  is("a fresh picture put on product B", await result(await productImage(post("/api/store/image", session, { action: "attach", id: b.product.id, path: kept, width: 1200, height: 800 }))), [200, "ok"]);
  is("then named on a refused link picture", await result(await linkImage(post("/api/store/link-image", session, { action: "attach", id: linkId, path: kept, width: 0, height: 0 }))), [400, "invalid"]);
  is("and product B's picture is still there: it was taken when put on", files.has(kept), true);
  is("the door asked again for product A's picture, already stored (an upload could never write over it): refused", (await ask(big, { linkId })).status, 400);
  is("then named on a refused link picture", await result(await linkImage(post("/api/store/link-image", session, { action: "attach", id: linkId, path: big, width: 0, height: 0 }))), [400, "invalid"]);
  is("and product A's picture is still there", files.has(big), true);

  part("A door asked again in the same second for a picture just stored never makes it fresh");
  // Early in a second, so the picture stored and the door asked again share it (the review's case: 12:00:00.400 and .900).
  while (Date.now() % 1000 > 300) await new Promise((resolve) => setTimeout(resolve, 5));
  const same = picture("2");
  await ask(same, { productId: b.product.id });
  files.set(same, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
  is("put on product B", await result(await productImage(post("/api/store/image", session, { action: "attach", id: b.product.id, path: same, width: 1200, height: 800 }))), [200, "ok"]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await ask(same, { linkId });
  is("then named on a refused link picture, the same second", await result(await linkImage(post("/api/store/link-image", session, { action: "attach", id: linkId, path: same, width: 0, height: 0 }))), [400, "invalid"]);
  is("and product B's picture is still there", files.has(same), true);

  part("Each store's own list: stale notes are never taken, and one store never pushes out another's");
  const now = Date.now();
  const other = (n: number) => `images/${"9".repeat(24)}/${n.toString(16).padStart(32, "0")}.jpg`;
  const stale = picture("3");
  await notePictureDoor(stale, now - (PICTURE_DOOR_SECONDS + 60) * 1000);
  is("a note older than the window is not taken", [...(await takePictureDoor([stale], now)).keys()], []);
  const mine = picture("4");
  await notePictureDoor(mine, now);
  for (let n = 0; n <= PICTURE_DOOR_MAX; n += 1) await notePictureDoor(other(n), now + 1 + n);
  is("another store's doors, past its own limit, leave this store's note", [...(await takePictureDoor([mine], now + 2_000)).keys()], [mine]);
  is("and that store keeps only its newest", [...(await takePictureDoor([other(0), other(PICTURE_DOOR_MAX)], now + 2_000)).keys()], [other(PICTURE_DOOR_MAX)]);
  const [ttl] = (await redis.pipeline([["TTL", `nl:pictures:doors:${"9".repeat(24)}`]])) as number[];
  is("each list expires a window after its last note", ttl > 0 && ttl <= PICTURE_DOOR_SECONDS, true);

  part("Inventory: every deletion under app/api/store, and why it cannot reach another record's file");
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === "route.ts") routes.push(relative(process.cwd(), path));
    }
  };
  walk("app/api/store");
  // And the deletions in lib that these routes call with a path (the takedown of a link, a review's photo; dropPage
  // and dropReviews hand theirs back to the product route, where they are read below).
  const LIB = ["lib/takedown.ts", "lib/review-photo.ts", "lib/sales-page-store.ts", "lib/reviews.ts"];
  const found: string[] = [];
  for (const file of [...routes.sort(), ...LIB]) {
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    lines.forEach((line, i) => {
      const call = line.match(/\b(del|deleteFile|dropFresh)\(/);
      if (!call || call.index === undefined || /^\s*(\/\/|\*)/.test(line) || /^\s*const dropFresh/.test(line)) return;
      // The argument up to its own closing parenthesis.
      let depth = 1;
      let at = call.index + call[0].length;
      const from = at;
      for (; at < line.length && depth > 0; at += 1) depth += line[at] === "(" ? 1 : line[at] === ")" ? -1 : 0;
      found.push(`${file.replace(/^app\/api\/store\//, "").replace(/\/route\.ts$/, "")} ${call[1]}(${line.slice(from, at - 1).trim()})`);
    });
  }
  // What each deletion is handed, and why that cannot be a file of another record the browser named.
  const REASONS: Record<string, string> = {
    "page del(gone)": "pictures this page held in the page-picture registry, released after the page was written",
    "file/attach del(removed.pathname)": "the file the record held, after the record that replaced it was written, never an episode's audio its podcast still plays (kept when unknown)",
    "site-page del(gone)": "pictures this site page held in the page-picture registry, released after the page was written",
    "podcast del(gone.pathname)": "the audio of the episode the record removed, unless the product's file or another episode still uses it, after it was written",
    "image dropFresh([path, smallPath])": "only the paths this request took from the picture door",
    "image dropFresh([smallPath])": "only the paths this request took from the picture door",
    "image dropFresh(imagePaths(image))": "only the paths this request took from the picture door",
    // A record held the name the browser sent, so these are safe only because attach puts a name on a product or a
    // link only when this request took it fresh from the door or the record shows it already (since 4 November 2026,
    // tests/picture-owner-paths.test.ts): no second record can hold it. A name put on two records before that rule
    // is not found here, and deleting it from one still takes it from the other.
    "image del(replaced)": "the product's own picture and copy that the new one does not use, after the record that replaced it was written; attach admits only a fresh or own name",
    "product del(file.pathname)": "files of a removed product, read from its own records",
    "product del(linked.removed.pathname)": "the file the record held, after the link that replaced it was written",
    "option del(file.pathname)": "files of a removed option, read from its own record",
    "links del(result.removed.path)": "the removed link's own picture, after it was written; link-image attach admits only a fresh or own name",
    "link-image dropFresh(path)": "only a path this request took from the picture door",
    "link-image dropFresh(image.path)": "only a path this request took from the picture door",
    "link-image del(result.removed.path)": "the link's own picture the new one replaced, after the record that replaced it was written; attach admits only a fresh or own name",
    "course del(files)": "handed-in work of a removed assignment, read from its own records",
    "course del(file.pathname)": "lesson files the course no longer holds, after it was written",
    "course/task deleteFile(path, \"site_cleanup\")": "a student's upload taken once through the door (takeTaskUpload)",
    "course/task deleteFile(file.path)": "the same taken upload, when the work could not be kept",
    "course/task deleteFile(done.replaced.path)": "the file the handed-in work held, after it was replaced",
    "lib/takedown.ts del(done.removed.path)": "the own picture of the link the takedown removed, read from the record it wrote; link-image attach admits only a fresh or own name",
    "lib/review-photo.ts del(photo.path)": "a review's photo, read from the review record, or the one this request stored under a fresh name",
  };
  const unexplained = [...new Set(found)].filter((entry) => !Object.hasOwn(REASONS, entry));
  is("every deletion under app/api/store has a reason here", unexplained, []);
  const gone = Object.keys(REASONS).filter((entry) => !found.includes(entry));
  is("and every reason here still names a deletion", gone, []);
  const takers = routes.filter((file) => /ownsImagePath\(/.test(readFileSync(file, "utf8")) && !/\/ai\/|\/upload\//.test(file));
  // A page takes its new pictures from the door inside claimNewPictures (lib/sales-page-store.ts).
  is("every route that puts a picture from the door on a record takes it from the door", takers.filter((file) => !/takePictureDoor\(|claimNewPictures\(/.test(readFileSync(file, "utf8"))), []);
  // In order: taken before any cleanup that deletes, and a page's taken before the page is written.
  const order = takers.filter((file) => {
    const source = readFileSync(file, "utf8");
    const take = source.indexOf("takePictureDoor(");
    const drops = [...source.matchAll(/\bdropFresh\(/g)].map((m) => m.index ?? 0).filter((at) => !/const dropFresh = $/.test(source.slice(Math.max(0, at - 20), at)));
    // A page: its new pictures are taken and claimed together (claimNewPictures) before the page is written.
    const claim = source.indexOf("claimNewPictures(");
    const write = claim === -1 ? -1 : source.indexOf("writePage(", claim);
    return drops.some((at) => at < take) || (claim !== -1 && (write === -1 || source.indexOf("claimPictures(") !== -1)) || (drops.length > 0 && !/const dropFresh = \([^)]*\) => dropTakenPictures\(fresh,/.test(source));
  });
  is("each takes before it deletes or writes, and deletes only through what it took", order, []);
  // A take that cannot be confirmed throws and the route refuses before writing (lib/picture-door.ts): never
  // swallowed, or a picture goes on a record with its note left for a refused request to delete it by.
  const doorSource = readFileSync("lib/picture-door.ts", "utf8");
  const takeBody = doorSource.slice(doorSource.indexOf("export async function takePictureDoor("), doorSource.indexOf("export async function dropTakenPictures("));
  is("a take from the door that cannot be confirmed is not swallowed there", /\bcatch\b/.test(takeBody), false);
  const swallowed = [...takers, "lib/sales-page-store.ts"].filter((file) => /(takePictureDoor|claimNewPictures)\([^;]*?\)\s*\.catch\(/.test(readFileSync(file, "utf8")));
  is("nor by a route or a page that takes from it", swallowed, []);
  is("and the door writes each one down", /notePictureDoor\(pathname\)/.test(readFileSync("app/api/store/image/upload/route.ts", "utf8")), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
