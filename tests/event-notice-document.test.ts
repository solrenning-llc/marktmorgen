/**
 * AX274 item 5 (emails), WCAG 2.4.2 Page Titled, 3.1.1 Language of Page and
 * 1.4.10 Reflow: the email that tells the people coming that a live event was
 * moved or canceled is a whole page. The email and PDF audit of 11 November 2026
 * (PR #3766) found its HTML had <html lang> but no head: no character set, no
 * viewport and no title, so an app or browser that opens it on its own showed no
 * title, could guess the wrong characters, and laid it out at a desktop width on
 * a phone. PR #3755 fixed the other service letters and left this one for its own
 * change, the file being reserved.
 *
 * What must hold: the notice's HTML is drawn as lib/mail.ts draws a store email,
 * with the character set, the phone viewport and the subject as its title, in the
 * store's language; its words, colors and text version are unchanged.
 */
import * as events from "@/lib/community-event-mail";
import { done, is, part } from "./check";

const noticeHtml = (events as unknown as { noticeHtml?: (subject: string, body: string, why: string, lang: string, sent: string) => string }).noticeHtml;

part("The moved or canceled notice is a whole page");
is("noticeHtml is exported for this test", typeof noticeHtml, "function");
const html = noticeHtml?.("New time: Bread & <butter> class", "Harbor Kitchen has moved the class.", "You are getting this because you RSVP'd.", "es-ES", "Sent with Marktmorgen.") ?? "";
is("it opens with the doctype and the language", html.startsWith('<!doctype html><html lang="es-ES"><head>'), true);
is("it says its character set", html.includes('<meta charset="utf-8">'), true);
is("it fits a phone's width", html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'), true);
is("its title is the subject, escaped", html.includes("<title>New time: Bread &amp; &lt;butter&gt; class</title>"), true);
is("the head closes before the body", /<\/title>.*<\/head><body /s.test(html), true);
is("the words are still there", ["Harbor Kitchen has moved the class.", "You are getting this because you RSVP&#39;d.", "Sent with Marktmorgen."].every((w) => html.includes(w)), true);
is("the footer keeps its 7:1 color", html.includes("color:#57534e"), true);

done();
