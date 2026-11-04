/**
 * 636 [GL4](d), unit 3: each product's AI summary of its reviews in the
 * studio (components/review-ai-summaries.tsx, app/studio/reviews/page.tsx).
 * Said as sorted by AI with the reviewers' own counts; made only on the
 * creator's press, at most once a week, from enough reviews; refusals said
 * in words; opening the page makes nothing.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewAiSummaries } from "@/components/review-ai-summaries";
import { SUMMARY_REFRESH_SECONDS } from "@/lib/review-ai-summary-rules";
import { done, is, part } from "./check";

const NOW = 1_800_000_000;
const kept = { at: NOW - 86_400, read: 12, themes: [{ title: "Clear lessons", reviews: 5 }, { title: "Friendly teacher", reviews: 3 }] };
const draw = (products: Parameters<typeof ReviewAiSummaries>[0]["products"]) => renderToStaticMarkup(createElement(ReviewAiSummaries, { products, now: NOW }));

part("A summary made this week");
const html = draw([{ id: "p1", title: "Pottery Course", reviews: 12, summary: kept }]);
is("a named section, each product under its own heading", html.includes('aria-labelledby="ai-summaries-title"') && html.includes("<h3") && html.includes("Pottery Course</h3>"), true);
is("the themes with how many of the reviews read say each", html.includes("Reviewers often mention: clear lessons (5 of 12); friendly teacher (3 of 12)."), true);
is("said as sorted by AI, the counts the reviewers', every rating alike", html.includes("Summary sorted by AI: ") && html.includes("the counts are your reviewers&#x27;") && html.includes("Every rating counts the same"), true);
is("when it was made and from how many", html.includes("from 12 reviews"), true);
is("no new one before a week, and when one can be made", [html.includes("Make this week"), html.includes("A new one can be made from")], [false, true]);

part("When one can be made");
const old = draw([{ id: "p1", title: "Pottery Course", reviews: 12, summary: { ...kept, at: NOW - SUMMARY_REFRESH_SECONDS } }]);
is("a week later, the button, its name starting with its visible words and saying which product", old.includes("Make this week&#x27;s summary<span class=\"sr-only\"> of Pottery Course&#x27;s reviews</span>") && !old.includes("aria-label=\"Make the AI"), true);
is("never disabled under focus: busy is said, not taken away", old.includes('aria-disabled="false"') && !/<button[^>]* disabled=""/.test(old), true);
is("never made yet, enough reviews: Make the summary", draw([{ id: "p1", title: "Pottery Course", reviews: 5, summary: null }]).includes(">Make the summary<"), true);
is("too few reviews: said how many it needs", draw([{ id: "p1", title: "Pottery Course", reviews: 3, summary: null }]).includes("A summary needs at least 5 reviews; this one has 3."), true);
is("no reviews anywhere", draw([]).includes("No product has reviews yet."), true);
is("what happened said in a status that can take focus when the button goes", html.includes('role="status"') && html.includes('tabindex="-1"'), true);
is("months written out, not abbreviated", html.includes("Made ") && !/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d/.test(html), true);
const screenText = readFileSync("components/review-ai-summaries.tsx", "utf8");
is("while it is made, that is said", screenText.includes("Making the summary of ${product.title}'s reviews…"), true);

part("The page");
const page = readFileSync("app/studio/reviews/page.tsx", "utf8");
is("opening the page only reads what was made, never makes one", page.includes("readReviewSummary(store.statsId, p.id)") && !page.includes("makeReviewSummary"), true);
const screen = readFileSync("components/review-ai-summaries.tsx", "utf8");
is("every refusal in plain words", ["few", "used", "busy", "off", "slow", "failed"].every((k) => new RegExp(`${k}: ["\x60]`).test(screen)), true);

done();
