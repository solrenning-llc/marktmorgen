/**
 * "Words in this answer" (lib/help-glossary.ts, 564 [HC1] item 5, WCAG 3.1.3;
 * added 12 November 2026). Checked with the real answers and the real page
 * drawn on the server:
 *
 *   - every term is used by at least one answer, and no two share a name;
 *   - a term is found only as whole words ("lead to" is not a lead, a
 *     sequenced list is not a sequence), plural or past forms included;
 *   - where another page of the site already explains the same word, the
 *     help says the same thing, word for word;
 *   - each meaning is one or two short sentences;
 *   - an answer's page lists exactly the terms its words use, in a named
 *     section of term and meaning pairs, and a page without any has none.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { HELP_TERMS, termsIn } from "@/lib/help-glossary";
import { HELP_SECTIONS, answerId } from "@/lib/help-content";
import { FEATURE_PAGES, CREATOR_PAGES } from "@/lib/feature-pages";
import { MIGRATION_GUIDES } from "@/lib/migration-guides";
import HelpAnswerPage from "@/app/help/[section]/[answer]/page";
import { done, is, part } from "./check";

const answers = HELP_SECTIONS.flatMap((s) => s.items.map((item) => ({ section: s.id, id: answerId(item.q), text: [item.q, ...item.a].join(" ") })));
const decode = (html: string) => html.replace(/&(?:#x27|quot|amp|lt|gt);/g, (e) => ({ "&#x27;": "'", "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">" })[e] as string);

async function main(): Promise<void> {
  part("Every term is used, once");
  {
    is("every term is in at least one answer", HELP_TERMS.filter((t) => !answers.some((a) => t.words.test(a.text))).map((t) => t.term), []);
    const names = HELP_TERMS.map((t) => t.term.toLowerCase());
    is("no two terms share a name", names.filter((n, i) => names.indexOf(n) !== i), []);
    is("each meaning is one or two short sentences", HELP_TERMS.filter((t) => t.meaning.length > 200 || !/\.$/.test(t.meaning) || (t.meaning.match(/\. /g) ?? []).length > 1).map((t) => t.term), []);
  }

  part("Whole words only");
  {
    const names = (text: string) => termsIn(text).map((t) => t.term);
    is("plural and past forms", names("Two webhooks, a disputed payment and three funnels."), ["Dispute", "Funnel", "Webhook"]);
    is("never inside another word", names("A sequenced list, a workflowish idea, an endpointless road, Pathways."), []);
    is("an abbreviation only in capitals", names("Use the vat and the csv."), []);
    is("sorted by name", names("UTC, JSON and an API key"), ["API key", "JSON", "UTC"]);
  }

  part("The same word means the same thing everywhere on the site");
  {
    const elsewhere = [...FEATURE_PAGES, ...CREATOR_PAGES].flatMap((page) => page.blocks.flatMap((b) => (b.kind === "terms" ? b.items : [])));
    const guides = MIGRATION_GUIDES.flatMap((g) => g.terms);
    const differ = [...elsewhere, ...guides].filter((other) => {
      const mine = HELP_TERMS.find((t) => t.term.toLowerCase() === other.term.toLowerCase());
      return mine && mine.meaning !== other.meaning;
    });
    is("no word explained two ways", differ.map((d) => d.term), []);
    is("and the comparison really reads other glossaries", ["Webhook", "UTC", "CSV file"].every((t) => [...elsewhere, ...guides].some((o) => o.term === t)), true);
  }

  part("On an answer's page");
  {
    const webhook = answers.find((a) => a.id === "how-do-i-tell-zapier-make-or-my-own-server-when-something-happens-in-my-store");
    if (!webhook) throw new Error("the webhook answer is gone");
    const html = decode(renderToStaticMarkup(await HelpAnswerPage({ params: Promise.resolve({ section: webhook.section, answer: webhook.id }) })));
    const box = html.match(/<section[^>]*data-help-terms[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? "";
    is("a section named by its own heading", /aria-labelledby="help-terms-title"/.test(html) && box.includes('<h2 id="help-terms-title"') && box.includes(">Words in this answer</h2>"), true);
    const pairs = [...box.matchAll(/<dt[^>]*>([^<]+)<\/dt><dd[^>]*>([^<]+)<\/dd>/g)].map((m) => [m[1], m[2]]);
    is("exactly the terms the answer uses, each with its meaning", pairs, termsIn(webhook.text).map((t) => [t.term, t.meaning]));
    is("which for this answer include the webhook words", ["Catch Hook", "Endpoint", "JSON", "Signing secret", "Webhook"].every((t) => pairs.some((p) => p[0] === t)), true);
    const plain = answers.find((a) => termsIn(a.text).length === 0);
    if (!plain) throw new Error("every answer uses a term");
    const none = renderToStaticMarkup(await HelpAnswerPage({ params: Promise.resolve({ section: plain.section, answer: plain.id }) }));
    is("an answer with no unusual word has no such section", none.includes("data-help-terms"), false);
    is("it is in the page as the server draws it, before any script runs", html.includes("data-help-terms"), true);
  }

  done();
}

void main();
