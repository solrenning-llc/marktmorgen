"use client";

import { useEffect, useRef } from "react";

/**
 * What the route answered, on the page it sent the buyer back to (567 [GD1] (a)).
 * A status region already on the page when it loads is not read out, so the
 * result takes the focus on arrival: a screen reader reads it, and the next
 * Tab goes on from there (WCAG 4.1.3, 2.4.3). It is a sentence, never colour
 * alone.
 */
export function ProblemNotice({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <div ref={box} role="status" tabIndex={-1} data-problem-notice className="st-note mt-5">
      <p className="font-bold" style={{ color: "var(--st-text)" }}>
        {text}
      </p>
    </div>
  );
}
