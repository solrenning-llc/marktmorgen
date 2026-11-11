/**
 * Closes a disclosure (<details>) from a control inside it and keeps the
 * keyboard's focus (AX274 Part A; WCAG 2.2 2.4.3 Focus Order). Setting
 * `open = false` hides what the focus is on, and a browser then moves the
 * focus to the page's body. When the focus was inside, it goes back to the
 * disclosure's own summary, the control that opened it; a focus elsewhere is
 * left where it is. Pure apart from what it is given
 * (tests/close-disclosure.test.ts).
 */

export type Disclosure = {
  open: boolean;
  contains: (node: never) => boolean;
  querySelector: (selector: string) => { focus: () => void } | null;
};

export function closeDisclosure(details: Disclosure | null | undefined, doc: { activeElement: unknown }): void {
  if (!details) return;
  const inside = doc.activeElement !== null && details.contains(doc.activeElement as never);
  details.open = false;
  if (inside) details.querySelector(":scope > summary")?.focus();
}
