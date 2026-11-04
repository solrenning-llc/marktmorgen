/**
 * Things said about a product elsewhere (lib/sales-page.ts, QuotesBlock;
 * components/sales-blocks.tsx). Each one is kept only with the https address
 * where it was said, and drawn with a link to it a visitor can follow and
 * check. Checked:
 *
 *   - which addresses are kept, written the way they will be linked, and
 *     which are not (another scheme, a login, this machine, too long);
 *   - a page sent with words but no working address is told back, not saved
 *     without them; one with neither is simply left out;
 *   - the words are never translated or rewritten: only the heading is;
 *   - drawn with who said it and a link to the original in the page's
 *     language, never as a review, and not a link in the studio's preview;
 *   - the coach counts it filled, and the gallery offers it.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type BlockContext, BlockView } from "@/components/sales-blocks";
import { MAX_QUOTES, type PageBlock, emptyBlock, pageProblem, parsePage, quoteHost, quoteUrl } from "@/lib/sales-page";
import { pageWords } from "@/lib/page-translate";
import { REWRITABLE } from "@/lib/block-rewrite-rules";
import { coachChecks } from "@/lib/page-coach";
import { BLOCK_GROUPS } from "@/components/block-picker";
import { blockWords } from "@/lib/buyer-words/blocks";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

part("Where it was said");
is("an https address is kept as it will be linked", [quoteUrl("https://x.com/ana/status/1"), quoteUrl(" x.com/ana/status/1 "), quoteUrl("https://www.youtube.com/watch?v=abc")], ["https://x.com/ana/status/1", "https://x.com/ana/status/1", "https://www.youtube.com/watch?v=abc"]);
is("no other scheme, login, this machine or nonsense", ["http://x.com/a", "javascript:alert(1)", "https://user:pw@x.com/a", "https://localhost/a", "https://127.0.0.1/a", "https://intranet/a", "not an address", `https://x.com/${"a".repeat(400)}`].map(quoteUrl), Array(8).fill(""));
is("the place named as a visitor reads it", [quoteHost("https://www.youtube.com/watch?v=abc"), quoteHost("https://m.facebook.com/x")], ["youtube.com", "facebook.com"]);

part("What the block keeps");
const sent = {
  blocks: [
    {
      id: "quot0001",
      kind: "quotes",
      heading: "What people say",
      items: [
        { text: "Made the rye on Sunday. Best loaf yet.", name: "@ana", url: "https://x.com/ana/status/1", stars: 5 },
        { text: "", name: "", url: "" },
        ...Array.from({ length: 8 }, (_, i) => ({ text: `Note ${i}`, name: "", url: `https://example.com/${i}` })),
      ],
    },
  ],
};
const page = parsePage(sent);
const block = page.blocks[0] as Extract<PageBlock, { kind: "quotes" }>;
is("the words, who said them and where, nothing else", Object.keys(block.items[0]).sort(), ["name", "text", "url"]);
is("an empty one left out, and no more than a block holds", block.items.length, MAX_QUOTES);
is("a page with only those saves as sent", pageProblem({ blocks: sent.blocks }, page), null);
const noLink = { blocks: [{ id: "quot0002", kind: "quotes", heading: "", items: [{ text: "Loved it", name: "Ana", url: "" }] }] };
is("words with no address where they were said are told back", pageProblem(noLink, parsePage(noLink)), "quote_link");
const badLink = { blocks: [{ id: "quot0003", kind: "quotes", heading: "", items: [{ text: "Loved it", name: "Ana", url: "http://x.com/a" }] }] };
is("and so is an address that is not https", pageProblem(badLink, parsePage(badLink)), "quote_link");

part("Never put into other words");
is("only the heading is translated", pageWords(page).filter((w) => w.includes("loaf") || w === "@ana" || w === "What people say"), ["What people say"]);
is("and no rewrite is offered for it", REWRITABLE.includes("quotes"), false);

part("Drawn");
const ctx: BlockContext = { storeName: "Harbor Kitchen", productTitle: "Sunday Baking", picture: null, photo: null, action: { kind: "link", href: "#buy" }, defaultLabel: "Get it", now: 1_900_000_000, lang: "es" };
const html = renderToStaticMarkup(createElement(BlockView, { block, ctx, reviews: null }));
is("their words, as a quotation of that address", html.includes('<blockquote cite="https://x.com/ana/status/1"') && html.includes("Made the rye on Sunday. Best loaf yet."), true);
is("with who said it and a link to the original, in the page's language", [html.includes("@ana"), html.includes('href="https://x.com/ana/status/1" target="_blank" rel="noopener noreferrer nofollow ugc"'), html.includes("Verlo en x.com")], [true, true, true]);
is("never with stars, as a review is", html.includes("star"), false);
is("in the studio's preview it is not a link", renderToStaticMarkup(createElement(BlockView, { block, ctx: { ...ctx, preview: true }, reviews: null })).includes("<a "), false);
is("an empty block draws nothing", renderToStaticMarkup(createElement(BlockView, { block: emptyBlock("quotes"), ctx, reviews: null })), "");
is("the link's words in every store language", LANGUAGE_CODES.map((code) => blockWords(code).quoteSource("x.com").includes("x.com")), LANGUAGE_CODES.map(() => true));

part("In the studio");
is("the coach reads it", coachChecks({ page, productTitle: "Bread", free: false, picture: false, pictureAlt: "", facts: {} }).length > 0, true);
is("the gallery offers it", BLOCK_GROUPS.some((g) => g.kinds.includes("quotes")), true);
done();
