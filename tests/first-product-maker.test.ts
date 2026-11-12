/**
 * The studio's "Make your first product" screen (490 [PP1], unit 2; components/first-product-maker.tsx,
 * app/studio/first-product/page.tsx; added 12 November 2026), as first drawn. Checked:
 *
 *   - four steps, each a section named by its heading, in order: what to make, a few choices, write it, download;
 *   - the format and each question are radio buttons inside a fieldset with a legend, the first choice marked, and
 *     only the questions that change the outline (no AI drafts in this unit);
 *   - the title, the notes and every part of the outline are fields with a visible label and a hint tied to them,
 *     with the same limits the server keeps;
 *   - it says what is kept where (this device only, sent only to make the PDF), and promises nothing the file does
 *     not hold: no "AI", no "done for you", no figures;
 *   - the studio's products area links to it, for whoever may change products; the page asks for that permission.
 *
 * Not checked here: typing, the download and the kept draft in a real browser, or a screen reader.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FirstProductMaker } from "@/components/first-product-maker";
import { FORMAT_INFO, outlineFor, questionsFor } from "@/lib/first-product";
import { FIRST_PRODUCT_MAX_HEADING, FIRST_PRODUCT_MAX_PART } from "@/lib/first-product-limits";
import { done, is, part } from "./check";

const html = renderToStaticMarkup(createElement(FirstProductMaker, { storeKey: "abc", productsHref: "/studio#products" }));
const count = (re: RegExp) => (html.match(re) ?? []).length;

part("Four steps, in order");
const steps = ["1. What will you make?", "2. A few choices", "3. Write it", "4. Download it"];
is("each a heading, in order", steps.map((s) => html.indexOf(`>${s}</h2>`)).every((at, i, all) => at > 0 && (i === 0 || at > all[i - 1])), true);
is("each section named by its heading", ["fp-format", "fp-choices", "fp-write", "fp-download"].every((id) => html.includes(`aria-labelledby="${id}"`) && html.includes(`id="${id}"`)), true);

part("Choices by buttons");
is("the four formats as radio buttons, the guide marked", [count(/name="fp-format"/g), /<input type="radio" class="[^"]*" name="fp-format" checked=""\/>/.test(html)], [4, true]);
const asked = questionsFor("guide", false);
is("only the questions that change the outline", [asked.map((q) => q.id), asked.every((q) => html.includes(`<legend class="field-label">${q.ask}</legend>`))], [["length", "ending"], true]);
is("every question with its first choice marked", asked.every((q) => new RegExp(`name="fp-${q.id}" checked=""`).test(html)), true);

part("Writing");
const parts = outlineFor("guide", {}, "").parts;
is("a field for every part of the outline, labeled, with its hint", [count(/<textarea/g), parts.every((_, i) => html.includes(`aria-describedby="fp-ask-${i}"`) && html.includes(`id="fp-ask-${i}"`))], [parts.length + 1, true]);
is("the same limits the server keeps", [html.includes(`maxLength="${FIRST_PRODUCT_MAX_PART}"`), html.includes(`maxLength="${FIRST_PRODUCT_MAX_HEADING}"`)], [true, true]);
is("the notes field asks in the format's own words, its example beside it, never in it", [html.includes(FORMAT_INFO.guide.know), html.includes(`For example: ${FORMAT_INFO.guide.example}`), html.includes(`value="${FORMAT_INFO.guide.example}"`)], [true, true, false]);
is("it says the notes are not put in the PDF", html.includes("They are not put in the PDF."), true);

part("Honest about what it does");
is("what is kept where", html.includes("What you write is kept on this device only, until you clear it. It is sent to us only to make the PDF, and not kept."), true);
const words = html.replace(/<[^>]+>/g, " ");
is("no AI, no done for you, no figures promised", /\bAI\b|done for you|guarantee|\$\d|earn|income|best[- ]seller/i.test(words), false);
is("start over asks before clearing", readFileSync("components/first-product-maker.tsx", "utf8").includes("Yes, clear what I wrote"), true);

part("Where it is reached");
const page = readFileSync("app/studio/first-product/page.tsx", "utf8");
is("the page asks for the products permission and has a trail", [page.includes('"products");'), page.includes('<StudioTrail store={store} here="Make your first product" />')], [true, true]);
const studio = readFileSync("app/studio/page.tsx", "utf8");
const productsArea = studio.slice(studio.indexOf('<div id="products"'), studio.indexOf("<ProductEditor"));
is("the products area links to it", productsArea.includes('studioPath(store, "", "first-product")'), true);

done();
