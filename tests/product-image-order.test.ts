/**
 * A new picture sent for a product that is not there is refused before it is taken from the picture door
 * (lib/picture-door.ts), so nothing is deleted and the creator can still put it on another product.
 *
 * Proved on main before this fix (Claude 5, 7 November 2026): a product removed in another tab, a new picture sent
 * for it answered 404 and the picture was deleted from the file store; chosen afterwards for another product, the same
 * picture was refused as in_use, because the failed request had already taken it from the door. The link route is
 * fixed the same way in #2657. Each check sends the real route a real request from the creator's own session, with
 * synthetic files in a file store held in memory (tests/failure-cleanup-world.ts).
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, imageFolder, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { files } from "./failure-cleanup-world";
import { done, is, part } from "./check";
import { POST as productImage } from "@/app/api/store/image/route";
import { POST as door } from "@/app/api/store/image/upload/route";
import { POST as productRoute } from "@/app/api/store/product/route";

const OWNER = "image.order@example.com";
const ORIGIN = "https://marktmorgen.com";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

const post = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const result = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, "imageorder", "Image Order", "");
  await ensureStatsId(OWNER);
  const made = await Promise.all(["Guide", "Course"].map((title) => addProduct(OWNER, title, "", "19", null)));
  if (!made.every((m) => m.ok)) throw new Error("setup");
  const [a, b] = made.map((m) => (m.ok ? m.product.id : ""));
  const session = await openSession(OWNER);
  const folder = await imageFolder(OWNER);
  let n = 0;
  const name = () => `images/${folder}/${(++n).toString(16).padStart(32, "0")}.jpg`;
  /** A picture let in through the door, as the studio's editor does it, and stored just after. */
  const upload = async (productId: string) => {
    const pathname = name();
    const asked = await door(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: JSON.stringify({ productId }), multipart: false } }));
    if (asked.status !== 200) throw new Error(`door ${asked.status}`);
    files.set(pathname, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
    return pathname;
  };
  const attach = (id: string, path: string, more: Record<string, unknown> = {}) =>
    productImage(post("/api/store/image", session, { action: "attach", id, path, width: 1200, height: 800, ...more })).then(result);
  const shownOn = async (id: string) => (await readListing((await storeForEmail(OWNER))!, id))?.image ?? null;

  part("A product removed in another tab");
  const picture = await upload(b);
  const small = await upload(b);
  is("product B removed", await result(await productRoute(post("/api/store/product", session, { action: "remove", id: b }))), [200, "ok"]);
  is("the new picture, with its smaller copy, sent for B: refused as unknown", await attach(b, picture, { small: { path: small, width: 400 } }), [404, "unknown"]);
  is("the picture and its smaller copy are still in the file store", [files.has(picture), files.has(small)], [true, true]);
  is("chosen for product A instead: put on", await attach(a, picture, { small: { path: small, width: 400 } }), [200, "ok"]);
  is("A shows both", [(await shownOn(a))?.path, (await shownOn(a))?.small?.path], [picture, small]);

  part("A product that never existed");
  const other = await upload(a);
  is("a new picture sent for an id no product has: refused as unknown", await attach("nosuchproduct", other), [404, "unknown"]);
  is("the picture is still in the file store", files.has(other), true);
  is("chosen for A: put on, and A's previous picture and copy, its own, deleted", await attach(a, other), [200, "ok"]);
  is("the replaced ones are gone, the new one kept", [files.has(picture), files.has(small), files.has(other)], [false, false, true]);

  part("What kept working");
  const late = await upload(a);
  is("a picture that fails a check on a product that is there is still taken and deleted", await attach(a, late, { width: 0 }), [400, "invalid"]);
  is("so it is gone", files.has(late), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
