/**
 * CodeQL js/incomplete-multi-character-sanitization and js/bad-tag-filter in
 * lib/: HTML turned into plain words never keeps a tag of the markup, however
 * the tags were nested or left open; entities are read once, after the markup
 * is gone, as the page's own text; a script, a style or a comment ends where a
 * browser ends it; a button's words lose a price however it was written.
 * Synthetic text only.
 */
import { htmlToPlainText, replaceUntilStable, withoutTags } from "@/lib/plain-text";
import { pageText } from "@/lib/outreach-rules";
import { readSequenceCsv } from "@/lib/sequence-import";
import { trimSavedPage, convertSavedPage } from "@/lib/clickfunnels-page";
import { withoutButtonPrice } from "@/lib/funnel-ai-rules";
import { done, is, part } from "./check";

const opensTag = (text: string) => /<[A-Za-z!?/]/.test(text);
const decode = (text: string) => text.replace(/&(amp|lt|gt);/g, (_, name: string) => ({ amp: "&", lt: "<", gt: ">" })[name] ?? "");

part("One way from HTML to plain words");
is("tags nested to rebuild a tag after one pass are all taken out", opensTag(withoutTags("<scr<b>ipt>alert(1)</scr<i>ipt>")), false);
is("a tag joined back by taking another out is taken out too", withoutTags("<<b>script>alert(1)<</b>/script>Hi"), "alert(1)Hi");
is("a tag is read up to its first >, as a browser reads it", [withoutTags("<scr<b>ipt>Hi"), withoutTags('<a title="x<y">Go</a>')], ["ipt>Hi", "Go"]);
is("a tag left open at the end does not survive", opensTag(withoutTags("Hello <script")), false);
is("ordinary text keeps its comparison signs", withoutTags("5 < 10 and 3 > 2"), "5 < 10 and 3 > 2");
is("each tag gives way to the gap asked for", withoutTags("<p>One</p><p>Two</p>", " "), " One  Two ");
is("markup taken out first, then entities read once: an escaped tag is the page's text, not a tag read again", htmlToPlainText("<p>&lt;b&gt;</p><<i>script>x", { decode }), "<b>x");
is("entities are read once: &amp;lt; stays &lt;", htmlToPlainText("Tom &amp;lt; Jerry &amp; co", { decode }), "Tom &lt; Jerry & co");
is("a decoded sign that opens no tag stays", htmlToPlainText("<b>5 &lt; 10</b> &lt;3", { decode }), "5 < 10 <3");
is("a replacement repeats until nothing changes", replaceUntilStable("aaab", /ab/g, "b"), "b");

part("A business's page as words (lib/outreach-rules.ts)");
is("nested tags do not rebuild a script tag", opensTag(pageText("<scr<b>ipt>x</scr<b>ipt> Contact us")), false);
is("a script closed with a space or an attribute is still a script", pageText("<script>var a = 1;</script >Hi<style>p{}</style foo>there"), "Hi there");
is("a comment closed the way a browser closes it", pageText("<!-- hidden --!>Shown"), "Shown");
is("an address in a mailto link is still kept", pageText('<a href="mailto:hi%40shop.example">Write</a>'), "hi@shop.example Write");

part("A sequence's subject from another service (lib/sequence-import.ts)");
const csv = (subject: string) => `order,days_after,subject,preview,body\n1,0,"${subject}",,Hello there\n`;
const subjectOf = (subject: string) => {
  const read = readSequenceCsv(csv(subject));
  return read.ok ? read.steps[0]?.subject ?? "" : `refused:${read.why}`;
};
is("nested tags do not rebuild a tag in a subject", opensTag(subjectOf("<scr<b>ipt>Welcome")), false);
is("a tag left open at the end of a subject goes", opensTag(subjectOf("Welcome <img src=x")), false);
is("an ordinary subject is unchanged", subjectOf("Welcome &amp; thanks"), "Welcome & thanks");

part("A saved page made small (lib/clickfunnels-page.ts)");
is("a script closed with an attribute is emptied, the rest kept", trimSavedPage("<script>var big = 1;</script foo>After"), "<script></script>After");
is("a comment closed with --!> goes, the rest kept", trimSavedPage("<!-- note --!><p>Kept</p>"), "<p>Kept</p>");
const whole = "<html><body><!-- a --!><h1>Title here</h1><p>Words to keep.</p></body></html>";
is("reading the trimmed page gives the same draft as reading the whole one", JSON.stringify(convertSavedPage(trimSavedPage(whole))), JSON.stringify(convertSavedPage(whole)));
is("the reader ends a comment where a browser does", JSON.stringify(convertSavedPage(whole)).includes("Title here"), true);

part("A button's words never state a price (lib/funnel-ai-rules.ts)");
is("a price is taken out", withoutButtonPrice("See the course for $99"), "See the course");
is("a price rebuilt by taking another out is taken out too (one pass would leave $9)", [withoutButtonPrice("Get it$5.$9"), "Get it$5.$9".replace(/\s*\b(?:for|at|only)?\s*[$€£¥]\s*\d[\d.,]*/gi, "")], ["Get it", "Get it$9"]);
is("a button with no price is unchanged", withoutButtonPrice("Get the guide"), "Get the guide");

done();
