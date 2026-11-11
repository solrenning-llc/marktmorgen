/**
 * Closing a disclosure (<details>) from a button inside it, from a keyboard
 * (lib/close-disclosure.ts; AX274 Part A; WCAG 2.2 2.4.3 Focus Order). Seen in
 * Chromium on 11 November 2026 on the studio's start page, keyboard only:
 * "Cancel" under "Edit name and description" (components/details-form.tsx)
 * and "Cancel" and "Save pixels" under "Add a pixel"
 * (components/pixel-editor.tsx) closed their <details> by setting open to
 * false while the focus was on the button inside it, and the focus fell to
 * the page's body. Now the focus goes back to the disclosure's own summary,
 * the control that opened it, when it was inside; a focus elsewhere is left.
 */
import { readFileSync } from "node:fs";
import { closeDisclosure, type Disclosure } from "@/lib/close-disclosure";
import { done, is, part } from "./check";

part("The helper");
const make = (focusInside: boolean) => {
  const summary = { focused: 0, focus() { summary.focused++; } };
  const details: Disclosure & { open: boolean } = {
    open: true,
    contains: () => focusInside,
    querySelector: (s: string) => (s === ":scope > summary" ? summary : null),
  };
  return { details, summary };
};
{
  const { details, summary } = make(true);
  closeDisclosure(details, { activeElement: {} });
  is("it closes the disclosure", details.open, false);
  is("a focus inside it goes back to its summary", summary.focused, 1);
}
{
  const { details, summary } = make(false);
  closeDisclosure(details, { activeElement: {} });
  is("a focus elsewhere is left where it is", [details.open, summary.focused], [false, 0]);
}
is("no disclosure, nothing happens", closeDisclosure(null, { activeElement: null }), undefined);

part("Where the studio closes one");
const pixels = readFileSync("components/pixel-editor.tsx", "utf8");
const details = readFileSync("components/details-form.tsx", "utf8");
is("no studio component closes its disclosure by setting open alone", [pixels, details].some((src) => /disclosure\.current\.open = false/.test(src)), false);
is("the pixel editor closes it with the helper, after a save and on Cancel", (pixels.match(/closeDisclosure\(disclosure\.current, document\)/g) ?? []).length, 2);
is("the store's name and description editor too", (details.match(/closeDisclosure\(disclosure\.current, document\)/g) ?? []).length, 1);

done();
