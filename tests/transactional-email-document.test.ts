/**
 * AX274 Part A, item 5: every transactional email is accessible HTML with a
 * text version. Three emails sent a bare fragment (a `<div>` of paragraphs) or
 * a document without a title: the access an API gave, the "your purchase
 * moved" and member invitation letters, and the store-closing letter. Each is
 * now a whole document: doctype, `lang` (3.1.1), a `<title>` from the subject
 * (2.4.2), the character set, a viewport (1.4.10), one named article, and every
 * text color at 7:1 or more on every background the email paints (1.4.6).
 */
import { letterHtml as closingLetterHtml } from "@/lib/closing-buyers-rules";
import { letterHtml as importLetterHtml } from "@/lib/imports";
import { givenEmailHtml } from "@/lib/api-write";
import { emailDocument, emailParagraphs } from "@/lib/email-document";
import { done, is, part } from "./check";

function luminance(hex: string): number {
  const v = hex.replace("#", "");
  const full = v.length === 3 ? [...v].map((c) => c + c).join("") : v;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The lowest contrast between any text color the email sets and any background it paints (white when none). */
function worstContrast(html: string): number {
  const inks = [...html.matchAll(/(?<![-\w])color:\s*(#[0-9a-fA-F]{3,6})\b/g)].map((m) => m[1]);
  const papers = [...html.matchAll(/background(?:-color)?:\s*(#[0-9a-fA-F]{3,6})\b/g)].map((m) => m[1]);
  const grounds = papers.length ? papers : ["#ffffff"];
  return Math.min(...inks.flatMap((ink) => grounds.map((ground) => ratio(ink, ground))));
}

function wholeDocument(name: string, html: string, lang: string, subject: string): void {
  is(`${name}: starts with a doctype`, /^<!doctype html>/i.test(html), true);
  is(`${name}: the document says its language`, new RegExp(`<html lang="${lang}"`).test(html), true);
  is(`${name}: the character set is said`, html.includes('<meta charset="utf-8">'), true);
  is(`${name}: a viewport for a small screen`, html.includes('name="viewport"'), true);
  is(`${name}: the subject is the title`, html.match(/<title>([^<]*)<\/title>/)?.[1], subject);
  is(`${name}: one named article`, /role="article"[^>]*aria-label="[^"]+"/.test(html), true);
  is(`${name}: every text color reads at 7:1 or more`, worstContrast(html) >= 7, true);
  is(`${name}: no image of text`, /<img\b/i.test(html), false);
}

part("the plain email document");
{
  const html = emailDocument({ lang: "pt-BR", title: "Seu pedido <chegou>\r\n", body: emailParagraphs("Olá\nMaria\n\nObrigado") });
  wholeDocument("plain", html, "pt-BR", "Seu pedido &lt;chegou&gt;");
  is("paragraphs and line breaks kept", html.includes("Olá<br>Maria</p>") && html.includes("Obrigado</p>"), true);
  is("an empty language falls back to US English", emailDocument({ lang: " ", title: "t", body: "" }).includes('<html lang="en-US"'), true);
}

part("the store-closing letter");
{
  const html = closingLetterHtml("A store is closing.\n\nDownload at https://example.test/x", "1 Main St, Dover, DE", "Your store is closing");
  wholeDocument("closing", html, "en", "Your store is closing");
  is("closing: its link is a link", html.includes('<a href="https://example.test/x"'), true);
  is("closing: the postal address stays", html.includes("Marktmorgen, 1 Main St, Dover, DE"), true);
}

part("the moved-purchase and invitation letters");
{
  const html = importLetterHtml({ language: "de" }, "Dein Kauf ist umgezogen", "Hallo\n\nDein Kurs: https://example.test/c");
  wholeDocument("import", html, "de-DE", "Dein Kauf ist umgezogen");
  is("import: the words stay", html.includes("Dein Kurs: https://example.test/c"), true);
}

part("the access an API gave");
{
  const html = givenEmailHtml({ language: "en" }, "You have access to Course", "Hi\n\nOpen: https://example.test/o");
  wholeDocument("api give", html, "en-US", "You have access to Course");
}

done();
