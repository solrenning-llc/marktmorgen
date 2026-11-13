/**
 * Which links of an email can be changed after it is sent, and how they are
 * written in it (124 [F2-EDIT-SENT-LINKS], unit 3a: lib/mail-body.ts
 * bodyButtons, and bodyHtml / bodyText with buttonTo).
 *
 * Only buttons: their words are a label, never an address. An address
 * written in the text shows itself as the link's words, and a link whose
 * words are one address while it goes to another is what mail filters take
 * for phishing, and would mislead the reader once changed.
 *
 * What fails here:
 *   - an address in the text sent through anything but itself (and its tag);
 *   - a button numbered differently in the HTML, the text and the list the
 *     studio edits from;
 *   - the text version of a button left at an address the email does not use;
 *   - an email that does not choose this changed at all.
 */
import { bodyButtons, bodyHtml, bodyText } from "@/lib/mail-body";
import { MAX_SENT_LINKS } from "@/lib/sent-link-rules";
import { done, is, part } from "./check";

const body = [
  "# Spring classes",
  "Read the plan at https://example.com/plan.",
  "[Book a seat](https://example.com/book)",
  "- Or see https://example.com/faq",
  "[Gift a class](https://example.com/gift)",
  "[Book a seat](https://example.com/book)",
].join("\n\n");

const to = (href: string, n: number) => `https://marktmorgen.com/r/S/E/${n}?u=${encodeURIComponent(href)}`;

part("The buttons, in order");
is("each button's address, in order, one a button", bodyButtons(body), ["https://example.com/book", "https://example.com/gift", "https://example.com/book"]);
is("an email with none", bodyButtons("Just words, https://example.com/x"), []);

part("In the HTML");
const html = bodyHtml(body, undefined, undefined, undefined, to);
is("each button through its own number", [0, 1, 2].every((n) => html.includes(`href="${to(["https://example.com/book", "https://example.com/gift", "https://example.com/book"][n], n).replace(/&/g, "&amp;")}"`)), true);
is("an address in the text goes to itself", html.includes('href="https://example.com/plan"') && html.includes('href="https://example.com/faq"'), true);
is("the button's words unchanged", html.includes(">Book a seat</a>") && html.includes(">Gift a class</a>"), true);
const tagged = bodyHtml(body, (href) => `${href}?utm_source=x`, undefined, undefined, to);
// Review of #3715: the HTML, the text and the studio sign the same untagged original, so nothing of one reader (a tag with their key) is inside it.
is("a changeable button signs the untagged address, as the text and the studio do", [tagged.includes(encodeURIComponent("https://example.com/book?utm_source=x")), tagged.includes(`href="${to("https://example.com/book", 0).replace(/&/g, "&amp;")}"`)], [false, true]);
is("without buttonTo: exactly as before", bodyHtml(body), bodyHtml(body, undefined, undefined, undefined, undefined));

part("In the text");
const text = bodyText(body, to);
is("each button through its own number, the same as the HTML", text.includes(`Book a seat: ${to("https://example.com/book", 0)}`) && text.includes(`Gift a class: ${to("https://example.com/gift", 1)}`) && text.includes(`Book a seat: ${to("https://example.com/book", 2)}`), true);
is("an address in the text unchanged", text.includes("https://example.com/plan.") && text.includes("https://example.com/faq"), true);
is("without buttonTo: exactly as before", bodyText(body), "Spring classes\n\nRead the plan at https://example.com/plan.\n\nBook a seat: https://example.com/book\n\n- Or see https://example.com/faq\n\nGift a class: https://example.com/gift\n\nBook a seat: https://example.com/book");

part("Only a button whose address can be changed is wrapped (review of #3715)");
const mixed = ["[Ours](https://marktmorgen.com/r/S/E/0?u=x)", "[No dot](https://intranet/page)", "[Book a seat](https://example.com/book)"].join("\n\n");
is("the studio's list holds only the buttons that can be changed", bodyButtons(mixed), ["https://example.com/book"]);
const mixedHtml = bodyHtml(mixed, (href) => `${href}?utm_source=x`, undefined, undefined, to);
is("a button that is already our redirect or has no public host goes to itself, tagged, never through a second redirect", [mixedHtml.includes('href="https://marktmorgen.com/r/S/E/0?u=x?utm_source=x"'), mixedHtml.includes('href="https://intranet/page?utm_source=x"')], [true, true]);
is("the changeable button is number 0 in the HTML and the text, as in the studio's list", [mixedHtml.includes(`href="${to("https://example.com/book", 0).replace(/&/g, "&amp;")}"`), bodyText(mixed, to).includes(`Book a seat: ${to("https://example.com/book", 0)}`)], [true, true]);

part(`At most MAX_SENT_LINKS (${MAX_SENT_LINKS}) buttons can be changed: never one the redirect cannot sign (Claude 1 on #3715, LEVE)`);
const many = Array.from({ length: MAX_SENT_LINKS + 1 }, (_, i) => `[Class ${i}](https://example.com/c${i})`).join("\n\n");
is("the studio's list stops at MAX_SENT_LINKS", bodyButtons(many).length, MAX_SENT_LINKS);
const manyHtml = bodyHtml(many, (href) => `${href}?utm_source=x`, undefined, undefined, to);
is("the last one in the list is wrapped with its number", manyHtml.includes(`href="${to(`https://example.com/c${MAX_SENT_LINKS - 1}`, MAX_SENT_LINKS - 1).replace(/&/g, "&amp;")}"`), true);
is("a button past it goes to its own address, tagged, never numbered past what can be signed", [manyHtml.includes(`/${MAX_SENT_LINKS}?u=`), manyHtml.includes(`href="https://example.com/c${MAX_SENT_LINKS}?utm_source=x"`)], [false, true]);
const manyText = bodyText(many, to);
is("and the same in the text", [manyText.includes(`/${MAX_SENT_LINKS}?u=`), manyText.includes(`Class ${MAX_SENT_LINKS}: https://example.com/c${MAX_SENT_LINKS}`)], [false, true]);

done();
