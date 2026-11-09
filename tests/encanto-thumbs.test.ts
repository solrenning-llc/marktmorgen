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
 *   - (3) its cost is written down: every thumbnail upload is its own studio request through the pictures' upload
 *     route (studioAccess, counted against the plan's studio figure, a hard ceiling a month), which the line
 *     `picture-uploads` already prices at the dearest upload request; the line `picture-thumbnails` in
 *     tests/plan-cost-registry.ts counts what it adds to the attaching request, at that ceiling, from the official price
 *     (vercel.com, read 6 Nov 2026);
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
const uploads = COST_LINES.find((each) => each.id === "picture-uploads");
is("a line for the thumbnail copy's Blob operations", Boolean(line), true);
// Its own upload request is the pictures' upload route, the same request as the picture's and the smaller copy's, so
// the line picture-uploads, which prices every studio request at the dearest upload request plus the attaching one,
// already counts it (Claude 5, #2801 over #2803's eacb4edaa: the first year given back passed the owner's US$ 66).
is("the thumbnail is sent through the pictures' own upload route, as the other copies are", (editor.match(/handleUploadUrl: "\/api\/store\/image\/upload"/g) ?? []).length >= 3 && /shrink\(file, THUMB_LONG_SIDE, MAX_THUMB_BYTES\);\s*const thumbPath = [^;]+;\s*await uploadPresigned\(thumbPath, copy\.blob, \{\s*access: "private",\s*handleUploadUrl: "\/api\/store\/image\/upload"/.test(editor), true);
for (const tier of ["creator", "pro", "scale"] as const) {
  // An upload request at its dearest: its put and its signed token, each with every try again the SDK may send
  // (1 + 10), at the dearer Advanced Operation, and the head that checks its name is free, tried as often.
  const uploadRequest = 11 * (5 / 1e6) + 11 * (5 / 1e6) + 11 * (0.4 / 1e6);
  is(`${tier}: picture-uploads prices every studio request at no less than the dearest upload request, the thumbnail's included`, (uploads?.monthlyUsd(tier) ?? 0) >= STORE_ALLOWANCES[tier].studio * uploadRequest, true);
  // Rule 23 (#2801 over #2803's eacb4edaa, the first year given back at US$ 66.12 over the owner's US$ 66): the line was
  // the thumbnail's whole upload request (put, signed token and the head of its name, 11 tries each, already priced by
  // picture-uploads) plus what it adds when attached; it is now only what it adds to the attaching request: its head,
  // tried as often (Revisor 1 on #2803, rule 30), its one read, a plain fetch, once (Codex S on #2801), Fast Origin
  // Transfer on its bytes and one CDN request, as PICTURE_READ does (Claude 1 on #2801, 6708233552, finding 1).
  const perRequest = 11 * (0.4 / 1e6) + 0.4 / 1e6 + 40_000 * (0.1 / 1e9 + 0.06 / 1e9) + 2 / 1e6;
  is(`${tier}: the plan's studio figure, each attaching request with the thumbnail's head and read at its dearest`, Math.abs((line?.monthlyUsd(tier) ?? 0) - STORE_ALLOWANCES[tier].studio * perRequest) < 1e-9, true);
}
// Rule 23 (#2801, CodeQL "Missing regular expression anchor"): the source was an unanchored pattern, which a longer
// address holding it would also pass; it is now a whole word of the basis, the page's exact address, and the date as text.
is("its source and date are said", (line?.basis ?? "").split(/[\s,]+/).includes("vercel.com/docs/vercel-blob/usage-and-pricing") && (line?.basis ?? "").includes("read on 6 November 2026"), true);
// Rule 23 (#2801 over #2803's eacb4edaa): the signing request is now counted once, by picture-uploads, which prices the
// thumbnail's upload request with the others; the thumbnail's line names that line's route and the attaching request's.
is("the signing request is named among the sources of the line that counts it", uploads?.sources.some((each) => each.file === "app/api/store/image/upload/route.ts" && each.names.includes("issueSignedToken")) ?? false, true);
is("the thumbnail's line names the attaching request it adds to", line?.sources.some((each) => each.file === "app/api/store/image/route.ts" && each.names.includes("head(thumbPath)") && each.names.includes("firstBytes(thumbPath)")) ?? false, true);
// One typed CDN price only: the line reads the visit model's CDN_PER_REQUEST (tests/traffic-cost.ts), so a later move
// of that price to the dearest region moves this line with it (Claude 4 on #2801, 6711058322, finding 2).
const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
const thumbStart = registry.indexOf('id: "picture-thumbnails"');
const thumbLine = registry.slice(thumbStart, registry.indexOf("\n  },", thumbStart));
is("the registry types no second CDN request price", /export const CDN_REQUEST\b/.test(registry), false);
is("the thumbnail line costs its CDN request at traffic-cost's CDN_PER_REQUEST", thumbStart > 0 && /import \{[^}]*\bCDN_PER_REQUEST\b[^}]*\} from "\.\/traffic-cost"/.test(registry) && /\bCDN_PER_REQUEST\b/.test(thumbLine), true);

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
// Claude 4's focal 6711058322, LOW 1: the product page's own picture was still offered at 100vw when it has only a thumbnail.
const productPage = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
is("the product page's picture gives sizes whenever there is a smaller copy, not only the 800 px one", !/sizes=\{product\.image\.small \?/.test(productPage) && /sizes=\{smallerCopies\(product\.image\)\.length \?/.test(productPage), true);

done();
