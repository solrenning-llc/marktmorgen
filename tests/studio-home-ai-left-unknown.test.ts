/**
 * Rule 24 on the studio's home page (VR item 2): the writing helps that take the month's AI allowance from the
 * page (the store details, the store page's questions and the media kit), when it could not be read. The page
 * hands them aiOnValue(true, null) = { known: false } (lib/ai-on-value.ts); each says so in words, never "0 left
 * this month", and its AI button stays off until the page is reloaded. A known count is unchanged (control).
 * Real components, rendered to HTML with a router that goes nowhere.
 */
import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailsForm } from "@/components/details-form";
import { FaqEditor } from "@/components/faq-editor";
import { KitEditor } from "@/components/kit-editor";
import { NO_KIT } from "@/lib/store-kit";
import { done, is } from "./check";

const UNKNOWN = /We could not check your AI allowance just now\. Reload the page in a minute to try again\./;
type Ai = { on: boolean; left: number; known?: false };
const tools: [string, (ai: Ai) => ReactElement, RegExp][] = [
  ["store details", (ai) => createElement(DetailsForm, { name: "Shop", bio: "", ai: ai as never }), /Suggest three lines/],
  ["store questions", (ai) => createElement(FaqEditor, { faq: [], ai: ai as never }), /Draft them with AI/],
  ["media kit", (ai) => createElement(KitEditor, { kit: NO_KIT, handle: "shop", currency: "usd" as never, socials: [], ai: ai as never, contact: true }), /Draft it with AI/],
];
const button = (html: string, words: RegExp) => [...html.matchAll(/<button\b([^>]*)>((?:(?!<\/button>)[\s\S])*)<\/button>/g)].find((m) => words.test(m[2]))?.[1] ?? "";

for (const [where, render, words] of tools) {
  const unread = renderToStaticMarkup(render({ on: true, left: 0, known: false }));
  is(`${where}: an unread allowance is said in words`, UNKNOWN.test(unread), true);
  is(`${where}: never as a count`, /\b0 (drafts )?left this month/.test(unread), false);
  is(`${where}: its AI button is off`, /disabled=""/.test(button(unread, words)), true);
  const known = renderToStaticMarkup(render({ on: true, left: 9 }));
  is(`${where}: control, a known count is shown`, /\b9 (drafts )?left this month/.test(known) && !UNKNOWN.test(known), true);
}

const page = readFileSync("app/studio/page.tsx", "utf8");
is("the studio home catches an unread allowance as null, never 0", /aiLeft\(store\)\.catch\(\(\) => null\)/.test(page) && !/aiLeft\(store\)\.catch\(\(\) => 0\)/.test(page), true);

done();
