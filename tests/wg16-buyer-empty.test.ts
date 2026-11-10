/**
 * 656 [WG16], unit 3: the buyer's own lists use the one empty-state pattern
 * (components/empty-state.tsx): a heading, one sentence and, only where it
 * works, one action. The store's orders page with nothing to open says so
 * under its own heading (the page's footer already links back to the store,
 * so no second link is drawn); the library with no store listed says so
 * under its heading, with the one action that can help: asking for a link
 * with another address (/library, the same form with no token).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StudioEmptyState } from "@/components/empty-state";
import { ORDERS_WORDS } from "@/lib/buyer-words/orders";
import { done, is, part } from "./check";

part("The words, in every buyer language");
for (const [language, w] of Object.entries(ORDERS_WORDS)) {
  is(`${language}: the orders page with nothing to open has a heading`, typeof w.nothingToOpenTitle === "string" && w.nothingToOpenTitle.trim().length > 0, true);
  is(`${language}: and its sentence still names the store`, w.nothingToOpen("Harbor").includes("Harbor"), true);
}

part("The orders page uses the pattern, with no second link back");
const orders = readFileSync("app/[handle]/orders/page.tsx", "utf8");
is("heading and sentence, no action", /<EmptyState title=\{words\.nothingToOpenTitle\} body=\{words\.nothingToOpen\(store\.name\)\} className="mt-6" \/>/.test(orders), true);
is("no bare sentence left where nothing can be opened", orders.includes("{words.nothingToOpen(store.name)}</p>"), false);
is("the footer still links back to the store", /href=\{`\/@\$\{store\.handle\}`\}[^>]*>\s*\{said\.w\.backTo\(store\.name\)\}/.test(orders), true);

part("The library uses the pattern, with an action that works");
const library = readFileSync("app/library/page.tsx", "utf8");
is("heading, sentence and the link to ask with another address", library.includes('<StudioEmptyState level={2} className="mt-6" title="No purchases listed" body="Nothing is listed for this address anymore. If you bought with another email address, ask for a link with that one." action={{ href: "/library", label: "Use another email address" }} />'), true);
is("no bare sentence left", library.includes(">Nothing is listed for this address any more.</p>"), false);
const drawn = renderToStaticMarkup(createElement(StudioEmptyState, { level: 2, title: "No purchases listed", body: "Nothing is listed for this address anymore.", action: { href: "/library", label: "Use another email address" } }));
is("drawn as an h2 under the page's h1, with a real link", [/<h2[^>]*>No purchases listed<\/h2>/.test(drawn), /<a [^>]*href="\/library"[^>]*>Use another email address<\/a>/.test(drawn)], [true, true]);

done();
