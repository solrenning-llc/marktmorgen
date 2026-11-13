/**
 * AX274 (WCAG 2.2 3.1.1 Language of Page): a lesson's HTML block is shown in a sandboxed frame as a document of its
 * own (lib/lesson-html.ts). That document had no language, so a screen reader read the creator's words in whatever
 * voice it defaulted to, not the store's language. It now carries the store's language, passed from the lesson
 * page; the studio's preview, which is in English, marks English. The creator's HTML is not changed.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { lessonHtmlDocument } from "@/lib/lesson-html";
import { LessonText } from "@/components/lesson-text";
import { done, is, part } from "./check";

part("The lesson's HTML document says its language");
is("the store's language", lessonHtmlDocument("<p>Hola</p>", "es-ES").startsWith('<!doctype html><html lang="es-ES">'), true);
is("English when none is given", lessonHtmlDocument("<p>Hi</p>").startsWith('<!doctype html><html lang="en-US">'), true);
is("a language that is not one is never written", lessonHtmlDocument("<p>x</p>", '"><script>').startsWith('<!doctype html><html lang="en-US">'), true);
is("the creator's HTML is kept", lessonHtmlDocument("<p>Hola</p>", "es-ES").includes("<p>Hola</p>"), true);

part("The lesson page passes it");
const html = renderToStaticMarkup(createElement(LessonText, { text: "```html-preview\n<p>Bonjour</p>\n```", lang: "fr-FR" }));
is("the frame's document is in the store's language", html.includes("&lt;html lang=&quot;fr-FR&quot;&gt;") || html.includes('html lang=&quot;fr-FR&quot;'), true);
const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
is("the lesson page gives the store's language", page.includes("<LessonText text={body} codeLabel={w.codeBlock} lang={said.lang.locale} />"), true);

done();
