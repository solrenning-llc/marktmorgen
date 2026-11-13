/**
 * AX274 item 5 (emails), WCAG 1.4.1 Use of Color and 1.4.11 Non-text Contrast,
 * under forced colors (Windows High Contrast, and mail apps that follow it).
 * Chromium with forced-colors active, 13 November 2026: an email's button,
 * "Get the guide", lost its filled background, as forced colors do, and having
 * no border and no underline it became a line of blue words, told apart from
 * the text around it only by its colour.
 *
 * What must hold: the button carries a transparent border, invisible in normal
 * colours and drawn by forced colours, so it stays a visible box; its padding is
 * 2 px less on each side, so it keeps exactly the size it had. Its colours, its
 * words and its address are unchanged.
 */
import { bodyHtml } from "@/lib/mail-body";
import { done, is, part } from "./check";

const html = bodyHtml("[Get the guide](https://example.com/guide)");
const style = html.match(/<a href="https:\/\/example\.com\/guide" style="([^"]*)">Get the guide<\/a>/)?.[1] ?? "";

part("A button stays a box under forced colours");
is("the button is drawn", style.length > 0, true);
is("it has a transparent 2 px border", /border:2px solid transparent/.test(style), true);
is("its padding is 2 px less, so its size is unchanged", /padding:10px 20px/.test(style), true);
is("it is still a filled pill with no underline in normal colours", /display:inline-block/.test(style) && /border-radius:999px/.test(style) && /text-decoration:none/.test(style) && /background:/.test(style), true);

done();
