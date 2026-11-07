/**
 * Encanto 5b-2 (C4-20261106-0700-C5-27, price read in C4-20261106-0830-C5-39): a third, ~240 px copy of a product
 * picture, made at upload in the creator's browser like the smaller copy, so a small picture in a list (56 px wide)
 * is served about its own size. Its conditions:
 *
 *   - (1) checked exactly as the smaller copy is (lib/product-image.ts, parseThumb; app/api/store/image/route.ts:
 *     owned name, fresh from the picture door or the product's own, type sniffed and matching, a fixed byte ceiling,
 *     narrower than the copies above it); a copy that fails is dropped and never written;
 *   - (2) it lives in the store's picture folder, so the storage meter counts it, and it goes with the picture when
 *     the picture is replaced or deleted, or copied to the pictures' own bucket (imagePaths);
 *   - (3) its cost is written down: every thumbnail upload needs its own studio request (studioAccess, counted against
 *     the plan's studio figure, a hard ceiling a month), so the line `picture-thumbnails` in tests/plan-cost-registry.ts
 *     counts its Blob operations at that ceiling, from the official price (vercel.com, read 6 Nov 2026);
 *   - (4) pictures from before have none and are served as they were.
 */
import { readFileSync } from "node:fs";
import { MAX_THUMB_BYTES, THUMB_LONG_SIDE, SMALL_LONG_SIDE, imagePaths, imageSrcSet, parseProductImage } from "@/lib/product-image";
import { servedSrcSet } from "@/lib/picture-served";
import { COST_LINES } from "./plan-cost-registry";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { done, is, part } from "./check";

const folder = "images/aaaaaaaaaaaaaaaaaaaaaaaa";
const full = { path: `${folder}/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp`, width: 1200, height: 675, alt: "", bytes: 1 };
const small = { path: `${folder}/cccccccccccccccccccccccccccccccc.webp`, width: 800, bytes: 1 };
const thumb = { path: `${folder}/dddddddddddddddddddddddddddddddd.webp`, width: 240, bytes: 9000 };

part("The copy's size");
is("about 240 px on its long side, well under the smaller copy", [THUMB_LONG_SIDE, THUMB_LONG_SIDE < SMALL_LONG_SIDE], [240, true]);
is("a fixed byte ceiling far under a picture's", MAX_THUMB_BYTES, 40_000);

part("Read back only in its exact shape");
is("kept beside the smaller copy", parseProductImage({ ...full, small, thumb })?.thumb, thumb);
is("kept without a smaller copy", parseProductImage({ ...full, small: null, thumb })?.thumb, thumb);
is("dropped when not narrower than the smaller copy", parseProductImage({ ...full, small, thumb: { ...thumb, width: 800 } })?.thumb ?? null, null);
is("dropped from another folder", parseProductImage({ ...full, small, thumb: { ...thumb, path: "images/eeeeeeeeeeeeeeeeeeeeeeee/dddddddddddddddddddddddddddddddd.webp" } })?.thumb ?? null, null);
is("dropped when it is the picture itself", parseProductImage({ ...full, small, thumb: { ...thumb, path: full.path } })?.thumb ?? null, null);
is("dropped over the byte ceiling", parseProductImage({ ...full, small, thumb: { ...thumb, bytes: MAX_THUMB_BYTES + 1 } })?.thumb ?? null, null);
is("a picture from before has none", parseProductImage({ ...full, small })?.thumb ?? null, null);

part("Goes with the picture: replaced, deleted, copied together");
is("every file of the picture", imagePaths(parseProductImage({ ...full, small, thumb })), [full.path, small.path, thumb.path]);

part("Offered to the browser by its width");
is("the copies narrowest first", servedSrcSet(parseProductImage({ ...full, small, thumb })!, null), `/api/image/aaaaaaaaaaaaaaaaaaaaaaaa/dddddddddddddddddddddddddddddddd.webp 240w, /api/image/aaaaaaaaaaaaaaaaaaaaaaaa/cccccccccccccccccccccccccccccccc.webp 800w, /api/image/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp 1200w`);
is("the studio's own set too", imageSrcSet(parseProductImage({ ...full, small, thumb })!)?.startsWith("/api/image/aaaaaaaaaaaaaaaaaaaaaaaa/dddddddddddddddddddddddddddddddd.webp 240w, "), true);
is("a picture from before is offered as it was", servedSrcSet(parseProductImage({ ...full, small })!, null), `/api/image/aaaaaaaaaaaaaaaaaaaaaaaa/cccccccccccccccccccccccccccccccc.webp 800w, /api/image/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp 1200w`);

part("Made in the creator's browser, sent with the picture, checked like the smaller copy");
const editor = readFileSync("components/product-image-editor.tsx", "utf8");
is("the editor shrinks a third copy at the thumbnail size and byte ceiling", /shrink\(file, THUMB_LONG_SIDE, MAX_THUMB_BYTES\)/.test(editor), true);
is("and sends it with the picture", /\.\.\.\(thumb \? \{ thumb \} : \{\}\)/.test(editor), true);
const route = readFileSync("app/api/store/image/route.ts", "utf8");
is("the route takes it from the picture door with the others", /takePictureDoor\(\[path, \.\.\.\(smallOwned \? \[smallPath\] : \[\]\), \.\.\.\(thumbOwned \? \[thumbPath\] : \[\]\)\]\)/.test(route), true);
is("and checks its size, type and width as the smaller copy's", /copy\.size <= MAX_THUMB_BYTES/.test(route) && /thumbWidth < \(small \? small\.width : width\)/.test(route), true);

part("Its cost, at the plan's studio ceiling, from the official price");
const line = COST_LINES.find((each) => each.id === "picture-thumbnails");
is("a line for the thumbnail copy's Blob operations", Boolean(line), true);
for (const tier of ["creator", "pro", "scale"] as const) {
  // Its put with every try again the Blob SDK may send, 1 + 10 (Revisor 1 on #2803, rule 30); its two heads (the name,
  // then the thumbnail) tried as often; its one read, a plain fetch, once (Codex S on #2801). Unknown is never zero.
  // Its own upload request also asks the Blob for a signed token (issueSignedToken, requestApi, tried as often), priced
  // at the dearer operation since no official page names its class; its read also pays Fast Origin Transfer on its
  // bytes and one CDN request, as PICTURE_READ does (Claude 1 on #2801, 6708233552, finding 1).
  const perRequest = 11 * (5 / 1e6) + 11 * (5 / 1e6) + (2 * 11 + 1) * (0.4 / 1e6) + 40_000 * (0.1 / 1e9 + 0.06 / 1e9) + 2 / 1e6;
  is(`${tier}: the plan's studio figure, each at the dearest request it may be`, Math.abs((line?.monthlyUsd(tier) ?? 0) - STORE_ALLOWANCES[tier].studio * perRequest) < 1e-9, true);
}
is("its source and date are said", /vercel\.com\/docs\/vercel-blob\/usage-and-pricing/.test(line?.basis ?? "") && /6 November 2026/.test(line?.basis ?? ""), true);
is("the signing request is named among its sources", line?.sources.some((each) => each.file === "app/api/store/image/upload/route.ts" && each.names.includes("issueSignedToken")) ?? false, true);

part("Its size is checked before its bytes are read, so the read is at most MAX_THUMB_BYTES (Claude 1 on #2801, finding 2)");
// The upload token for any picture name allows MAX_IMAGE_BYTES, so a file sent under the thumbnail's name may be far
// larger than MAX_THUMB_BYTES; the line counts one read of MAX_THUMB_BYTES, true only when no larger file is ever read.
const thumbBlock = route.slice(route.indexOf("const copy = await head(thumbPath)"), route.indexOf("firstBytes(thumbPath)"));
is("between the thumbnail's head and its read, its size is checked against MAX_THUMB_BYTES", route.includes("const copy = await head(thumbPath)") && /copy\.size <= MAX_THUMB_BYTES/.test(thumbBlock), true);
// Rule 30: the smaller copy's read waits on its own size check the same way.
const smallBlock = route.slice(route.indexOf("const copy = await head(smallPath)"), route.indexOf("firstBytes(smallPath)"));
is("the smaller copy's size is checked before its bytes are read too", route.includes("const copy = await head(smallPath)") && /copy\.size <= MAX_IMAGE_BYTES/.test(smallBlock), true);

part("A picture with only a thumbnail is offered at the size of its place (Claude 1 on #2801, finding 3)");
// Without sizes the browser takes 100vw and never picks the 240w copy in a 56 px row.
const storeProduct = readFileSync("components/store-product.tsx", "utf8");
is("the store's product picture gives sizes whenever there is a smaller copy, not only the 800 px one", !/sizes=\{image\.small \?/.test(storeProduct) && /sizes=\{smallerCopies\(image\)\.length \?/.test(storeProduct), true);

done();
