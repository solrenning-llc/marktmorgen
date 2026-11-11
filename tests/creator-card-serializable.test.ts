/**
 * /studio/card, the creator's business card (app/studio/card/page.tsx), drew
 * an error page for every creator: the server page handed the client editor
 * (components/creator-card-editor.tsx, "use client") the card's words from
 * lib/buyer-words/contact.ts, and one of them, `store`, is a function
 * ("Visit Ana's Pottery"). React refuses a function as a prop from a server
 * component to a client one ("Functions cannot be passed directly to Client
 * Components"), so the page answered HTTP 500. Seen on 11 November 2026 in a
 * production build of main with the synthetic e2e seed.
 *
 * Now the page hands over the store's language, a plain string, and the
 * editor reads the words itself (the words file is browser-safe).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CreatorCardEditor } from "@/components/creator-card-editor";
import type { CreatorCard } from "@/lib/creator-card";
import { done, is } from "./check";

const page = readFileSync("app/studio/card/page.tsx", "utf8");
const at = page.indexOf("<CreatorCardEditor");
const call = page.slice(at, page.indexOf("/>", at));
is("the page draws the editor", at > 0, true);
is("it hands over the store's language, a plain string", /\blanguage=\{store\.language\}/.test(call), true);
is("and no words object, whose store line is a function", /\bwords=\{/.test(call), false);

// Every prop the page passes must survive the trip to the browser: no function anywhere in it.
const hasFunction = (value: unknown): boolean =>
  typeof value === "function" || (value !== null && typeof value === "object" && Object.values(value as Record<string, unknown>).some(hasFunction));
const props = { initial: { on: true, name: "Ana Souza", title: "", email: "", phone: "", website: "", note: "" } as CreatorCard, handle: "anapottery", storeName: "Ana's Pottery", language: "pt" as const, address: "marktmorgen.com/@anapottery/contact", look: { className: "st-page", style: {}, lang: "pt-PT" } };
is("the editor's props hold no function", hasFunction(props), false);
const html = renderToStaticMarkup(createElement(CreatorCardEditor, props));
is("the editor still says the store line in the store's language", html.includes("Visitar Ana&#x27;s Pottery"), true);
is("and the card's other words", html.includes("Guardar contacto"), true);

done();
