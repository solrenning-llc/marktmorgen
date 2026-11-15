/**
 * AX274 Part A, item 5: the email to everyone coming when a creator moves or cancels an event
 * (lib/community-event-mail.ts, noticeHtml) is a whole document built by lib/email-document.ts (#4242), like every
 * other transactional email: its subject as the title (WCAG 2.4.2), its language on <html> and on the named article
 * (3.1.1), its charset, so accented words in the store's language arrive whole, and a viewport (1.4.10). Before, it
 * had <html lang> and a body, but no head, charset or title (email audit of 11 November 2026, "Open").
 * Synthetic words only; nothing is sent.
 */
import { noticeHtml } from "@/lib/community-event-mail";
import { done, is } from "./check";

const html = noticeHtml("**Live Q&A** moved to Friday.\n\nSee you there.", "You said you were coming.", "fr-FR", "Envoyé avec Marktmorgen", "Événement déplacé : Live Q&A");
const head = html.slice(0, html.indexOf("</head>") + 7);
is("a whole document with its charset and the store's language", /^<!doctype html><html lang="fr-FR"><head><meta charset="utf-8">/.test(html), true);
is("its title is the subject, escaped", head.match(/<title>([^<]*)<\/title>/)?.[1] ?? null, "Événement déplacé : Live Q&amp;A");
is("it reflows on a phone", head.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'), true);
is("the message is one article named by the subject, in the store's language", /<div role="article" aria-roledescription="email" aria-label="Événement déplacé : Live Q&amp;A" lang="fr-FR"/.test(html), true);
is("its words, why it came and the footer are kept", [html.includes("moved to Friday."), html.includes("You said you were coming."), html.includes("Envoyé avec Marktmorgen"), html.trim().endsWith("</body></html>")], [true, true, true, true]);
// The footer's grey on the email's white paper (lib/email-document.ts EMAIL_PAPER): #57534e on #ffffff is 7.6:1.
is("the footer keeps a 7:1 grey", /color:#57534e/.test(html), true);

done();
