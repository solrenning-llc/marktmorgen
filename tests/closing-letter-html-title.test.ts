/**
 * AX274 (WCAG 2.2 2.4.2 Page Titled, applied to an email's HTML part): the letter a store's buyers get when it
 * closes is a whole HTML document, with its language and readable layout, but it had no title, so an email
 * program or a screen reader that opens the HTML part on its own named it by nothing. It now carries the
 * letter's subject as its title, escaped. The words of the letter do not change.
 */
import { readFileSync } from "node:fs";
import { letterHtml } from "@/lib/closing-buyers-rules";
import { done, is, part } from "./check";

part("The closing letter's HTML is titled by its subject");
const html = letterHtml("Hello.\n\nGoodbye.", "1 Main St", "Fay's Shop is closing <soon>");
is("a title in the head", /<head>[\s\S]*<title>Fay&#39;s Shop is closing &lt;soon&gt;<\/title>[\s\S]*<\/head>/.test(html) || /<head>[\s\S]*<title>Fay's Shop is closing &lt;soon&gt;<\/title>[\s\S]*<\/head>/.test(html), true);
is("the words are unchanged", html.includes("<p style=\"margin:0 0 16px\">Hello.</p>") && html.includes("Goodbye."), true);
is("its language stays marked", html.includes('<html lang="en">'), true);
is("the sender passes the subject", readFileSync("lib/closing-buyers.ts", "utf8").includes("letterHtml(letter.text, postal, letter.subject)"), true);

done();
