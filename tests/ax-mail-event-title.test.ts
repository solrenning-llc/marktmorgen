/**
 * AX274 Part A, item 5: the email to everyone coming when a creator moves or
 * cancels an event (lib/community-event-mail.ts) is a whole page, with its
 * subject as the title (WCAG 2.4.2), its language on <html> (3.1.1) and its
 * charset, so accented words in the store's language arrive whole. Synthetic
 * words only; nothing is sent.
 */
import { noticeHtml } from "@/lib/community-event-mail";
import { done, is } from "./check";

const html = noticeHtml("**Live Q&A** moved to Friday.\n\nSee you there.", "You said you were coming.", "fr-FR", "Envoyé avec Marktmorgen", "Événement déplacé : Live Q&A");
const head = html.slice(0, html.indexOf("</head>") + 7);
is("the notice opens as a whole page with its charset and language", /^<!doctype html><html lang="fr-FR"><head><meta charset="utf-8">/.test(html), true);
is("the notice's title is its subject, escaped", head.match(/<title>([^<]*)<\/title>/)?.[1] ?? null, "Événement déplacé : Live Q&amp;A");
is("the notice reflows on a phone", head.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'), true);
is("the notice keeps its words and footer", [html.includes("You said you were coming."), html.includes("Envoyé avec Marktmorgen"), html.trim().endsWith("</body></html>")], [true, true, true]);

done();
