/**
 * A product sold from the creator's own website (lib/embed-rules.ts, added
 * 7 October 2026). What is checked:
 *
 *   - the code: the card is a frame of this site's card page and the button
 *     a link to the product's page, both tagged with where they were pasted,
 *     and a title or text typed by the creator can never break out of them;
 *   - the place name is cleaned the way the sales report cleans it;
 *   - only the card page may be framed by another site: its policy says so,
 *     it is sent without X-Frame-Options, and every other page keeps both;
 *   - the card page counts nothing, sets nothing and opens everything in a
 *     new tab, so the creator's page is never replaced by it.
 *
 * The page itself, framed by a page of another address and bought from, is
 * checked in tests/e2e/run.mjs.
 */
import { readFileSync } from "node:fs";
import { buttonCode, buttonText, cardCode, embedPath, embedPlace, placeFrom, tagged } from "@/lib/embed-rules";
import { cameFrom } from "@/lib/came-from";
import { dynamicPolicy, isDynamicPage, isEmbedPage, isStorePage } from "@/lib/csp";
import { done, is, part } from "./check";

const read = (path: string) => readFileSync(path, "utf8");

async function main(): Promise<void> {
  part("The code");
  const card = cardCode({ handle: "kitchen", productId: "abc123", title: "Meal Planner", place: "blog" });
  is("the card is a frame of the card page, tagged with the place", card.startsWith('<iframe src="https://marktmorgen.com/embed/kitchen/abc123?utm_source=blog&amp;utm_medium=buy-button"'), true);
  is("and has a size, a name and no border", [/width="400" height="260"/.test(card), /height:260px/.test(card), /title="Buy Meal Planner"/.test(card), /border:0/.test(card)], [true, true, true, true]);
  const tall = (height: number) => cardCode({ handle: "k", productId: "p", title: "T", place: "", height }).match(/height="(\d+)"/)?.[1];
  is("taller for a product with a picture, and never a height that makes no sense", [tall(420), tall(5), tall(5000), tall(300.5)], ["420", "260", "260", "260"]);
  const button = buttonCode({ handle: "kitchen", productId: "abc123", text: "Get the planner", place: "", fill: "#5a36ee", onFill: "#ffffff" });
  is("the button is a link to the product's page, in the store's color", [
    button.startsWith('<a href="https://marktmorgen.com/@kitchen/p/abc123?utm_source=website&amp;utm_medium=buy-button"'),
    /background:#5a36ee;color:#ffffff/.test(button),
    button.endsWith(">Get the planner</a>"),
  ], [true, true, true]);
  const nasty = 'Tips "for" <you> & me';
  is("a title cannot leave the frame's attribute", cardCode({ handle: "k", productId: "p", title: nasty, place: "" }).includes('title="Buy Tips &quot;for&quot; &lt;you&gt; &amp; me"'), true);
  is("nor the button's words its link", buttonCode({ handle: "k", productId: "p", text: '</a><script>alert(1)</script>', place: "", fill: "#000000", onFill: "#ffffff" }).includes("<script>"), false);
  is("the button says what was typed, on one line, or Buy and the title", [buttonText("  Get   it\nnow ", "X"), buttonText("", "Meal Planner"), buttonText("x".repeat(80), "T").length], ["Get it now", "Buy Meal Planner", 60]);
  is("the card page's address", embedPath("kitchen", "abc123"), "/embed/kitchen/abc123");

  part("The place name");
  is("cleaned as the sales report keeps it", [embedPlace("My Blog!"), embedPlace(""), embedPlace(null), embedPlace("A".repeat(50)).length], ["my-blog", "website", "website", 30]);
  is("read back from the card's own address", [placeFrom("newsletter"), placeFrom(["podcast", "x"]), placeFrom(undefined)], ["newsletter", "podcast", "website"]);
  is("tags join an address that already has a question mark", tagged("/@k/p/x?a=1", "blog"), "/@k/p/x?a=1&utm_source=blog&utm_medium=buy-button");
  is("and a sale made from the card is reported under that place", cameFrom("https://marktmorgen.com/embed/k/p?utm_source=blog&utm_medium=buy-button", "marktmorgen.com"), { source: "blog", medium: "buy-button", campaign: "", content: "" });

  part("Who may frame what");
  is("the card page is drawn per visit, with its nonce", [isDynamicPage("/embed/kitchen/abc123"), isEmbedPage("/embed/kitchen/abc123"), isStorePage("/embed/kitchen/abc123")], [true, true, false]);
  is("nothing else counts as the card page", [isEmbedPage("/embed"), isEmbedPage("/embed/kitchen"), isEmbedPage("/embed/a/b/c"), isEmbedPage("/@kitchen/p/abc")], [false, false, false, false]);
  const framed = dynamicPolicy("n", { store: false, embed: true });
  is("its policy lets any site frame it", /frame-ancestors \*(;|$)/.test(framed), true);
  is("and gives it no ad pixels and no players", [/googletagmanager|facebook/.test(framed), /youtube/.test(framed)], [false, false]);
  is("every other page may still be framed only by this site", [dynamicPolicy("n"), dynamicPolicy("n", { store: false })].map((policy) => /frame-ancestors 'self'(;|$)/.test(policy)), [true, true]);
  const config = read("next.config.ts");
  is("X-Frame-Options is sent everywhere but the card page", /source: "\/\(\(\?!embed\/\)\.\*\)",\s*headers: \[\s*\{ key: "Content-Security-Policy", value: staticPolicy\(\) \},\s*\{ key: "X-Frame-Options", value: "SAMEORIGIN" \}/.test(config), true);
  is("and the card page's own headers name neither", /source: "\/embed\/:path\*",\s*headers: common,/.test(config) && !/const common = \[[^\]]*(X-Frame-Options|Content-Security-Policy)/.test(config), true);
  is("the proxy gives it the framing policy", /embed: isEmbedPage\(path\)/.test(read("proxy.ts")), true);

  part("The card page");
  const page = read("app/embed/[handle]/[product]/page.tsx");
  is("counts no visit, sets no cookie, reads no session", /countHit|cookies\(|setCookie|readSession|currentUser/.test(page), false);
  // Opened by the checkout script (?mm=, tests/embed-sdk.test.ts) it is counted
  // as a visit by lib/embed-open.ts; pasted as a frame, it still counts nothing.
  is("only an open by the checkout script is counted, and elsewhere", /const open: ScriptOpen \| null = mode && store \? await readScriptOpen\(store, mode, query\) : null;/.test(page), true);
  const links = page.match(/<a\s[^>]*>/g) ?? [];
  // A call's own calendar in the frame (637 [GL5] unit 6) is the one exception: its links go to this same card's address (here()), which the frame may show.
  is("every link opens a new tab in a frame, and stays in the tab only as a page", links.length > 0 && links.every((tag) => /\{\.\.\.aside\}/.test(tag) || /href=\{here\(/.test(tag)), true);
  is("and the ones that stay in the frame stay on this card's own address", links.filter((tag) => !/\{\.\.\.aside\}/.test(tag)).every((tag) => /^<a\s+href=\{here\(/.test(tag.replace(/\s+/g, " "))), true);
  is("which is the one way out of each", /const aside = open\?\.mode === "page" \? \{ target: "_top" \} : \{ target: "_blank", rel: "noopener" \};/.test(page), true);
  is("and so does its checkout", /<form action="\/api\/store\/checkout" method="post" target="_blank" rel="noopener"/.test(page), true);
  is(
    "which is told only which product, never a price, and the listed site it came from",
    (page.match(/<input type="hidden" name="(\w+)"/g) ?? []).map((tag) => tag.match(/name="(\w+)"/)?.[1]),
    ["handle", "product", "site", "return"],
  );
  is("and is kept out of search", /robots: \{ index: false, follow: false \}/.test(page), true);

  done();
}

void main();
