import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACCENTS, THEMES, contrast, lookColours, lookStyle } from "../lib/store-look";

/*
 * WCAG 2.2 1.4.11 Non-text Contrast, AA (274 [AX1]): the edge that shows where
 * a text field is keeps 3:1 against the colors next to it.
 *
 * Found by a browser audit (11 November 2026, Chromium, colors computed on
 * the page): a text field's 1 px border is its only outline, and it measured
 * 1.74:1 on a store (the list's email field, a gift's fields, the number of
 * people, the purchases and waitlist pages) and 1.72:1 on the site's own
 * fields (/signin, /library).
 *
 * A store's field edge is worked out per theme and is held here against the
 * field's own fill and each surface a field sits on (the page, a card, an
 * item), for every theme and any color a creator picks (the edge does not
 * follow the color, so it cannot be moved by it). The site's field takes the
 * existing control-edge token, --line-off (#857f70), whose 3:1 on the light
 * surfaces is held by the numbers below.
 */
const SURFACES = ["field", "card", "item", "bg"] as const;
const accents = [...ACCENTS.map((a) => a.hex), "#5a36ee", "#ffff00", "#000000", "#ffffff"];

test("a store field's edge keeps 3:1 against the field and every surface it sits on, in every theme", () => {
  for (const theme of THEMES) {
    for (const accent of accents) {
      const c = lookColours({ theme: theme.id, accent });
      assert.ok(c.fieldEdge, `${theme.id}: a field edge`);
      for (const s of SURFACES) {
        const ratio = contrast(c.fieldEdge, c[s]);
        assert.ok(ratio >= 3, `${theme.id} ${accent}: edge on ${s} ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test("the page carries it as --st-field-edge", () => {
  const style = lookStyle({ theme: "light", accent: "#5a36ee" });
  assert.match(String(style["--st-field-edge"]), /^#[0-9a-f]{6}$/i);
  assert.equal(style["--st-field-edge"], lookColours({ theme: "light", accent: "#5a36ee" }).fieldEdge);
});

const css = readFileSync("app/globals.css", "utf8");
const body = (selector: string): string => {
  const at = css.indexOf("\n" + selector + " {");
  assert.ok(at >= 0, selector);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
};

test("a store field draws its border in that edge color", () => {
  assert.match(body(".st-field"), /border:\s*1px solid var\(--st-field-edge\);/);
});

test("the site's field draws its border in the control-edge token, 3:1 on white and on sand", () => {
  assert.match(body(".field"), /border:\s*1px solid var\(--line-off\);/);
  const token = /--line-off:\s*(#[0-9a-f]{6})/i.exec(css)?.[1];
  assert.ok(token);
  for (const [name, surface] of [["white", "#ffffff"], ["paper", /--paper:\s*(#[0-9a-f]{6})/i.exec(css)![1]], ["sand", /--sand:\s*(#[0-9a-f]{6})/i.exec(css)![1]]]) {
    assert.ok(contrast(token!, surface) >= 3, `--line-off on ${name}: ${contrast(token!, surface).toFixed(2)}:1`);
  }
});
