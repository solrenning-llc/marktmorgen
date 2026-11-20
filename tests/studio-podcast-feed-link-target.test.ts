/**
 * The private podcast page in the studio (app/studio/podcast/[product]/page.tsx)
 * shows the owner a link, "Get your own feed, as a buyer does", on a row of its
 * own beside a status line, not inside a sentence. WCAG 2.2 2.5.5 Target Size
 * (Enhanced, AAA; AX274 Part A item 4) asks for 44 × 44 px there. Measured in
 * Chromium at 390 and 1280 px it was 238 × 20 px. It now takes min-h-11 (44px)
 * with its words centered on that height.
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const page = readFileSync("app/studio/podcast/[product]/page.tsx", "utf8");
const at = page.indexOf("Get your own feed, as a buyer does");
const open = page.lastIndexOf("<Link", at);
const className = /className="([^"]*)"/.exec(page.slice(open, at))?.[1] ?? "";

is("the feed link is still on the page", at > 0 && open > 0, true);
is("the feed link is a 44px target", /\bmin-h-11\b/.test(className), true);
is("its words are centered on that height", /\binline-flex\b/.test(className) && /\bitems-center\b/.test(className), true);
is("it keeps its underline, so it still reads as a link", /\bunderline\b/.test(className), true);

done();
