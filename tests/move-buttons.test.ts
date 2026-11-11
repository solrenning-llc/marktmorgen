/**
 * Moving things one place at a time in the studio's editors, from a keyboard
 * and a screen reader (AX274 Part A; WCAG 2.2 2.4.3 Focus Order, 4.1.3 Status
 * Messages). The products of a bundle (components/bundle-editor.tsx), the
 * products of a collection (components/collections-editor.tsx) and the steps
 * of a funnel brought from ClickFunnels (components/clickfunnels-funnel.tsx)
 * each had "Move … up" turned off at the top and "down" at the bottom, so the
 * focus fell to the page's body when a press took the item to an end, and no
 * move was said. Measured in Chromium on 11 November 2026 for the same pattern
 * on the start page ("The order of your page", #3791).
 *
 * Now an end button stays focusable (aria-disabled) and says the item is
 * already first or last, and every move is said in a polite status line.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { BundleEditor, type PickerProduct } from "@/components/bundle-editor";
import { endWords, movedWords } from "@/lib/move-words";
import { done, is, part } from "./check";

part("The words");
is("a move says where the item went", movedWords("Grocery List Pack", 1, 3), "Moved Grocery List Pack to place 2 of 3.");
is("a press at the top says it is already first", endWords("Grocery List Pack", "first"), "Grocery List Pack is already first.");
is("and at the bottom, last", endWords("Grocery List Pack", "last"), "Grocery List Pack is already last.");

part("Each editor");
const files = ["components/bundle-editor.tsx", "components/collections-editor.tsx", "components/clickfunnels-funnel.tsx"];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const moves = [...src.matchAll(/aria-label=\{`Move \$\{[^`]*\} (up|down)`\}/g)];
  const buttons = moves.map((m) => src.slice(src.lastIndexOf("<button", m.index), src.indexOf(">", m.index)));
  is(`${file}: its Move buttons are found`, buttons.length > 0, true);
  is(`${file}: none is turned off for being at an end`, buttons.some((b) => /(?<![-\w])disabled=\{[^}]*(=== 0|length - 1)/.test(b)), false);
  is(`${file}: each is marked unavailable at its end instead`, buttons.every((b) => /aria-disabled=\{[^}]*(=== 0|length - 1)[^}]*\|\| undefined\}/.test(b)), true);
  is(`${file}: a polite status line says each move`, src.includes('<SaidLine said={said} />') && /const \[said, say\] = useSaid\(\);/.test(src), true);
  is(`${file}: the moves use the shared words`, src.includes("movedWords(") && src.includes("endWords("), true);
}

part("A bundle as drawn (review LOW: not only the source)");
const items: PickerProduct[] = ["Bread", "Soup", "Cake"].map((title, i) => ({ id: `product_${i}`, title, priceCents: 1000, what: "Download", hidden: false, why: null }));
const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {} } as never }, createElement(BundleEditor, { mode: "edit", owner: { id: "bundle", title: "Recipes", priceCents: 2000 }, initial: items, currency: "usd" } as never)));
const drawn = [...html.matchAll(/<button\b([^>]*aria-label="Move [^"]*"[^>]*)>/g)].map((m) => m[1]);
is("an up and a down for each product", drawn.length, 6);
is("only the first up and the last down are unavailable, and none is turned off", drawn.map((a) => [/aria-disabled="true"/.test(a), /(?<![-\w])disabled=""/.test(a)]), drawn.map((_, i) => [i === 0 || i === 5, false]));
is("the status line is drawn, empty until a move", /<p role="status" class="sr-only"><\/p>/.test(html), true);

done();
