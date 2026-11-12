/**
 * A page of its own for each section and each answer of the help center
 * (lib/help-pages.ts, app/help/[section], app/help/[section]/[answer]; 564
 * [HC1], second complement; added 12 November 2026). Checked with the real
 * content and the real pages drawn on the server:
 *
 *   - every section and every answer has exactly one address, and the
 *     sitemap lists them all;
 *   - an answer page has the trail (Help center › section › the question,
 *     marked current), the question as its only h1, the answer word for word,
 *     its own title and description, and the other answers of its section;
 *   - a section page links every answer with its first line;
 *   - an unknown section or answer is "not found", never another page;
 *   - the summary is the answer's own first sentence, or its first words cut
 *     at a word, never longer than a search result shows;
 *   - each answer on /help links to its own page, and the old /help#id
 *     anchors stay.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HELP_SECTIONS, answerId } from "@/lib/help-content";
import { SUMMARY_CHARS, answerSummary, helpAnswer, helpAnswerPath, helpPagePaths } from "@/lib/help-pages";
import HelpSectionPage, { generateMetadata as sectionMeta } from "@/app/help/[section]/page";
import HelpAnswerPage, { generateMetadata as answerMeta, generateStaticParams as answerParams } from "@/app/help/[section]/[answer]/page";
import HelpPage from "@/app/help/page";
import sitemap from "@/app/sitemap";
import { NotFoundError } from "./help-pages-navigation";
import { done, is, part } from "./check";

const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

async function main(): Promise<void> {
  const answers = HELP_SECTIONS.flatMap((s) => s.items.map((item) => ({ section: s.id, id: answerId(item.q), item })));

  part("One address each, all in the sitemap");
  {
    const paths = helpPagePaths();
    is("a page per section and per answer", paths.length, HELP_SECTIONS.length + answers.length);
    is("no two answers share an address", new Set(answers.map((a) => helpAnswerPath(a.section, a.id))).size, answers.length);
    is("the static answer pages are exactly the answers", answerParams().length, answers.length);
    const urls = sitemap().map((entry) => entry.url);
    is("the sitemap lists every section page and every answer page", paths.filter((p) => !urls.some((u) => u.endsWith(p.answer ? `/help/${p.section}/${p.answer}` : `/help/${p.section}`))).length, 0);
    is("no section id takes an existing help page's address", HELP_SECTIONS.filter((s) => ["buyers", "zoom"].includes(s.id)).length, 0);
  }

  part("An answer's page");
  {
    const first = answers.find((a) => a.id === "can-i-sell-a-course")!;
    const html = decode(renderToStaticMarkup(await HelpAnswerPage({ params: Promise.resolve({ section: first.section, answer: first.id }) })));
    is("the trail: Help center, then the section, then the question marked current", [html.includes('<nav aria-label="Breadcrumb"'), html.includes('href="/help"'), html.includes(`href="/help/${first.section}"`), html.includes(`aria-current="page">${first.item.q}</li>`)], [true, true, true, true]);
    is("the question is the page's only h1", (html.match(/<h1/g) ?? []).length === 1 && html.includes(`>${first.item.q}</h1>`), true);
    is("the answer word for word", first.item.a.every((p) => html.includes(p)), true);
    is("the other answers of its section, linked, and not itself", [html.includes("More in "), html.includes(`href="${helpAnswerPath(first.section, first.id)}"`)], [true, false]);
    const meta = await answerMeta({ params: Promise.resolve({ section: first.section, answer: first.id }) });
    is("its own title, description and canonical address", [meta.title, meta.description, (meta.alternates as { canonical: string }).canonical], [`${first.item.q} — Marktmorgen Help`, answerSummary(first.item.a), helpAnswerPath(first.section, first.id)]);
  }

  part("A section's page");
  {
    const section = HELP_SECTIONS.find((s) => s.id === "delivery")!;
    const html = decode(renderToStaticMarkup(await HelpSectionPage({ params: Promise.resolve({ section: section.id }) })));
    is("every answer of the section linked, with its first line", section.items.every((item) => html.includes(`href="${helpAnswerPath(section.id, answerId(item.q))}"`) && html.includes(answerSummary(item.a))), true);
    is("the trail and the title", [html.includes(`aria-current="page">${section.title}</li>`), html.includes(`>${section.title}</h1>`)], [true, true]);
    const meta = await sectionMeta({ params: Promise.resolve({ section: section.id }) });
    is("its own title and description", [meta.title, meta.description], [`${section.title} · Help center — Marktmorgen`, section.blurb]);
  }

  part("Not found is not found");
  {
    const missing = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return "drawn";
      } catch (error) {
        return error instanceof NotFoundError ? "not found" : String(error);
      }
    };
    is("an unknown section", await missing(() => HelpSectionPage({ params: Promise.resolve({ section: "nope" }) })), "not found");
    is("an unknown answer", await missing(() => HelpAnswerPage({ params: Promise.resolve({ section: "money", answer: "nope" }) })), "not found");
    is("a real answer under the wrong section", await missing(() => HelpAnswerPage({ params: Promise.resolve({ section: "money", answer: "can-i-sell-a-course" }) })), "not found");
    is("and the rules say so", [helpAnswer("money", "can-i-sell-a-course"), helpAnswer("nope", "x")], [null, null]);
  }

  part("Summaries");
  {
    is("the first sentence when it fits", answerSummary(["Yes. Then more words follow here."]), "Yes.");
    const long = answerSummary(["A ".repeat(200)]);
    is(`never over ${SUMMARY_CHARS} characters, cut at a word`, [[...long].length <= SUMMARY_CHARS, long.endsWith("…")], [true, true]);
    is("every real answer's summary fits and is its own words", answers.every((a) => [...answerSummary(a.item.a)].length <= SUMMARY_CHARS && a.item.a[0].replace(/\s+/g, " ").startsWith(answerSummary(a.item.a).replace(/…$/, ""))), true);
  }

  part("From /help");
  {
    const html = renderToStaticMarkup(createElement(HelpPage));
    is("each answer links to its own page", answers.every((a) => html.includes(`href="${helpAnswerPath(a.section, a.id)}"`)), true);
    is("the old anchors stay", answers.every((a) => html.includes(`id="${a.id}"`)), true);
  }
  done();
}

void main();
