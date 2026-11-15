/**
 * 244 [SP1], unit 3: a picture resized for a product page, in the visitor's
 * browser (/platform/free-tools/resize-a-picture): to the size the store
 * keeps a product picture at (lib/product-image.ts, IMAGE_LONG_SIDE on the
 * long side, at most MAX_IMAGE_BYTES), with the same shrinking the studio
 * uses (components/shrink-image.ts). The picture never leaves the browser.
 *
 * What fails here:
 *   - a size typed here instead of read from the store's own rules;
 *   - the file name of the result not saying its size and type, or keeping
 *     characters a file name should not have;
 *   - anything other than a picture accepted, or a file over the size the
 *     studio itself opens;
 *   - the tool's code reaching the network, uploading or storing anything;
 *   - the result shown without its size in words, or without a text alternative;
 *   - the hub, the sitemap or the page missing the tool.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IMAGE_LONG_SIDE, MAX_IMAGE_BYTES, MAX_SOURCE_BYTES } from "@/lib/product-image";
import { FREE_TOOLS, FREE_TOOLS_PATH } from "@/lib/free-tools";
import { PICTURE_ACCEPT, PICTURE_LONG_SIDE, PICTURE_MAX_BYTES, PICTURE_MAX_SOURCE_BYTES, pictureFileName, sizeInWords, sourceProblem } from "@/lib/free-tool-picture";
import { PictureTool } from "@/components/free-tool-picture";
import { FreeToolsHub } from "@/components/free-tools-hub";
import { done, is, part } from "./check";

part("The store's own sizes, not new ones");
is("the long side the store keeps", PICTURE_LONG_SIDE, IMAGE_LONG_SIDE);
is("the most a kept picture weighs", PICTURE_MAX_BYTES, MAX_IMAGE_BYTES);
is("the biggest file the studio opens", PICTURE_MAX_SOURCE_BYTES, MAX_SOURCE_BYTES);

part("What is taken");
is("pictures only", PICTURE_ACCEPT, "image/jpeg,image/png,image/webp");
is("a JPEG", sourceProblem({ type: "image/jpeg", size: 5_000_000 }), null);
is("a PDF is refused", sourceProblem({ type: "application/pdf", size: 1000 }), "type");
is("an SVG is refused", sourceProblem({ type: "image/svg+xml", size: 1000 }), "type");
is("too big is refused", sourceProblem({ type: "image/png", size: MAX_SOURCE_BYTES + 1 }), "size");
is("an empty file is refused", sourceProblem({ type: "image/png", size: 0 }), "empty");

part("The result's name and size");
is("named for its size and type", pictureFileName("My Photo (final).PNG", 1600, 1200, "image/webp"), "my-photo-final-1600x1200.webp");
is("JPEG", pictureFileName("cover.jpeg", 1200, 1500, "image/jpeg"), "cover-1200x1500.jpg");
is("a name with nothing usable", pictureFileName("???.png", 800, 800, "image/webp"), "picture-800x800.webp");
is("kilobytes", sizeInWords(245_760), "240 KB");
is("megabytes", sizeInWords(1_572_864), "1.5 MB");

part("The page");
const html = renderToStaticMarkup(createElement(PictureTool));
is("a labeled file field that takes pictures only", html.includes('for="picture-file"') && html.includes('id="picture-file"') && html.includes(`accept="${PICTURE_ACCEPT}"`), true);
is("says the picture stays on the device", /never leaves your device/i.test(html), true);
const source = readFileSync("components/free-tool-picture.tsx", "utf8");
is("the studio's own shrinking", source.includes('from "@/components/shrink-image"') && source.includes("shrink(file, PICTURE_LONG_SIDE, PICTURE_MAX_BYTES)"), true);
is("the result has a text alternative", source.includes('alt="Your resized picture"'), true);
is("its size said in words", source.includes("sizeInWords("), true);
for (const file of ["components/free-tool-picture.tsx", "lib/free-tool-picture.ts"]) {
  is(`${file}: no fetch, beacon, socket, worker, upload or storage`, /\bfetch\(|sendBeacon|XMLHttpRequest|WebSocket|EventSource|new Worker|localStorage|sessionStorage|indexedDB|document\.cookie|FormData/.test(readFileSync(file, "utf8")), false);
}
is("listed", FREE_TOOLS.some((t) => t.slug === "resize-a-picture"), true);
is("the hub links to it", renderToStaticMarkup(createElement(FreeToolsHub)).includes(`href="${FREE_TOOLS_PATH}/resize-a-picture"`), true);
const page = readFileSync("app/platform/free-tools/resize-a-picture/page.tsx", "utf8");
is("its page: canonical, a discreet Start your store", page.includes('canonical: "/platform/free-tools/resize-a-picture"') && page.includes('href="/signin" prefetch={false}'), true);

done();
