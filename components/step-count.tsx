import type { Ref } from "react";

/**
 * "Step 2 of 3: Products", or null for a step that is not in the flow: a
 * flow of fewer than two steps, a place outside it, a number that is not
 * whole, or a step with no name. A single form is never given a count.
 */
export function stepWords(current: number, total: number, label: string): string | null {
  if (!Number.isInteger(current) || !Number.isInteger(total) || total < 2 || current < 1 || current > total) return null;
  if (!label.trim()) return null;
  return `Step ${current} of ${total}: ${label}`;
}

/**
 * Where a person is in a flow of real steps (766 [STN13], unit 2), said in
 * words only: no bar, no color. It takes the focus when the flow moves it
 * there (`ref`, tabIndex -1), which reads it once, so it is no live region.
 * Draws nothing for a step that does not exist.
 */
export function StepCount({ current, total, label, ref }: { current: number; total: number; label: string; ref?: Ref<HTMLParagraphElement> }) {
  const words = stepWords(current, total, label);
  if (words === null) return null;
  return (
    <p ref={ref} tabIndex={-1} className="text-sm font-semibold text-ink-soft">
      {words}
    </p>
  );
}
