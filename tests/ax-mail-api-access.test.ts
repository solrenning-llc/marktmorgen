/**
 * AX274 Part A, item 5: the email a buyer gets when a creator gives them a
 * product through the API (lib/api-write.ts, giveAccess) is a whole page with
 * its subject as the title (WCAG 2.4.2) and the store's language on <html>
 * (3.1.1), not a bare <div>. Synthetic words; nothing is sent.
 */
import { accessLetterHtml } from "@/lib/api-write";
import { done, is } from "./check";

const html = accessLetterHtml({ language: "de" }, "Harbor Kitchen hat dir The Guide geschenkt.\n\nÖffne es hier:\nhttps://example.com/orders", "Harbor Kitchen: The Guide <für dich>");
is("the letter opens as a whole page with its charset and the store's language", /^<!doctype html><html lang="de-DE"><head><meta charset="utf-8">/.test(html), true);
is("the letter's title is its subject, escaped", html.match(/<title>([^<]*)<\/title>/)?.[1] ?? null, "Harbor Kitchen: The Guide &lt;für dich&gt;");
is("the letter keeps a paragraph a block and a line break a line", html.includes("<p>Öffne es hier:<br>https://example.com/orders</p>"), true);
is("the letter's words keep their language mark too", html.includes('<div lang="de-DE"'), true);
is("the letter closes as a page", html.trim().endsWith("</body></html>"), true);

done();
