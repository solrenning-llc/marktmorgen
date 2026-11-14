/**
 * Closes a disclosure (<details>) from a control inside it and keeps the
 * keyboard's focus (AX274 Part A; WCAG 2.2 2.4.3 Focus Order). Setting
 * `open = false` hides what the focus is on, and a browser then moves the
 * focus to the page's body. When the focus was inside, or was already lost to
 * the body (a Save turned off while it sent), it goes back to the disclosure's
 * own summary, the control that opened it; a focus on another control is left
 * where it is. Pure apart from what it is given
 * (tests/close-disclosure.test.ts).
 */

export type Disclosure = {
  open: boolean;
  contains: (node: never) => boolean;
  querySelector: (selector: string) => { focus: () => void } | null;
};

export function closeDisclosure(details: Disclosure | null | undefined, doc: { activeElement: unknown; body?: unknown }): void {
  if (!details) return;
  const active = doc.activeElement;
  // A control inside that was turned off while it worked (disabled={busy}) already dropped the focus to the body
  // (Claude 3, cloud M, on #3784); a person who went to another control keeps it, since it is then the active element.
  const inside = active === null || active === undefined || active === doc.body || details.contains(active as never);
  details.open = false;
  if (inside) details.querySelector(":scope > summary")?.focus();
}
