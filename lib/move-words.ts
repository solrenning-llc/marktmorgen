/**
 * What a "Move … up" or "Move … down" press says, for screen readers (AX274
 * Part A; WCAG 2.2 4.1.3 Status Messages). The place of an item in a list is
 * often only drawn, or drawn with words a screen reader does not read again
 * after the press, so the studio's editors say each move in a polite status
 * line (components/said-line.tsx); and a press at an end, where the button
 * stays focusable instead of turning off under the focus (2.4.3), says the
 * item is already there. tests/move-buttons.test.ts.
 */

/** "Moved Grocery List Pack to place 2 of 3." `to` counts from 0. */
export function movedWords(name: string, to: number, total: number): string {
  return `Moved ${name} to place ${to + 1} of ${total}.`;
}

/** "Grocery List Pack is already first." */
export function endWords(name: string, end: "first" | "last"): string {
  return `${name} is already ${end}.`;
}
