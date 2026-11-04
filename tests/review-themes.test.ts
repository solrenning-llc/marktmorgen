/**
 * 636 [GL4](c): what reviewers keep saying, on the reviews page. Only the
 * customer voice's themes that reviews are part of, with reviews in their
 * writers' own words; a one-star review counts like a five-star one; AI is
 * said to have named the themes only; nothing made means a way to make it.
 * Review themes are kept before the summary's themes are cut to their few
 * places, so searches made many times never push one off the list.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewThemes } from "@/components/review-themes";
import { MAX_THEMES, themesFrom, type VoiceItem, type VoiceSummary } from "@/lib/customer-voice";
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
is("no theme with a review: said so, and only that", html({ ...voice, themes: [voice.themes[1]] }).includes("None of this month&#x27;s themes includes a review."), true);
is("…also when the review themes kept are none", html({ ...voice, reviewThemes: [] }).includes("None of this month&#x27;s themes includes a review."), true);

part("Searches never push a theme of reviews off the list");
// Seven themes: six of searches made many times, one of four reviews, the smallest count.
const items: VoiceItem[] = [];
const add = (item: Omit<VoiceItem, "id">) => (items.push({ ...item, id: items.length + 1 }), items.length);
const listed: { title: string; ids: number[] }[] = [];
for (const word of ["templates", "pricing", "coupon", "bundle", "webinar", "ebook"]) listed.push({ title: `Searches for ${word}`, ids: [add({ source: "search", text: word, n: 20 }), add({ source: "search", text: `${word} pdf`, n: 20 })] });
listed.push({ title: "Audio is too quiet", ids: ["Hard to hear the audio", "The sound is low", "Audio too quiet in lesson two", "Could barely hear it"].map((text, i) => add({ source: "review", text, n: 1, stars: i + 1 })) });
const sorted = themesFrom({ themes: listed }, items);
is("the summary's themes are cut to their places, and the review theme is past the cut", [sorted.themes.length, sorted.themes.some((t) => t.title === "Audio is too quiet")], [MAX_THEMES, false]);
is("but it is kept among the review themes, with its four reviews", sorted.reviewThemes.map((t) => [t.title, t.sources.review, t.examples.length]), [["Audio is too quiet", 4, 3]]);
const cut = html({ ...voice, themes: sorted.themes, reviewThemes: sorted.reviewThemes });
is("the reviews page shows it, and does not say nothing was repeated", [cut.includes("Audio is too quiet"), cut.includes("· 4 reviews"), cut.includes("None of this month")], [true, true, false]);
const mixed = themesFrom({ themes: [{ title: "Wants captions", ids: [add({ source: "search", text: "captions", n: 40 }), add({ source: "search", text: "subtitles", n: 40 }), add({ source: "search", text: "transcript", n: 40 }), add({ source: "review", text: "Please add captions", n: 1, stars: 3 })] }] }, items);
is("a theme searches share: its review's words are its examples, not only the searches", mixed.reviewThemes[0]?.examples.map((e) => e.text), ["Please add captions"]);
is("kept with the month's summary", readFileSync("lib/customer-voice.ts", "utf8").includes("reviewThemes: sorted.reviewThemes"), true);

part("On the reviews page, read from the month's summary");
const page = readFileSync("app/studio/reviews/page.tsx", "utf8");
is("read, never made there (no AI job of its own)", [page.includes("readVoice(store)"), page.includes("makeVoice")], [true, false]);
done();
