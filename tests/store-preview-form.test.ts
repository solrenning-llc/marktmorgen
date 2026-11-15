/**
 * 488 [IT5] unit 3b: the store preview's form on the home page (components/store-preview-form.tsx), its draft
 * (components/store-preview-draft.tsx) and its words (lib/store-preview-words.ts). Checked: no page offers it while
 * STORE_PREVIEW_ON is false, and only the home page names it; one field with a label and an example, one button, the
 * progress said in a live region with no bar and no promised time; the draft read in order under headings, a price
 * only where the visitor's words gave one, and said plainly to be a draft that nothing publishes; every refusal said
 * in plain words with a way on.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StorePreviewDraft } from "@/components/store-preview-draft";
import { PREVIEW_ERRORS, PREVIEW_WORDS, previewRefusalWords } from "@/lib/store-preview-words";
import { STORE_PREVIEW_ON } from "@/lib/store-preview-rules";
import { done, is, part } from "./check";

const root = process.cwd();
function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === "node_modules" ? [] : sourcesUnder(path)) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const TIME_PROMISE = /\b(instant(ly)?|in (a few )?(seconds|minutes)|seconds?|minutes?|right away|immediately)\b/i;

part("Off, and only on the home page");
is("the switch is off", STORE_PREVIEW_ON, false);
const home = readFileSync(join(root, "app/page.tsx"), "utf8");
is("the home page shows the form only behind the switch", /\{STORE_PREVIEW_ON \? \(\s*<section[^]*?<StorePreviewForm \/>[^]*?<\/section>\s*\) : null\}/.test(home), true);
const naming = ["app", "components"].flatMap((dir) => sourcesUnder(join(root, dir))).filter((path) => /\bStorePreviewForm\b/.test(readFileSync(path, "utf8"))).map((path) => path.slice(root.length + 1)).sort();
is("no other page names it", naming, ["app/page.tsx", "components/store-preview-form.tsx"]);

part("The form");
const form = readFileSync(join(root, "components/store-preview-form.tsx"), "utf8");
is("one field, labeled, with an example inside it", [/<label htmlFor=\{fieldId\}/.test(form), /placeholder=\{PREVIEW_WORDS\.example\}/.test(form), (form.match(/<textarea/g) ?? []).length], [true, true, 1]);
is("one button to ask for the draft", (form.match(/type="submit"/g) ?? []).length, 1);
is("the progress said in a live region, with no bar", [/aria-live="polite"/.test(form), /<progress|role="progressbar"/.test(form)], [true, false]);
is("it posts to the preview's door, and nowhere else", [...form.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]), ["/api/store-preview"]);
is("the hidden field robots fill is there, out of the way of people", /name="website"[^>]*tabIndex=\{-1\}[^>]*aria-hidden="true"/.test(form) || /aria-hidden="true"[^>]*name="website"/.test(form), true);
is("no words promise a time", Object.values(PREVIEW_WORDS).filter((w) => TIME_PROMISE.test(w)), []);

part("The draft, in order");
const draft = { bios: ["Watercolor lessons for beginners.", "Paint your first landscape."], products: [{ title: "Watercolor Basics", summary: "Six short lessons.", kind: "course" as const, price: "29" }, { title: "Brush Guide", summary: "A printable guide.", kind: "download" as const, price: "" }], faq: [{ q: "Do I need paints?", a: "A basic set is enough." }] };
const html = renderToStaticMarkup(createElement(StorePreviewDraft, { draft, currency: "usd", headingId: "pv-draft" }));
const headings = [...html.matchAll(/<h([34])[^>]*>([^<]+)</g)].map((m) => `h${m[1]} ${m[2]}`);
is("headings in order", headings, ["h3 Your store draft", "h4 Lines for under your name", "h4 Products", "h4 Questions buyers ask"]);
is("said to be a draft nothing publishes", html.includes(PREVIEW_WORDS.notPublished), true);
is("a price only where the visitor's words gave one", [html.includes("$29<"), (html.match(/\$\d/g) ?? []).length, html.includes(PREVIEW_WORDS.noPrice)], [true, 1, true]);
is("lists are lists", [(html.match(/<ul/g) ?? []).length >= 2, html.includes("<dl")], [true, true]);
is("an empty draft says so rather than showing empty headings", renderToStaticMarkup(createElement(StorePreviewDraft, { draft: { bios: [], products: [], faq: [] }, currency: "usd", headingId: "x" })).includes(PREVIEW_WORDS.empty), true);

part("Refusals, in plain words with a way on");
for (const error of PREVIEW_ERRORS) {
  const words = previewRefusalWords(error);
  is(`${error}: said, with no time promised`, [words.length > 20, TIME_PROMISE.test(words)], [true, false]);
}
is("an answer it does not know is still said", previewRefusalWords("something new"), previewRefusalWords("failed"));
is("full and address offer the sign-up", [previewRefusalWords("full"), previewRefusalWords("address")].every((w) => /pick your name/i.test(w)), true);
done();
