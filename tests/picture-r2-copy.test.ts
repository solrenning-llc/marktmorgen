/**
 * 313 [CV1] unit 4b: when the pictures' own R2 bucket is on (lib/picture-r2.ts),
 * a product picture and its smaller copy are copied there as they are attached,
 * and the picture is marked r2 (lib/picture-r2-copy.ts, app/api/store/image/route.ts).
 * Off, as it is today, nothing is read or copied and nothing is marked. A copy
 * that fails leaves the picture as it was, served from where it always was.
 * Nothing serves from R2 yet: addressing marked pictures is unit 4c.
 *
 * What fails here: a read or a copy while off; a picture marked when one of its
 * files did not copy; a picture refused because its copy failed; the mark lost
 * when the picture is read back.
 */
import { readFileSync } from "node:fs";
import { copyAttachedPicture } from "@/lib/picture-r2-copy";
import type { PictureR2Config } from "@/lib/picture-r2";
import { parseProductImage } from "@/lib/product-image";
import { done, is, part } from "./check";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]);
const config: PictureR2Config = { endpoint: "https://acc.r2.cloudflarestorage.com", bucket: "mm-pictures", origin: "https://images.example.com", key: { accessKeyId: "k".repeat(20), secretAccessKey: "s".repeat(40) } };
const put: string[] = [];
let answer = 200;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if ((init?.method ?? "GET") === "PUT") put.push(String(input));
  return new Response("", { status: answer });
}) as typeof fetch;
const folder = "a".repeat(24);
const big = `images/${folder}/${"b".repeat(32)}.jpg`;
const small = `images/${folder}/${"c".repeat(32)}.jpg`;

async function main(): Promise<void> {
  part("Off: nothing read, nothing copied");
  let reads = 0;
  const read = async () => { reads += 1; return JPEG; };
  is("off: not copied, nothing read, nothing sent", [await copyAttachedPicture([big, small], { config: null, read }), reads, put.length], [false, 0, 0]);

  part("On: the picture and its smaller copy are copied, then marked");
  is("both copied", [await copyAttachedPicture([big, small], { config, read }), put.length], [true, 2]);
  answer = 412;
  is("already there (the same fresh name): still a copy", await copyAttachedPicture([big], { config, read }), true);
  answer = 503;
  is("a copy that fails: not marked", await copyAttachedPicture([big, small], { config, read }), false);
  answer = 200;
  is("a file that cannot be read: not marked", await copyAttachedPicture([big], { config, read: async () => { throw new Error("blob down"); } }), false);

  part("The mark is kept with the picture, and only when given");
  const kept = parseProductImage({ path: big, width: 1200, height: 800, alt: "", bytes: 10, small: null, r2: true });
  is("read back with its mark", kept?.r2, true);
  is("no mark when none was given, or when it is not true", [parseProductImage({ path: big, width: 1200, height: 800 })?.r2, parseProductImage({ path: big, width: 1200, height: 800, r2: "yes" })?.r2], [undefined, undefined]);

  part("The attach route copies after its checks and never refuses for a copy");
  const route = readFileSync("app/api/store/image/route.ts", "utf8");
  is("copied after the picture is checked, before it is written, and only marked when copied", /copyAttachedPicture\(imagePaths\(image\)\)\.catch\(\(\) => false\)[\s\S]{0,120}if \(mirrored\) image = \{ \.\.\.image, r2: true \}[\s\S]*setProductImage\(ref, id, image\)/.test(route), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
