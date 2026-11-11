/**
 * WCAG 2.2 1.4.10 Reflow (274 [AX1]): /studio/blog fits a 320 px wide screen
 * without scrolling sideways.
 *
 * Found by Claude 3 (cloud D)'s AAA audit of main @7b04206e7 (11 November
 * 2026, production build, Chromium at 320 px): the page was 394 px wide. The
 * first sentence carries the blog's address ("What you know, at
 * marktmorgen.com/@<handle>/blog, …"), one word as long as the handle allows,
 * and a word that does not break runs past its paragraph (378 px of text in a
 * 288 px box) and widens the page.
 *
 * The paragraph that names the address breaks a word longer than its line
 * where it must, so an address of any length fits.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const page = readFileSync("app/studio/blog/page.tsx", "utf8");
/** The opening tag of the paragraph whose words hold the blog's address. */
const paragraph = /<p className="([^"]*)">\s*\{`What you know, at marktmorgen\.com\/@\$\{store\.handle\}\/blog,/.exec(page);

part("The studio's blog page fits a 320 px screen (WCAG 1.4.10)");
is("the first sentence names the blog's address, built from the store's handle", paragraph !== null, true);
is("that paragraph breaks a word longer than its line, such as the address", /(^|\s)\[overflow-wrap:anywhere\](\s|$)/.test(paragraph?.[1] ?? ""), true);

done();
