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
 *     anchors stay;
 *   - "Copy link" and "Print" on an answer's page work once scripts run and
 *     are not offered before; printed, the answer stands alone.
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
import { readFileSync } from "node:fs";
import Link from "next/link";
import { HelpAnswerTools } from "@/components/help-answer-tools";
import { HelpTopics } from "@/components/help-topics";
import { filterTopics } from "@/lib/help-topics-rules";
import { helpTopics } from "@/lib/help-pages";
import { HELP_AREAS } from "@/lib/help-areas";
import { find, mount, texts } from "./client-hooks";
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
    const more = html.slice(html.indexOf('aria-labelledby="help-more-title"'), html.indexOf("</nav>", html.indexOf('aria-labelledby="help-more-title"')));
    is("the other answers of its section, linked, and not itself", [more.includes("More in "), more.includes(`href="${helpAnswerPath(first.section, first.id)}"`)], [true, false]);
    is("the side list marks this answer as the current page", html.includes(`aria-current="page" class="inline-flex min-h-11 items-center text-[0.9375rem] underline-offset-4 hover:underline font-semibold text-ink" href="${helpAnswerPath(first.section, first.id)}"`) || new RegExp(`href="${helpAnswerPath(first.section, first.id)}"[^>]*aria-current="page"|aria-current="page"[^>]*href="${helpAnswerPath(first.section, first.id)}"`).test(html), true);
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

  part("Copy link and Print");
  {
    const page = renderToStaticMarkup(await HelpAnswerPage({ params: Promise.resolve({ section: "delivery", answer: "does-the-download-link-expire" }) }));
    is("before scripts run, nothing that could not work is offered", page.includes("data-help-answer-tools"), false);
    const g = globalThis as unknown as { window?: unknown; navigator?: unknown };
    const copied: string[] = [];
    let printed = 0;
    g.window = { location: { origin: "https://marktmorgen.com", pathname: "/help/delivery/does-the-download-link-expire" }, print: () => (printed += 1) };
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (t: string) => void copied.push(t) } }, configurable: true });
    const shown = await mount(HelpAnswerTools, {});
    const buttons = find(shown.tree(), (n) => n.type === "button");
    is("two buttons, named for what they do", buttons.map((b) => texts(b).join("").trim()), ["Copy link", "Print"]);
    await (buttons[0].props?.onClick as () => Promise<void>)();
    await shown.settle();
    is("Copy link copies the page's own address and says so", [copied, texts(find(shown.tree(), (n) => n.props?.role === "status")[0]).join("")], [["https://marktmorgen.com/help/delivery/does-the-download-link-expire"], "Link copied."]);
    (find(shown.tree(), (n) => n.type === "button")[1].props?.onClick as () => void)();
    is("Print opens the browser's print dialog", printed, 1);
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => { throw new Error("denied"); } } }, configurable: true });
    const again = await mount(HelpAnswerTools, {});
    await (find(again.tree(), (n) => n.type === "button")[0].props?.onClick as () => Promise<void>)();
    await again.settle();
    is("a copy the browser refuses is said, with what to do", texts(find(again.tree(), (n) => n.props?.role === "status")[0]).join(""), "The link could not be copied here. Copy it from the address bar instead.");
    const source = readFileSync("app/help/[section]/[answer]/page.tsx", "utf8");
    is("printed, the answer stands alone: menus, footer, other answers and the tools are left out", [/<div className="print:hidden">\s*<SiteNav \/>/.test(source), /<div className="print:hidden">\s*<SiteFooter \/>/.test(source), source.includes('className="mt-12 max-w-3xl print:hidden"'), readFileSync("components/help-answer-tools.tsx", "utf8").includes("print:hidden")], [true, true, true, true]);
  }

  part("The side list of topics");
  {
    const topics = helpTopics();
    is("every studio area is a topic, each to its answer's page", [topics.length, topics.every((t) => answers.some((a) => t.href === helpAnswerPath(a.section, a.id)))], [HELP_AREAS.length, true]);
    is("the filter keeps names with every word typed, any case, with or without accents", [filterTopics([{ name: "Café menu", href: "/a" }, { name: "Funnels", href: "/b" }], "CAFE").map((t) => t.href), filterTopics(topics, "  ").length, filterTopics(topics, "your pa").map((t) => t.name)], [["/a"], topics.length, ["Your Path", "Your pages"].filter((n) => topics.some((t) => t.name === n)).sort((a, b) => a.localeCompare(b, "en-US"))]);
    const server = renderToStaticMarkup(createElement(HelpTopics, { topics }));
    is("before scripts run, the list is open, the filter off and no fold button", [server.includes('class="block mt-3 lg:mt-0 lg:block"'), /<input[^>]*disabled=""/.test(server), server.includes("All help topics</button>")], [true, true, false]);
    is("it is a named navigation with a visible label on the filter", [server.includes('<nav aria-label="All help topics"'), /<label for="[^"]+"[^>]*>Filter by name<\/label>/.test(server)], [true, true]);
    const shown = await mount(HelpTopics, { topics });
    const tree = () => shown.tree();
    const button = find(tree(), (n) => n.type === "button")[0];
    is("with scripts: folded on a small screen behind All help topics", [texts(button).join(""), button.props?.["aria-expanded"], String(find(tree(), (n) => typeof n.props?.className === "string" && (n.props.className as string).includes("lg:block") && n.type === "div")[0]?.props?.className).startsWith("hidden")], ["All help topics", false, true]);
    (button.props?.onClick as () => void)();
    await shown.settle();
    is("pressing it opens the list", find(tree(), (n) => n.type === "button")[0].props?.["aria-expanded"], true);
    (find(tree(), (n) => n.type === "input")[0].props?.onChange as (e: { target: { value: string } }) => void)({ target: { value: "funn" } });
    await shown.settle();
    is("typing narrows the list and says how many", [find(tree(), (n) => n.type === Link).map((n) => texts(n).join("")), texts(find(tree(), (n) => n.props?.role === "status")[0]).join("")], [["Funnels"], "1 topic"]);
    (find(tree(), (n) => n.type === "input")[0].props?.onChange as (e: { target: { value: string } }) => void)({ target: { value: "zzzz" } });
    await shown.settle();
    is("nothing found is said", texts(find(tree(), (n) => n.props?.role === "status")[0]).join(""), "No topic has that in its name.");
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
