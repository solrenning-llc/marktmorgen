/**
 * A store's pictures count in its space (owner's decision 8, 9 November 2026).
 *
 * Until this unit the pictures kept under images/<folder>/ (a product's, a
 * link's, a page's, a buyer's review photo, an email's picture) were outside
 * every measure of a store's storage (lib/file-store.ts lists only
 * stores/<folder>/), so a store with its space full could keep adding them.
 * Each check sends the real routes real requests from the creator's session,
 * with synthetic files in a file store held in memory
 * (tests/failure-cleanup-world.ts, where `size` stands for a large file), and
 * reads the answer:
 *
 *   - a picture past the store's space is refused before the door signs;
 *   - deleting a product's picture gives its room back, and the door opens;
 *   - a picture deleted where its size is not known is counted until the
 *     listing, every two days at the most, finds it gone, and then not;
 *   - a counter that cannot be read refuses pictures (rule 24), and the next
 *     listing makes it again;
 *   - a buyer's review photo and an email's picture take room too: past the
 *     space the review is saved without the photo, the email's picture is
 *     refused, and nothing is written.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, imageFolder, setProductImage } from "@/lib/store";
import { keepReviewPhoto } from "@/lib/review-photo";
import { checkMailPicture, keepMailPicture } from "@/lib/mail-pictures";
import { SETUP_STORAGE_BYTES } from "@/lib/plan-standing";
import { MAX_IMAGE_BYTES } from "@/lib/product-image";
import { store as redis } from "./redis-stub";
import { files } from "./failure-cleanup-world";
import { done, is, part } from "./check";
import { POST as productImage } from "@/app/api/store/image/route";
import { POST as door } from "@/app/api/store/image/upload/route";

const ORIGIN = "https://marktmorgen.com";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
/** A JPEG that says it is 100 by 100, as the review form and the email editor send one. */
const SMALL_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 100, 0, 100, 3, ...new Array(12).fill(0)]).toString("base64");
// Rule 23 (pre-review of 16edc6a536): a pass of the listing runs every two days at the most (RECONCILE_EVERY_MS).
const PASS_DAYS = 2 * 24 * 60 * 60 * 1000;

const post = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const result = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];

const realNow = Date.now.bind(Date);
let shift = 0;
Date.now = () => realNow() + shift;

let n = 0;
/** A store with no plan yet (its space is SETUP_STORAGE_BYTES), one product, and its creator's session. */
async function shop(owner: string, handle: string) {
  await claimHandle(owner, handle, "Pictures", "");
  await ensureStatsId(owner);
  const made = await addProduct(owner, "Guide", "", "19", null);
  if (!made.ok) throw new Error("setup");
  const folder = await imageFolder(owner);
  const name = () => `images/${folder}/${(++n).toString(16).padStart(32, "0")}.jpg`;
  const session = await openSession(owner);
  const ask = async (productId: string) => {
    const pathname = name();
    return { pathname, answer: await result(await door(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: JSON.stringify({ productId }), multipart: false } }))) };
  };
  return { id: made.product.id, folder, name, session, ask };
}

async function main(): Promise<void> {
  redis.clear();
  files.clear();

  part("A picture past the store's space is refused before the door signs");
  {
    const s = await shop("full.pictures@example.com", "fullpictures");
    files.set(s.name(), { bytes: JPEG, contentType: "image/jpeg", size: SETUP_STORAGE_BYTES - MAX_IMAGE_BYTES + 1 });
    is("a picture that would not fit: refused with the plan's storage sentence", (await s.ask(s.id)).answer, [409, "storage_setup"]);
  }

  part("Deleting a product's picture gives its room back");
  {
    const s = await shop("give.back@example.com", "givebackpics");
    const big = s.name();
    const bigBytes = SETUP_STORAGE_BYTES - MAX_IMAGE_BYTES / 2;
    files.set(big, { bytes: JPEG, contentType: "image/jpeg", size: bigBytes });
    const shown = await setProductImage("give.back@example.com", s.id, { path: big, width: 1200, height: 800, alt: "", bytes: bigBytes, small: null });
    if (!shown.ok) throw new Error("setup");
    is("with the product's picture taking the space: refused", (await s.ask(s.id)).answer, [409, "storage_setup"]);
    is("the product's picture taken off", await result(await productImage(post("/api/store/image", s.session, { action: "remove", id: s.id }))), [200, "ok"]);
    is("and deleted", files.has(big), false);
    const next = await s.ask(s.id);
    is("its room is given back: the door opens", next.answer, [200, "ok"]);
    files.set(next.pathname, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
    is("the new picture put on the product", await result(await productImage(post("/api/store/image", s.session, { action: "attach", id: s.id, path: next.pathname, width: 1200, height: 800 }))), [200, "ok"]);
  }

  part("A listing every two days corrects the counter");
  {
    const s = await shop("reconcile.pictures@example.com", "reconcilepics");
    const old = s.name();
    files.set(old, { bytes: JPEG, contentType: "image/jpeg", size: SETUP_STORAGE_BYTES - MAX_IMAGE_BYTES / 2 });
    is("a store full of pictures: refused", (await s.ask(s.id)).answer, [409, "storage_setup"]);
    // Deleted where its size is not known (a review's photo, a page's block): the counter still holds it.
    files.delete(old);
    is("the same day, the counter still counts the deleted picture: refused", (await s.ask(s.id)).answer, [409, "storage_setup"]);
    shift += PASS_DAYS + 1;
    is("two days later the folder is listed again, and the door opens", (await s.ask(s.id)).answer, [200, "ok"]);
  }

  part("A counter that cannot be read refuses pictures, and the next listing makes it again");
  {
    const s = await shop("unread.pictures@example.com", "unreadpics");
    is("a first picture", (await s.ask(s.id)).answer, [200, "ok"]);
    redis.run(["HSET", `nl:images:space:${s.folder}`, "held", "not a number"]);
    // Rule 23: its own word since the pre-review, no time promised (lib/studio-messages.ts pictures_room_unknown).
    is("the counter unreadable the same day: refused, try again later", (await s.ask(s.id)).answer, [503, "pictures_room_unknown"]);
    shift += PASS_DAYS + 1;
    is("two days later it is made again from the folder, and the door opens", (await s.ask(s.id)).answer, [200, "ok"]);
  }

  part("A buyer's review photo and an email's picture take room too");
  {
    const owner = "review.mail@example.com";
    const s = await shop(owner, "reviewmailpics");
    files.set(s.name(), { bytes: JPEG, contentType: "image/jpeg", size: SETUP_STORAGE_BYTES - 10 });
    const before = files.size;
    const photo = await keepReviewPhoto(owner, SMALL_JPEG, SETUP_STORAGE_BYTES);
    is("a review photo past the space: not kept, said as paused", photo, "paused");
    const checked = checkMailPicture(SMALL_JPEG);
    if (checked === "picture") throw new Error("setup");
    const kept = await keepMailPicture(owner, checked, SETUP_STORAGE_BYTES).then(() => "kept", (error: unknown) => (error instanceof Error ? error.name : "thrown"));
    is("an email's picture past the space: refused", kept, "ImageSpaceRefused");
    is("and nothing was written", files.size, before);
  }

  done();
}

void main();
