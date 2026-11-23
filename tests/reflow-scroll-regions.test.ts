/**
 * Long content reflows or scrolls where a keyboard can reach it (WCAG 1.4.10,
 * 2.1.1, 1.4.8 at AAA; AGENTS.md AX274 Part A item 4), on three pages:
 *
 *   - the checkout script page (app/developers/checkout-script) shows the
 *     whole script, its events and its Content-Security-Policy lines in code
 *     blocks that scroll sideways at 320 px. A keyboard user could not
 *     scroll them: a block with nothing focusable inside never takes the
 *     focus. Each block now takes the focus, as a region named by what it
 *     holds, so the arrow keys scroll it and a screen reader says what it is;
 *   - the outreach stop page (app/outreach/stop/[token]) put the store's name
 *     in a button that never wraps from 480 px up (.btn), in a card about
 *     376 px wide: a long name, or a page zoomed to 200%, ran past the
 *     button's edge. Both stop buttons now wrap (.btn-wrap);
 *   - the API page (app/developers) and every help answer (app/help/[section]/[answer]) the same way
 *     (23 November 2026, a crawl of every public page at 320 px with axe): the API page's code blocks
 *     took no focus, and three help answers ran up to 45 px past a 320 px screen on one long word;
 *   - the community leaderboard's rule for points ran about 92 characters a
 *     line under a 768 px column; it is held under 80 (70ch).
 *
 * The checkout script page is rendered for real; the other two need a
 * stored outreach token or a community member, so their source is read.
 * Not checked here: a real browser at 320 px and at 200% zoom.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import CheckoutScriptPage from "@/app/developers/checkout-script/page";
import { done, is, part } from "./check";

async function main() {
  part("The checkout script page's code blocks");
  const html = renderToStaticMarkup(await CheckoutScriptPage());
  const blocks = [...html.matchAll(/<pre\b([^>]*)>/g)].map((m) => m[1]);
  is("five code blocks", blocks.length, 5);
  is("each scrolls sideways inside itself", blocks.every((a) => /overflow-x-auto/.test(a)), true);
  is("each takes the keyboard focus", blocks.every((a) => /tabindex="0"/i.test(a)), true);
  is("each is a region", blocks.every((a) => /role="region"/.test(a)), true);
  const names = blocks.map((a) => a.match(/aria-label="([^"]*)"/)?.[1] ?? "");
  is("each has a name", names.every((n) => n.trim().length > 0), true);
  is("no two have the same name", new Set(names).size, names.length);

  part("The API page's code blocks (app/developers/page.tsx), the same way: axe's scrollable-region-focusable failed there");
  const api = readFileSync("app/developers/page.tsx", "utf8");
  const apiPre = [...api.matchAll(/<pre\b([^>]*)>/g)].map((m) => m[1]);
  is("one <pre>, inside Code", apiPre.length, 1);
  is("it takes the keyboard focus, as a named region", [/tabIndex=\{0\}/.test(apiPre[0] ?? ""), /role="region"/.test(apiPre[0] ?? ""), /aria-label=\{label\}/.test(apiPre[0] ?? "")], [true, true, true]);
  is("no code sample without a name", /<Code>/.test(api), false);
  const apiNames = [...api.matchAll(/<Code label="([^"]*)">/g)].map((m) => m[1]);
  is("fifteen named samples", apiNames.length, 15);
  is("no two have the same name", new Set(apiNames).size, apiNames.length);

  part("A help answer breaks a long word instead of widening the page at 320 px");
  // A sitemap address, a utm_ tag and "MarktmorgenOutreach" in a title ran 13 to 45 px past a 320 px screen.
  const answer = readFileSync("app/help/[section]/[answer]/page.tsx", "utf8");
  const article = answer.match(/<article className="([^"]*)">/)?.[1].split(/\s+/) ?? [];
  is("the answer's article breaks long words", article.includes("break-words"), true);

  part("The outreach stop buttons wrap");
  const stop = readFileSync("app/outreach/stop/[token]/page.tsx", "utf8");
  const buttons = [...stop.matchAll(/<button\b[^>]*className="([^"]*)"/g)].map((m) => m[1].split(/\s+/));
  is("two stop buttons", buttons.length, 2);
  is("both wrap their words", buttons.map((b) => b.includes("btn-wrap")), [true, true]);
  const css = readFileSync("app/globals.css", "utf8");
  const wrap = css.match(/\n\.btn-wrap\s*\{([^}]*)\}/)?.[1] ?? "";
  is(".btn-wrap lets the text wrap inside the button", [/white-space:\s*normal/.test(wrap), /max-width:\s*100%/.test(wrap)], [true, true]);

  part("The leaderboard's rule for points stays under 80 characters a line");
  const board = readFileSync("app/[handle]/community/leaderboard/page.tsx", "utf8");
  const rule = board.match(/<p className="([^"]*)">\s*\{w\.pointsRule\(store\.name\)\}/)?.[1].split(/\s+/) ?? [];
  is("the paragraph is found", rule.length > 0, true);
  const measure = rule.map((c) => c.match(/^max-w-\[(\d+)ch\]$/)?.[1]).find(Boolean);
  is("its measure is set in characters, at most 80", Number(measure) > 0 && Number(measure) <= 80, true);

  done();
}

void main();
