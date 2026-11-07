/**
 * 561 [NE1] (owner, 30 October 2026, 02:58 Fortaleza): a notice that
 * Marktmorgen promises no sales, income or result, in the footer of every
 * public page and in its own section of the Terms. Checked on the real
 * components, rendered:
 *
 *   - the full footer (every page but the home page and the log-in pages)
 *     shows the whole notice above the copyright line and links to the Terms
 *     section by words that say where they go (2.4.9);
 *   - the log-in pages' slim footer shows the whole notice, as text only, so
 *     nothing pulls a person out of logging in;
 *   - the home page's footer shows the sentence that carries the promise and
 *     adds no link (498 [ME3]: at most 30 links, 600 words);
 *   - the Terms hold the same three sentences in their own numbered section,
 *     under the fixed anchor, with the sections after it renumbered in order;
 *   - every footer on the site is this component, so "every page" holds;
 *   - nothing in the notice names a figure, a customer result or a testimonial;
 *   - the two sentences that read as a promise of earnings are gone.
 */
import { readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteFooter } from "@/components/site-footer";
import TermsPage from "@/app/terms/page";
import { FEATURE_PAGES } from "@/lib/feature-pages";
import {
  EARNINGS_NOTICE,
  EARNINGS_NOTICE_ANCHOR,
  EARNINGS_NOTICE_HREF,
  EARNINGS_NOTICE_SHORT,
  EARNINGS_NOTICE_TEXT,
} from "@/lib/earnings-notice";
import { done, is, part } from "./check";

const decode = (html: string) =>
  html.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => decode(m[1]));
const words = (s: string) => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;

function main(): void {
  part("The notice itself");
  is("three short sentences", EARNINGS_NOTICE.length, 3);
  is("each sentence at most 16 words (plain language, 3.1.5)", EARNINGS_NOTICE.every((s) => words(s) <= 16), true);
  is("it says no promise of sales, income or any result", /no promise .*sales, income or any result/.test(EARNINGS_NOTICE_TEXT), true);
  is("the short form says the same promise", /no promise of sales, income or any result/.test(EARNINGS_NOTICE_SHORT), true);
  is("no figure, testimonial or customer result in it", /\d|testimonial|customers? (made|earned)/i.test(EARNINGS_NOTICE_TEXT + EARNINGS_NOTICE_SHORT), false);
  is("it points at the Terms section", EARNINGS_NOTICE_HREF, "/terms#no-earnings-claims");

  part("The full footer");
  for (const morning of [false, true]) {
    const html = renderToStaticMarkup(SiteFooter({ morning }));
    const copy = text(html);
    const at = copy.indexOf(EARNINGS_NOTICE_TEXT);
    is(`shows the whole notice (morning ${morning})`, at >= 0, true);
    is(`above the copyright line (morning ${morning})`, at >= 0 && at < copy.indexOf("©"), true);
    is(`links to the Terms section (morning ${morning})`, hrefs(html).includes(EARNINGS_NOTICE_HREF), true);
    const link = html.match(new RegExp(`<a [^>]*href="${EARNINGS_NOTICE_HREF}"[^>]*>([^<]+)</a>`));
    is(`the link's words say where it goes (morning ${morning})`, link ? /Terms/.test(link[1]) && /earnings/i.test(link[1]) : false, true);
    is(`the link is at least 44px tall (morning ${morning})`, link ? /min-h-11/.test(link[0]) : false, true);
  }

  part("The log-in pages' slim footer");
  const slim = renderToStaticMarkup(SiteFooter({ variant: "slim" }));
  is("shows the whole notice", text(slim).includes(EARNINGS_NOTICE_TEXT), true);
  is("above the copyright line", text(slim).indexOf(EARNINGS_NOTICE_TEXT) < text(slim).indexOf("©"), true);
  is("adds no link", hrefs(slim).includes(EARNINGS_NOTICE_HREF), false);

  part("The home page's footer");
  const home = renderToStaticMarkup(SiteFooter({ variant: "home", morning: true }));
  is("shows the sentence that carries the promise", text(home).includes(EARNINGS_NOTICE_SHORT), true);
  is("above the copyright line", text(home).indexOf(EARNINGS_NOTICE_SHORT) < text(home).indexOf("©"), true);
  is("still 13 links: none added to the home page", hrefs(home).length, 13);
  is("at most 12 words added", words(EARNINGS_NOTICE_SHORT) <= 12, true);

  part("Every footer is this one");
  const pages = ["app", "components"].flatMap((dir) =>
    readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".tsx")).map((f) => `${dir}/${f}`),
  );
  const others = pages.filter((f) => f !== "components/site-footer.tsx" && /<footer[\s>]/.test(readFileSync(f, "utf8")) && !f.startsWith("components/community"));
  is("no other page draws a site footer of its own", others, []);

  part("The Terms");
  const terms = renderToStaticMarkup(TermsPage());
  const section = terms.match(new RegExp(`<section id="${EARNINGS_NOTICE_ANCHOR}"[\\s\\S]*?</section>`));
  is("a section under the fixed anchor", section !== null, true);
  is("titled as its own numbered section", section ? text(section[0]).includes("12. No promise of earnings") : false, true);
  is("holding the same three sentences", section ? text(section[0]).includes(EARNINGS_NOTICE_TEXT) : false, true);
  const titles = [...terms.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => decode(m[1]));
  const numbers = titles.map((t) => Number(t.match(/^(\d+)\./)?.[1] ?? NaN)).filter((n) => !Number.isNaN(n));
  is("the sections are numbered 1 to 18 in order", numbers, Array.from({ length: 18 }, (_, i) => i + 1));
  is("the anchors of the sections after it do not move", ["limitation-of-liability", "governing-law", "contact", "closing", "invites"].every((id) => terms.includes(`id="${id}"`)), true);

  part("Sentences that read as a promise of earnings");
  is("the checkout tools page no longer says 'Earn more from every buyer'", JSON.stringify(FEATURE_PAGES).includes("Earn more from every buyer"), false);
  is("the Scale card no longer says its room is for 'more sales'", readFileSync("components/home-parts.tsx", "utf8").includes("for a bigger list and more sales"), false);
}

main();
done();
