/**
 * The studio's page as the focus keeper (lib/focus-keeper.ts) reads it, in a
 * browser: what its main content is, which control a part starts with, and
 * which controls delete something. Browser only; components/studio-app.tsx
 * wires it, and tests/focus-keeper-removed.test.ts drives lib/focus-keeper.ts
 * with its own elements.
 */
import { destructiveName, type KeeperPlace, type KeptElement } from "@/lib/focus-keeper";

/** A control the keyboard reaches, in the order a person meets them; a field first, as an editor opened in a button's place starts with one. */
const FIELDS = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])';
const CONTROLS = 'button:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])';
const shown = (node: Element) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";

/** A control that deletes: a red "danger" button, one marked data-destructive, or one named Delete, Remove, Erase or Discard. */
const deletes = (node: KeptElement) => {
  if (!(node instanceof HTMLElement)) return false;
  const name = node.getAttribute("aria-label") ?? node.textContent ?? "";
  return destructiveName(name, node.classList.contains("btn-danger") || node.hasAttribute("data-destructive"));
};

/** Where the keeper looks once a control was taken away: only inside the page's main content, never the main region itself. */
export const STUDIO_PLACE: KeeperPlace = {
  inMain: (part) => part instanceof Element && part.tagName !== "MAIN" && part.closest("main") !== null,
  firstControlIn: (part, skip) => {
    if (!(part instanceof Element)) return null;
    const usable = (node: HTMLElement) => shown(node) && !skip?.(node as HTMLElement & KeptElement);
    const first = (selector: string) => [...part.querySelectorAll<HTMLElement>(selector)].find(usable) ?? null;
    // The part itself may be the control (a button added on its own).
    if (part instanceof HTMLElement && part.matches(`${FIELDS}, ${CONTROLS}`)) return usable(part) ? (part as HTMLElement & KeptElement) : null;
    return (first(FIELDS) ?? first(CONTROLS)) as (HTMLElement & KeptElement) | null;
  },
  contains: (outer, inner) => outer instanceof Node && inner instanceof Node && outer.contains(inner),
  destructive: deletes,
};
