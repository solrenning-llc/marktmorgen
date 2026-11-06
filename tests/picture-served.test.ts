/**
 * 313 [CV1] unit 4c: a store's public pages take a product picture copied to the
 * pictures' own R2 bucket (marked r2) from the images' own domain while that
 * bucket is on, and every other picture, or every picture while it is off (as
 * today), from app/api/image as before (lib/picture-served.ts). Only the store's
 * server-rendered components use it; the studio's editors, which also run in the
 * browser, keep imageUrl, so a page never hydrates with another address.
 *
 * What fails here: an unmarked picture, or any picture while off, taken from R2;
 * a marked one not taken from R2 while on; the smaller copy from another place
 * than the picture; search data with a doubled origin; a browser component using it.
 */
import { readFileSync } from "node:fs";
import { absoluteImageUrl, servedImageUrl, servedSrcSet } from "@/lib/picture-served";
import type { PictureR2Config } from "@/lib/picture-r2";
import { done, is, part } from "./check";

const config: PictureR2Config = { endpoint: "https://acc.r2.cloudflarestorage.com", bucket: "mm-pictures", origin: "https://images.example.com", key: { accessKeyId: "k".repeat(20), secretAccessKey: "s".repeat(40) } };
const folder = "a".repeat(24);
const path = `images/${folder}/${"b".repeat(32)}.jpg`;
const small = { path: `images/${folder}/${"c".repeat(32)}.jpg`, width: 600, bytes: 1 };
const picture = { path, width: 1200, small };

part("Off, or not copied: as before");
is("off today (no reviewed ceiling): a marked picture is served as before", servedImageUrl({ path, r2: true }), `/api/image/${folder}/${"b".repeat(32)}.jpg`);
is("on, but not copied: as before", servedImageUrl({ path }, config), `/api/image/${folder}/${"b".repeat(32)}.jpg`);
is("on, but not copied: both copies as before", servedSrcSet(picture, config), `/api/image/${folder}/${"c".repeat(32)}.jpg 600w, /api/image/${folder}/${"b".repeat(32)}.jpg 1200w`);

part("On and copied: from the images' own domain, both copies");
is("the picture", servedImageUrl({ path, r2: true }, config), `https://images.example.com/${path}`);
is("its smaller copy too", servedSrcSet({ ...picture, r2: true }, config), `https://images.example.com/${small.path} 600w, https://images.example.com/${path} 1200w`);
is("search data keeps an address that is already whole", absoluteImageUrl(`https://images.example.com/${path}`, "https://marktmorgen.com"), `https://images.example.com/${path}`);
is("and makes the site's own whole", absoluteImageUrl("/api/image/x.jpg", "https://marktmorgen.com"), "https://marktmorgen.com/api/image/x.jpg");

part("Only server-rendered components use it");
for (const file of ["components/store-product.tsx", "components/store-collections.tsx", "components/more-from.tsx", "app/[handle]/p/[product]/page.tsx"]) {
  const text = readFileSync(file, "utf8");
  is(`${file}: uses it, and is not a browser component`, [text.includes('from "@/lib/picture-served"'), /^"use client"/.test(text)], [true, false]);
}
for (const file of ["components/product-editor.tsx", "components/product-image-editor.tsx", "components/page-editor.tsx", "components/link-picture.tsx"]) {
  is(`${file}: a browser component, keeps imageUrl`, readFileSync(file, "utf8").includes("picture-served"), false);
}
done();
