/**
 * AX274 (3.1.5 Reading Level, and the W3C guidance for cognitive and learning
 * disabilities), for the public API documentation: its sentences are short
 * enough to follow. Chromium on 13 November 2026 read 40 sentences of 35 words
 * or more on /developers and /developers/checkout-script. Ten are left for now,
 * because an open pull request changes the same sentence (#3396, #1929, #3661,
 * #3252), and two are code (an HTML snippet and a script), not prose. The other
 * 26 are split, saying the same things, with no number, code name, limit or
 * promise changed; the words are now in two or three sentences.
 *
 * What must hold: on each rendered page, the sentence that starts with each
 * phrase below is under 35 words.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DevelopersPage from "@/app/developers/page";
import CheckoutScriptPage from "@/app/developers/checkout-script/page";
import { done, is, part } from "./check";

const LIMIT = 35;
const words = (s: string) => s.match(/[A-Za-z']+/g)?.length ?? 0;
const text = (html: string) =>
  html
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/pre|\/div)[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&apos;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ");

/** The sentence that starts at `start`, up to the first full stop followed by a space or a line's end. */
function sentence(page: string, start: string): string | null {
  const at = page.indexOf(start);
  if (at < 0) return null;
  const rest = page.slice(at);
  const end = rest.search(/\.(\s|$)/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

async function main() {
  const developers = text(renderToStaticMarkup(createElement(DevelopersPage)));
  const script = text(renderToStaticMarkup((await CheckoutScriptPage()) as never));

  for (const [name, page, starts] of [
    ["/developers", developers, [
      "Products never has more",
      "A page can also come back empty before the last one",
      "A field no row has is answered 400",
      "A name that cannot be a field",
      "A key made by someone who then leaves the team",
      "A key made by someone whose role no longer allows it",
      "While the store's plan renewal is unpaid",
      "If the course changes while you page through it",
      "Read anew, it reads 180 days of counts",
      "A copy of the numbers is then kept for an hour",
      "Within that hour, a read comes from the copy",
      "An assistant that speaks the Model Context Protocol",
      "It changes nothing, and it does not read anybody's name or address",
      "What an assistant reads is kept by whoever runs the assistant",
      "They open it from your store's list of purchases",
      "amount_cents is what the buyer paid at checkout",
      "It is in the currency's smallest unit",
      "paid_at is when the buyer paid",
      "Products checked at checkout are in order_bumps",
      "A one-click extra taken after the checkout",
      "For a one-time payment they are read from its charge",
      "Go on until a sale's",
      "To keep a copy in step, read again from the top each time",
      "Texts are cut to a fixed length",
      "To sell from your own site, no key is needed or allowed in a web page",
      "opens a product's card or your sign-up form over your page",
    ]],
    ["/developers/checkout-script", script, [
      "it opens the card in a frame over your page instead",
      "return is the page the receipt sends the buyer back to",
      "via is an affiliate's code",
      "On any other site, or when the browser sends no address of the page",
      "The frame knows which site it is on",
      "The script asks for the site's origin only",
      "Anybody can make a page say them",
      "sale.completed now carries source",
      "list.joined is sent when somebody confirms their address",
      "It does not pick one of a product's price options for the buyer",
    ]],
  ] as const) {
    part(`${name}: each long sentence is now under ${LIMIT} words`);
    for (const start of starts) {
      const s = sentence(page, start);
      const n = s === null ? Infinity : words(s);
      is(`"${start}…" has fewer than ${LIMIT} words (now ${s === null ? "not found" : n})`, n < LIMIT, true);
    }
  }
  done();
}

void main();
