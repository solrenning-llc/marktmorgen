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
is("said as sorted by AI, visibly, the numbers the reviewers', every rating alike", html.includes("AI-sorted summary: ") && html.includes("The numbers are counted from your reviewers&#x27; own words") && html.includes("every rating counts the same"), true);
is("its job said in plain words, with how many products", html.includes("one of your monthly AI jobs (the AI work your plan includes)") && /AI summary of each product&#x27;s reviews \(\d+ products?\)/.test(html), true);
const source = readFileSync("components/review-ai-summaries.tsx", "utf8");
is("one short live sentence, the product's line not a live region, focus back to the button after a refusal", [source.includes('<p className="sr-only" role="status">{announce}</p>'), (source.match(/role="status"/g) ?? []).length, source.includes("buttonRefs.current[product.id]?.focus()")], [true, 1, true]);
is("the other products' buttons say why they wait, dates say UTC", [source.includes("One summary is made at a time. This one can be made when the other is ready."), source.includes("(UTC) from")], [true, true]);
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

part("Review of 4 November 2026: the same sentence said again, the week kept after a delete");
const says = source.match(/setAnnounce\(([^)]*)\)/g) ?? [];
is("the live region is emptied first and the sentence put back on the next tick, so the same words twice are read twice", [says, /setAnnounce\(""\);\s*announceTimer\.current = window\.setTimeout\(/.test(source), (source.match(/\bsay\(`/g) ?? []).length], [['setAnnounce("")', "setAnnounce(text)"], true, 3]);
const removed = draw([{ id: "p1", title: "Pottery Course", reviews: 12, summary: null, lastAt: NOW - 86_400 }]);
is("a summary taken away by a review change: no button before the week is over, and why", [removed.includes("Make the summary"), removed.includes("The last summary was taken away because a review it counted was changed or removed. A new one can be made from")], [false, true]);
is("a week after the last one, the button", draw([{ id: "p1", title: "Pottery Course", reviews: 12, summary: null, lastAt: NOW - SUMMARY_REFRESH_SECONDS }]).includes(">Make the summary<"), true);
is("a week's refusal said with its date", source.includes('answer.error === "week" && typeof answer.next === "number"') && /week: "/.test(source), true);

part("Second review of 4 November 2026: what a refusal allows, focus before the button goes");
is("a failed or empty try says the next may be made now, as the code allows", [source.includes("try again another day"), source.includes("Try again later"), (source.match(/You can try again now; each try is one more AI job\./g) ?? []).length], [false, false, 2]);
const success = source.slice(source.indexOf("if (answer.ok && answer.summary) {"), source.indexOf("} else {"));
is("after a summary, focus moves to the status before the button is taken away", success.indexOf("statusRefs.current[product.id]?.focus();") > -1 && success.indexOf("statusRefs.current[product.id]?.focus();") < success.indexOf("setShown("), true);
const refused = source.slice(source.indexOf("} else {"), source.indexOf("} catch {"));
is("after a week's refusal too, never by a timer once the button is gone", refused.indexOf("statusRefs.current[product.id]?.focus();") > -1 && refused.indexOf("statusRefs.current[product.id]?.focus();") < refused.indexOf("setShown(") && !/setTimeout\(\(\) => statusRefs/.test(source), true);

part("The page");
const page = readFileSync("app/studio/reviews/page.tsx", "utf8");
is("opening the page only reads what was made, never makes one", page.includes("readReviewSummary(store.statsId, p.id)") && !page.includes("makeReviewSummary"), true);
is("and the week's last time, kept after a delete", page.includes("lastAt: await lastReviewSummaryAt(store.statsId, p.id)"), true);
const screen = readFileSync("components/review-ai-summaries.tsx", "utf8");
is("every refusal in plain words", ["few", "used", "busy", "off", "slow", "failed"].every((k) => new RegExp(`${k}: ["\x60]`).test(screen)), true);

done();
