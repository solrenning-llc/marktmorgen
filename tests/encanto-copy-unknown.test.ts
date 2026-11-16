/**
 * A product picture's smaller copy and thumbnail (Encanto 5b-2, #2801) whose check meets an unknown are kept, never
 * deleted: a passing outage of the file store (a head or a read that throws, or a read that answers without the file)
 * proves nothing about the copy, so the picture is attached without it and the copy stays where it is. Only a copy the
 * store proves is not one (too big, too wide, or its own bytes not a JPEG's or a WebP's the store agrees with) is
 * deleted, and only when this request took it from the picture door. The same for the picture itself: a read that
 * answers without the file refuses the attach and deletes nothing (the pattern of lib/picture-check.ts in #2843, Claude
 * 2's MEDIUM 6750890970). The real route, sign-in, picture door and catalog; the file store in memory
 * (tests/encanto-copy-unknown-world.ts).
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, imageFolder, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { notePictureDoor } from "@/lib/picture-door";
import { MAX_THUMB_BYTES } from "@/lib/product-image";
import { POST } from "@/app/api/store/image/route";
import { deleted, failing, files } from "./encanto-copy-unknown-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const NOT_A_PICTURE = new TextEncoder().encode("<html>not a picture at all</html>");

type Copy = "main" | "small" | "thumb";
type Case = {
  name: string;
  fail?: [Copy, "head" | "get" | "get-status"];
  bytes?: Partial<Record<Copy, Uint8Array>>;
  status: number;
  smallOn: boolean;
  thumbOn: boolean;
  kept: Copy[];
  gone: Copy[];
};

async function main() {
  redis.clear();
  files.clear();
  const owner = "copy.unknown@example.com";
  await claimHandle(owner, "copyunknown", "Copy Unknown", "");
  await ensureStatsId(owner);
  const session = await openSession(owner);
  const folder = await imageFolder(owner);
  const big = new Uint8Array(MAX_THUMB_BYTES + 1);
  big.set(JPEG);
  const all: Copy[] = ["main", "small", "thumb"];
  const cases: Case[] = [
    // A passing outage on a copy: attached without it, and the copy kept.
    { name: "the smaller copy's head throws", fail: ["small", "head"], status: 200, smallOn: false, thumbOn: true, kept: all, gone: [] },
    { name: "the smaller copy's read throws", fail: ["small", "get"], status: 200, smallOn: false, thumbOn: true, kept: all, gone: [] },
    { name: "the smaller copy's read answers without the file", fail: ["small", "get-status"], status: 200, smallOn: false, thumbOn: true, kept: all, gone: [] },
    { name: "the thumbnail's head throws", fail: ["thumb", "head"], status: 200, smallOn: true, thumbOn: false, kept: all, gone: [] },
    { name: "the thumbnail's read throws", fail: ["thumb", "get"], status: 200, smallOn: true, thumbOn: false, kept: all, gone: [] },
    { name: "the thumbnail's read answers without the file", fail: ["thumb", "get-status"], status: 200, smallOn: true, thumbOn: false, kept: all, gone: [] },
    // The picture itself: refused, as a server error to try again, and nothing deleted.
    { name: "the picture's read answers without the file", fail: ["main", "get-status"], status: 500, smallOn: false, thumbOn: false, kept: all, gone: [] },
    // Controls: what the store proves is not a copy we keep is still deleted; a good one is still attached.
    { name: "control: the smaller copy is not a picture", bytes: { small: NOT_A_PICTURE }, status: 200, smallOn: false, thumbOn: true, kept: ["main", "thumb"], gone: ["small"] },
    { name: "control: the thumbnail is over MAX_THUMB_BYTES", bytes: { thumb: big }, status: 200, smallOn: true, thumbOn: false, kept: ["main", "small"], gone: ["thumb"] },
    { name: "control: all three are good", status: 200, smallOn: true, thumbOn: true, kept: all, gone: [] },
  ];

  part("A copy whose check meets an unknown is kept, never deleted (#2801, the #2843 pattern)");
  let n = 0;
  for (const c of cases) {
    failing.clear();
    deleted.length = 0;
    const made = await addProduct(owner, "Synthetic copy " + n, "", "19", null);
    if (!made.ok) throw new Error("fixture: " + made.reason);
    const name = () => `images/${folder}/${(++n).toString(16).padStart(32, "0")}.jpg`;
    const paths: Record<Copy, string> = { main: name(), small: name(), thumb: name() };
    for (const copy of all) {
      await notePictureDoor(paths[copy]);
      // Stored after the door noted it, as an upload is: the door's clean-up would delete it.
      files.set(paths[copy], { bytes: c.bytes?.[copy] ?? JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
    }
    if (c.fail) failing.set(paths[c.fail[0]], c.fail[1]);
    const request = new NextRequest("https://marktmorgen.com/api/store/image", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify({ action: "attach", id: made.product.id, path: paths.main, width: 1600, height: 1200, alt: "Synthetic cover", small: { path: paths.small, width: 800 }, thumb: { path: paths.thumb, width: 240 } }),
    });
    const response = await POST(request);
    const image = (await readListing((await storeForEmail(owner))!, made.product.id))?.image;
    is(`${c.name}: answers ${c.status}`, response.status, c.status);
    is(`${c.name}: the picture is attached only when it was checked`, image?.path === paths.main, c.status === 200);
    is(`${c.name}: the smaller copy is on it only when it was checked`, image?.small?.path === paths.small, c.smallOn);
    is(`${c.name}: the thumbnail is on it only when it was checked`, image?.thumb?.path === paths.thumb, c.thumbOn);
    is(`${c.name}: kept`, c.kept.filter((copy) => !files.has(paths[copy])), []);
    is(`${c.name}: deleted, only what the store proved is not a copy`, all.filter((copy) => deleted.includes(paths[copy])), c.gone);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
