/**
 * A product title or store name with one long word, on a phone (issue #4317, creator funnel, Claude 1, 12/11/2026).
 * Found by walking main as a new creator: a product called "The Absolutely Comprehensive
 * Weeknightsourdoughbakingencyclopedia Volume" ran 55 px past its card on the store page at 320 px and was
 * cut off at the screen's edge, and with WCAG 1.4.12 text spacing the store's name at the top of its pages
 * did the same. Long compounds are ordinary in German, one of the buyer languages. Every .st-title-link (the
 * product titles on a store, the store's name at the top of its pages, the cart's lines) now wraps inside
 * its box. Measured in a browser on the same walk at 320 px, with and without 1.4.12 spacing: nothing past
 * the screen on the store page or the product page.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const css = readFileSync("app/globals.css", "utf8");
const rule = css.slice(css.indexOf(".st-title-link {"), css.indexOf("}", css.indexOf(".st-title-link {")));

part("The rule every store title link takes");
is("found", rule.startsWith(".st-title-link {"), true);
is("a long word wraps inside its box", /overflow-wrap:\s*anywhere;/.test(rule), true);
is("nothing later in the sheet sets it back for these links", /\.st-title-link[^{]*\{[^}]*overflow-wrap:\s*normal/.test(css), false);
is("the product card's title link is one of them", readFileSync("components/store-product.tsx", "utf8").includes('const TITLE_LINK = "st-title-link '), true);

done();
