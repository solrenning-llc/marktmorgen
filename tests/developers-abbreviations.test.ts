/**
 * WCAG 3.1.4 (abbreviations, AAA; AX274 item 4) on the API's documentation
 * pages: each abbreviation is expanded the first time the page uses it in its
 * prose, as an <abbr> with what it stands for (components/abbr.tsx,
 * lib/abbreviations.ts). Code examples are code and are left as written.
 * The pages are drawn whole, as the server draws them.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DevelopersPage from "@/app/developers/page";
import CheckoutScriptPage from "@/app/developers/checkout-script/page";
import { done, is } from "./check";

/** Each abbreviation's first use in the page's prose (outside <pre> and <code>), and whether it is inside an <abbr> with a title. */
function firstUses(html: string, shorts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const open: string[] = [];
  let abbrTitle = "";
  for (const token of html.match(/<[^>]+>|[^<]+/g) ?? []) {
    const tag = /^<(\/?)([a-zA-Z0-9]+)([^>]*)>$/.exec(token);
    if (tag) {
      const [, closing, name, attrs] = tag;
      if (/\/$/.test(attrs) || ["br", "img", "input", "meta", "link", "hr"].includes(name)) continue;
      if (closing) {
        open.pop();
        if (name === "abbr") abbrTitle = "";
      } else {
        open.push(name);
        if (name === "abbr") abbrTitle = /title="([^"]*)"/.exec(attrs)?.[1] ?? "";
      }
      continue;
    }
    if (open.includes("pre") || open.includes("code") || open.includes("script") || open.includes("style") || open.includes("title")) continue;
    for (const short of shorts) {
      if (short in out) continue;
      if (new RegExp(`\\b${short}s?\\b`).test(token)) out[short] = open[open.length - 1] === "abbr" && abbrTitle ? `abbr: ${abbrTitle}` : "plain";
    }
  }
  return out;
}

async function page(component: unknown): Promise<string> {
  const drawn = await (component as () => unknown)();
  return renderToStaticMarkup(createElement("div", null, drawn as never));
}

async function main(): Promise<void> {
  const developers = firstUses(await page(DevelopersPage), ["API", "CORS", "JSON", "ISO", "UTC", "CSV"]);
  is("/developers: API, CORS, JSON, ISO, UTC and CSV are each expanded where the page first uses them", developers, {
    API: "abbr: application programming interface",
    CORS: "abbr: Cross-Origin Resource Sharing",
    JSON: "abbr: JavaScript Object Notation",
    ISO: "abbr: International Organization for Standardization",
    UTC: "abbr: Coordinated Universal Time",
    CSV: "abbr: comma-separated values",
  });
  const script = firstUses(await page(CheckoutScriptPage), ["HTML", "API"]);
  is("/developers/checkout-script: HTML and API are expanded where the page first uses them", script, {
    HTML: "abbr: HyperText Markup Language",
    API: "abbr: application programming interface",
  });
  done();
}

void main();
