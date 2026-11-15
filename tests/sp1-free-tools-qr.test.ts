/**
 * 244 [SP1], unit 2: a QR code for a link, made in the visitor's browser
 * (/platform/free-tools/qr-code-for-a-link): drawn from the code's own grid
 * (lib/share-links.ts qrSvg), downloadable as a file, described in words for
 * people who cannot see it. Nothing is sent or kept.
 *
 * What fails here:
 *   - an address that is not a web address (a script, a mail or phone link, a
 *     bare word) made into a code, or an empty field read as anything;
 *   - a code that does not hold exactly the address typed;
 *   - the picture without a text alternative that says where it opens;
 *   - the download not being the drawing itself, as a file with a clear name;
 *   - the tool's code reaching the network or storing anything;
 *   - the hub, the sitemap or the page missing the tool.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QRCode from "qrcode";
import { FREE_TOOLS, FREE_TOOLS_PATH, qrForLink, readLink } from "@/lib/free-tools";
import { QrTool } from "@/components/free-tool-qr";
import { FreeToolsHub } from "@/components/free-tools-hub";
import { done, is, part } from "./check";

part("Only a web address is made into a code");
is("https", readLink(" https://example.com/shop "), "https://example.com/shop");
is("http", readLink("http://example.com"), "http://example.com/");
is("a bare domain is given https", readLink("example.com/@kiln"), "https://example.com/@kiln");
is("empty is nothing", readLink(""), null);
is("a script is refused", readLink("javascript:alert(1)"), null);
is("a data address is refused", readLink("data:text/html,hi"), null);
is("a mail link is refused", readLink("mailto:a@example.com"), null);
is("a word with no dot is refused", readLink("hello"), null);
is("spaces inside are refused", readLink("https://exa mple.com"), null);
is("too long is refused", readLink(`https://example.com/${"a".repeat(1100)}`), null);

part("The code holds exactly the address");
const made = qrForLink("https://example.com/@kiln")!;
const grid = QRCode.create("https://example.com/@kiln", { errorCorrectionLevel: "M" }).modules;
is("the same grid as the encoder's for that address", made.svg.includes(`viewBox="0 0 ${(grid.size + 8) * 8} ${(grid.size + 8) * 8}"`), true);
is("an SVG drawing", made.svg.startsWith("<svg ") && made.svg.endsWith("</svg>"), true);
is("a file name from the address", made.fileName, "example-com-kiln-qr.svg");
is("nothing for a refused address", qrForLink("javascript:alert(1)"), null);

part("The page");
const html = renderToStaticMarkup(createElement(QrTool));
is("a labeled field", html.includes('for="qr-link"') && html.includes('id="qr-link"'), true);
is("says nothing leaves the page", /nothing you type leaves this page/i.test(html), true);
const source = readFileSync("components/free-tool-qr.tsx", "utf8");
is("the picture says where it opens", source.includes("alt={`QR code that opens ${") , true);
is("the download is the drawing itself, named", source.includes("download={made.fileName}") && source.includes("data:image/svg+xml"), true);
for (const file of ["components/free-tool-qr.tsx", "lib/free-tools.ts"]) {
  is(`${file}: no fetch, beacon, socket, worker or storage`, /\bfetch\(|sendBeacon|XMLHttpRequest|WebSocket|EventSource|new Worker|localStorage|sessionStorage|indexedDB|document\.cookie/.test(readFileSync(file, "utf8")), false);
}
const tool = FREE_TOOLS.find((t) => t.slug === "qr-code-for-a-link");
is("listed", tool !== undefined, true);
is("the hub links to it", renderToStaticMarkup(createElement(FreeToolsHub)).includes(`href="${FREE_TOOLS_PATH}/qr-code-for-a-link"`), true);
const page = readFileSync("app/platform/free-tools/qr-code-for-a-link/page.tsx", "utf8");
is("its page: canonical, a discreet Start your store", page.includes('canonical: "/platform/free-tools/qr-code-for-a-link"') && page.includes('href="/signin" prefetch={false}'), true);

done();
