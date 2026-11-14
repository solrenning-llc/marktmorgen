"use client";

import { useEffect, useRef } from "react";

/**
 * The line at the top of a community page that answers what a person just
 * did ("Write something first.", "Posted."), drawn by the server after the
 * form was sent (the address's ?n=). A role=status that is already there when
 * a page loads is not read out, so the line takes the keyboard's focus once
 * when the page opens: a screen reader reads it once, and the next Tab goes
 * on from there (WCAG 4.1.3). It is not a Tab stop of its own (tabIndex -1).
 */
export function CommunityFlash({ text, warn = false, className = "" }: { text: string; warn?: boolean; className?: string }) {
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    line.current?.focus();
  }, []);
  return (
    <p ref={line} tabIndex={-1} className={`cm-flash ${className} ${warn ? "cm-flash-warn" : ""}`} role="status">
      {text}
    </p>
  );
}
