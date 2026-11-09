/**
 * 656 [WG16], unit 12: the community's empty lists use the one pattern
 * (components/empty-state.tsx). Each drew its title as a bold paragraph, so a
 * screen reader walking the page by headings never met it (WCAG 1.3.1, 2.4.10).
 * Now each is a real heading at its place in the page's outline: h2 right under
 * the page's h1 (the feed, notifications, a conversation), h3 under a section's
 * h2 (events coming up, your conversations). The words are the ones each page
 * already said, in every buyer language; no new action, because each page
 * already has what fills its list (the composer, or nothing a buyer can do).
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyState } from "@/components/empty-state";
import { done, is, part } from "./check";

const render = (props: Parameters<typeof EmptyState>[0]) => renderToStaticMarkup(createElement(EmptyState, props));

part("The public pattern keeps the page's outline");
is("by default, an h2", /<h2[^>]*>Nothing yet<\/h2>/.test(render({ title: "Nothing yet", body: "B." })), true);
is("under a section's h2, an h3", /<h3[^>]*>Nothing yet<\/h3>/.test(render({ title: "Nothing yet", body: "B.", level: 3 })), true);
is("no h2 when asked for an h3", /<h2/.test(render({ title: "Nothing yet", body: "B.", level: 3 })), false);

const page = (p: string) => readFileSync(`app/[handle]/community/${p}.tsx`, "utf8");
const pages: [string, string, RegExp, string][] = [
  ["the feed", "page", /<EmptyState\s+title=\{before \? w\.nothingOlder : w\.noPostsYet\}/, "{before ? w.nothingOlder : w.noPostsYet}"],
  ["notifications", "notifications/page", /<EmptyState\s+title=\{w\.nothingYet\}/, "{w.nothingYet}"],
  ["events coming up (under its h2)", "events/page", /<EmptyState\s+level=\{3\}\s+title=\{w\.nothingScheduled\}/, "{w.nothingScheduled}"],
  ["your conversations (under its h2)", "messages/page", /<EmptyState\s+level=\{3\}\s+title=\{w\.nothingHereYet\}/, "{w.nothingHereYet}"],
  ["a conversation with nothing said", "messages/[pair]/page", /<EmptyState\s+title=\{w\.nothingSaidYet\}/, "{w.nothingSaidYet}"],
];
part("Each community list with nothing in it uses it");
for (const [name, file, use, title] of pages) {
  const src = page(file);
  is(`${name}: the one pattern`, use.test(src), true);
  is(`${name}: its title is no longer a bold paragraph standing in for a heading`, src.includes(`style={{ color: "var(--st-text)" }}>${title}</p>`), false);
}

done();
