/**
 * AX274 Part A, item 5: every HTML email is a whole page, so a screen reader
 * announces what it is before reading it. WCAG 2.4.2 (Page Titled) asks for a
 * title that says what the page is; 3.1.1 (Language of Page) asks for the
 * language on <html>, not only on a <div> inside it. Synthetic text only;
 * nothing is sent.
 */
import { letterHtml as closingLetterHtml } from "@/lib/closing-buyers-rules";
import { emailDocument } from "@/lib/email-document";
import { letterHtml as importLetterHtml } from "@/lib/imports";
import { done, is } from "./check";

function titleOf(html: string): string | null {
  return html.match(/<title>([^<]*)<\/title>/)?.[1] ?? null;
}
function langOf(html: string): string | null {
  return html.match(/<html lang="([^"]+)"/)?.[1] ?? null;
}
const whole = (html: string) =>
  /^<!doctype html><html lang="[^"]+"><head><meta charset="utf-8">/.test(html) && /<\/body><\/html>$/.test(html.trim());

// The shared shell: language, charset, viewport and the subject as the title, escaped.
const page = emailDocument({ lang: "de-DE", title: "Kurs <neu> & \"frei\"", body: "<p>Hallo</p>" });
is("the shell is a whole document with its charset", whole(page), true);
is("the shell carries the language on <html>", langOf(page), "de-DE");
is("the title is the subject, escaped", titleOf(page), "Kurs &lt;neu&gt; &amp; &quot;frei&quot;");
is("the shell reflows on a phone", page.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'), true);
is("the body is kept as given", page.includes("<p>Hallo</p>"), true);
is("an empty subject still gives a title", titleOf(emailDocument({ lang: "en-US", title: "   ", body: "" })), "Email");

// The store-closing letter (a service email in US English).
const closing = closingLetterHtml("Your store is closing.\n\nRead more at https://example.com/x", "1 Main St, Dover, DE", "A store you bought from is closing");
is("the closing letter is a whole document", whole(closing), true);
is("the closing letter's title is its subject", titleOf(closing), "A store you bought from is closing");
is("the closing letter says US English on <html>", langOf(closing), "en-US");
is("the closing letter keeps its link", closing.includes('<a href="https://example.com/x"'), true);

// The import letters (moved purchases, member invitations), in the store's language.
const moved = importLetterHtml({ language: "pt" }, "Sua compra mudou.\n\nAbra em https://example.com/o", "Sua compra foi movida");
is("the import letter is a whole document, not a bare <div>", whole(moved), true);
is("the import letter's title is its subject", titleOf(moved), "Sua compra foi movida");
is("the import letter carries the store's language on <html>", langOf(moved), "pt-PT");
is("the import letter keeps a paragraph for each block", moved.includes("<p>Sua compra mudou.</p>"), true);

done();
