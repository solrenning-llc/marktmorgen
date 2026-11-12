// WCAG 2.4.12 (Focus Not Obscured, Enhanced) on a store's pages on a phone: the cart's button is
// held over the top right of the page once something is in the cart (components/store-cart.tsx,
// .st-cart). Found walking the buyer path at 320 and 390 px (Claude 1, 12/11/2026): it covered
// part of the store's line of news and of the store's name on a product's page while they had
// the keyboard focus, at the top of the page, where nothing can scroll them out from under it.
// The phone's buy bar at the bottom is a separate case (tests/sticky-buy-focus.test.ts, PR #3743).
//
// The rules are read from the real app/globals.css; the sizes are the stylesheet's own. The
// browser check of the same thing is in tests/e2e/accessibility-buyer-actions.mjs (the cart part).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("app/globals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const REM = 16;

let passed = 0;
function is<T>(name: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, name);
  passed += 1;
}

/** Every block of a media query whose condition is exactly `query`, with its body. */
function mediaBodies(query: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const start = css.indexOf(`@media ${query}`, at);
    if (start < 0) return out;
    let depth = 0;
    let i = css.indexOf("{", start);
    const open = i;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) break;
    }
    out.push(css.slice(open + 1, i));
    at = i;
  }
}

/** The declarations of the rule with exactly this selector inside the given CSS, or null. */
function rule(body: string, selector: string): Record<string, string> | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) return null;
  return Object.fromEntries(
    match[1]
      .split(";")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]),
  );
}

/** A length of px and rem terms (calc(), env() taken as 0, as on a phone without a notch), in px. */
function px(value: string | undefined): number {
  if (!value) return 0;
  const plain = value.replace(/env\([^)]*\)/g, "0px");
  let sum = 0;
  for (const [, n, unit] of plain.matchAll(/(-?\d*\.?\d+)(px|rem)/g)) sum += Number(n) * (unit === "rem" ? REM : 1);
  return sum;
}

const PHONE = "(max-width: 639.98px)";
const phone = mediaBodies(PHONE).join("\n");
const everywhere = css;

// The things held over the page, as the stylesheet draws them.
const cart = rule(everywhere, ".st-cart");
const opener = rule(everywhere, ".st-cart-open");
is("the cart's button is held at the top of the screen", cart?.position, "fixed");

const cartBottom = px(cart?.top) + px(opener?.["min-height"]);

// 1. At the top of the page nothing scrolls: once the cart's button is there, a phone's page starts below it.
const room = rule(phone, "body:has(#cart .st-cart-open) .st-page");
is("on a phone, the page makes room at its top for the cart's button", room !== null, true);
is("and that room is below the whole button", px(room?.["padding-top"]) > cartBottom, true);

// 2. Lower down, anything the focus is scrolled to lands below the button (html's scroll-padding-top).
const scrolledTo = [...everywhere.matchAll(/(?:^|})\s*html\s*\{([^}]*)\}/g)].map((m) => m[1]).join(";");
const scrollTop = scrolledTo.match(/scroll-padding-top:\s*([^;]+)/g)?.map((d) => px(d.split(":")[1])) ?? [];
is("what the focus is scrolled to lands below the cart's button", scrollTop.length > 0 && scrollTop.every((v) => v > cartBottom), true);

// 3. Only on a phone: on a wider screen the button sits beside the page's column, and the page keeps its own top.
const outsidePhone = mediaBodies(PHONE).reduce((rest, body) => rest.replace(body, ""), everywhere);
is("and only on a phone", rule(outsidePhone, "body:has(#cart .st-cart-open) .st-page"), null);

console.log(`store-fixed-focus-room: ${passed} checks passed (cart button bottom ${cartBottom}px)`);
