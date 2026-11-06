/**
 * The warnings panel in the editors (493 [DE2], components/terms-check-panel.tsx), rendered to markup, and the
 * click rule it uses. Pure: nothing is reached.
 *
 * What fails here: a warning without its words, reason, fix and the buttons that apply the fix only on the
 * creator's press; a second fix applied by a double click; a status line that is not on the page before the first
 * warning appears; a wrong count; the editor comparing a price the checkout does not charge.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { done, is, part } from "./check";
import { TermsCheckPanel, countWords, fixFromClick } from "@/components/terms-check-panel";
import type { TermsCheckInput } from "@/lib/terms-check-rules";

const base: TermsCheckInput = { text: "", ownHosts: [], priceCents: 4_900, currency: "usd", immediateAccessConsent: false, realDeadline: false, realStockLimit: false, resaleLicense: false };
let changed: string | null = null;
const render = (text: string) => renderToStaticMarkup(createElement(TermsCheckPanel, { id: "p1", fieldId: "about-p1", input: { ...base, text }, onChange: (t: string) => { changed = t; } }));
const status = (html: string) => /<p class="sr-only" role="status" aria-live="polite">([^<]*)<\/p>/.exec(html)?.[1] ?? null;

part("The status line is always there");
const clean = render("Ten watercolor lessons with worksheets, made in Canva.");
is("ordinary text: no warning list", clean.includes("data-terms-check"), false);
is("but the status line is on the page, saying nothing is to check", status(clean), "Nothing to check in what you wrote.");
is("empty text: the status line is there and silent", status(render("")), "");

part("Each warning, complete");
const html = render("The course costs $99. No refunds.");
is("a named region with a focusable heading", [html.includes('aria-labelledby="terms-check-p1"'), /<h3 id="terms-check-p1" tabindex="-1"/.test(html)], [true, true]);
is("the count, said right", [html.includes("2 things to check before you save"), countWords(1), countWords(2)], [true, "One thing to check", "2 things to check"]);
is("the status line says the count", status(html), "2 things to check in what you wrote.");
is("one warning: one thing", render("No refunds.").includes("One thing to check before you save"), true);
is("says it changes nothing by itself", html.includes("Nothing changes unless you press a button below and then save."), true);
is("the creator's words, quoted", html.includes("<q>The course costs $99. No refunds.</q>"), true);
is("the price fix names both amounts", html.includes("Change $99 to $49"), true);
is("every warning can be removed by the creator", (html.match(/Remove this sentence/g) ?? []).length, 2);
is("the buttons are buttons, not submits", (html.match(/<button type="button"/g) ?? []).length, 3);
is("no undo before any change", html.includes("Undo the last change"), false);
is("rendering changes nothing", changed, null);

part("One press, one fix");
is("a single click applies the fix", fixFromClick(1, "a. b.", "b."), "b.");
is("the second click of a double click applies nothing", fixFromClick(2, "b.", "c."), null);
is("a keyboard press (detail 0) applies the fix", fixFromClick(0, "a. b.", "b."), "b.");
is("a fix that changes nothing is not one", fixFromClick(1, "same", "same"), null);

part("The product editor compares only a price the checkout charges");
const editor = readFileSync(join(process.cwd(), "components/product-editor.tsx"), "utf8");
is("no price for a membership, a choose-your-price, options or a free product", editor.includes("priceCents: !draft.every && !draft.pwyw && !product?.options.length && !free ? readMoney(draft.price, currency) : null"), true);
is("the consent the checkout will ask, for a new product too", editor.includes("immediateAccessConsent: !draft.every && deliversDigitally(product ?? {})"), true);
is("focus goes back to the description when nothing is left", editor.includes("fieldId={`product-about-${id}`}"), true);
done();
