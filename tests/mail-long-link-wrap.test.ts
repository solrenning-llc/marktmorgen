/**
 * AX274 item 5 (emails), WCAG 1.4.10 Reflow: an email reads on a 320 px phone
 * without scrolling sideways. Chromium on an emulated iPhone 13, 13 November 2026:
 * the "moved event" email's link to the event page,
 * https://marktmorgen.com/@harbor/community/events/abc, ran to 486 px on a 390 px
 * screen. A web address written in an email's text becomes a link whose words are
 * the address itself (lib/mail-body.ts, linked), and an address has no space to
 * break at, so every store email with a long address in its text scrolled sideways
 * on a phone: list emails, sequences, waitlist, reviews, product updates, community
 * posts and the event notices all draw their text through bodyHtml.
 *
 * What must hold: a link drawn from an address may break anywhere; the creator's
 * words around it, its colour and its underline are unchanged, and a button keeps
 * its own look. The plain-text version is not touched.
 */
import { bodyHtml, bodyText } from "@/lib/mail-body";
import { done, is, part } from "./check";

const LONG = "https://marktmorgen.com/@harbor/community/events/0123456789abcdef0123456789abcdef";
const body = `Read it at ${LONG} and tell me.\n\n- See ${LONG}\n\n[Get the guide](https://example.com/guide)`;
const html = bodyHtml(body);
const links = [...html.matchAll(/<a href="([^"]*)" style="([^"]*)">([^<]*)<\/a>/g)].map((m) => ({ href: m[1], style: m[2], text: m[3] }));

part("A link drawn from an address may break anywhere");
const fromAddress = links.filter((l) => l.text === LONG);
is("both addresses in the text and the list are links", fromAddress.length, 2);
for (const [i, l] of fromAddress.entries()) {
  is(`address link ${i + 1} breaks anywhere`, /word-break:break-all/.test(l.style) && /overflow-wrap:anywhere/.test(l.style), true);
  is(`address link ${i + 1} keeps its colour and underline`, /color:#4c1d95/.test(l.style) && /text-decoration:underline/.test(l.style), true);
}

part("A button and the words around are unchanged");
const button = links.find((l) => l.text === "Get the guide");
is("the button does not break its words", button ? /word-break/.test(button.style) : "no button", false);
is("the creator's words are still there", html.includes("Read it at ") && html.includes(" and tell me."), true);
is("the text version still carries the whole address", bodyText(body).includes(`Read it at ${LONG} and tell me.`), true);

done();
