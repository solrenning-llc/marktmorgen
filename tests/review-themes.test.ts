/**
 * 636 [GL4](c): what reviewers keep saying, on the reviews page. Only the
 * customer voice's themes that reviews are part of, with reviews in their
 * writers' own words; a one-star review counts like a five-star one; AI is
 * said to have named the themes only; nothing made means a way to make it.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewThemes } from "@/components/review-themes";
import type { VoiceSummary } from "@/lib/customer-voice";
import { done, is, part } from "./check";

const voice: VoiceSummary = {
  at: 1_790_000_000,
  month: "2026-11",
  read: { review: 12, search: 30 },
  other: 0,
  themes: [
    { title: "Hard to follow at first", count: 5, sources: { review: 3, question: 2 }, examples: [{ source: "review", text: "The first lesson went too fast", n: 1, stars: 1 }, { source: "question", text: "Where do I start?", n: 1 }, { source: "review", text: "Took me a while to get going", n: 1, stars: 4 }] },
    { title: "Searches for templates", count: 30, sources: { search: 30 }, examples: [{ source: "search", text: "templates", n: 30 }] },
  ],
} as VoiceSummary;
const html = (v: VoiceSummary | null) => renderToStaticMarkup(createElement(ReviewThemes, { voice: v, studioHome: "/studio?store=x" }));

part("Themes reviews are part of, in reviewers' words");
const shown = html(voice);
is("the theme reviews share is shown, the one only searches made is not", [shown.includes("Hard to follow at first"), shown.includes("Searches for templates")], [true, false]);
is("its reviews, one star like four, and not the question under it", [shown.includes("The first lesson went too fast"), shown.includes("1 star"), shown.includes("Took me a while to get going"), shown.includes("Where do I start?")], [true, true, true, false]);
is("how many reviews said it, not the theme's other sources", shown.includes("· 3 reviews"), true);
is("AI said to have only named it", shown.includes("AI named each theme") && shown.includes("Theme named by AI"), true);

part("Nothing made yet, or nothing repeated");
is("a way to make it, on the studio's home page", html(null).includes('href="/studio?store=x"'), true);
is("no theme from reviews: said so", html({ ...voice, themes: [voice.themes[1]] }).includes("No theme was repeated in reviews"), true);

part("On the reviews page, read from the month's summary");
const page = readFileSync("app/studio/reviews/page.tsx", "utf8");
is("read, never made there (no AI job of its own)", [page.includes("readVoice(store)"), page.includes("makeVoice")], [true, false]);
done();
