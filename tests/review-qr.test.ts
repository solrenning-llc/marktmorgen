/**
 * 636 [GL4](b): a QR code for reviews from buyers met in person
 * (components/review-qr.tsx, app/studio/reviews/page.tsx). The code holds the
 * store's purchases page and nothing else, so only a buyer who proves their
 * email reviews; it is drawn from the code's grid; it has a text alternative,
 * the address in words and a download; the studio shows it only where the
 * purchases page works.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QRCode from "qrcode";
import { ReviewQr } from "@/components/review-qr";
import { done, is, part } from "./check";

const url = "https://marktmorgen.com/@harbor/orders";
part("The code");
const html = renderToStaticMarkup(createElement(ReviewQr, { url, storeName: "Harbor & Co" }));
is("an image with words saying what it opens", html.includes('alt="QR code that opens the purchases page of Harbor &amp; Co"'), true);
is("the address written out", html.includes(`>${url}</p>`), true);
is("a download as SVG with a file name", html.includes('download="harbor-co-reviews-qr.svg"'), true);
const svg = decodeURIComponent(/src="data:image\/svg\+xml;charset=utf-8,([^"]+)"/.exec(html)?.[1] ?? "");
const code = QRCode.create(url, { errorCorrectionLevel: "M" });
const dark = Array.from(code.modules.data, Boolean).filter(Boolean).length;
is("drawn from the code's own grid: one square per dark module", (svg.match(/h8v8h-8z/g) ?? []).length, dark);
is("black on white", svg.includes('fill="#ffffff"') && svg.includes('fill="#000000"'), true);
is("says how only buyers can review", html.includes("Only people who bought can review"), true);

part("The studio");
const page = readFileSync("app/studio/reviews/page.tsx", "utf8");
is("shown only where the purchases page works", page.includes("{canRecover(store) ? (") && page.includes("<ReviewQr url={`${storeBase(store)}/orders`}"), true);
is("under its own heading", page.includes('id="in-person-title"'), true);
done();
