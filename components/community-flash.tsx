"use client";

import { useEffect, useRef } from "react";

/**
 * A line that answers what a person just did, drawn by the server on the page
 * they come back to after a form was sent. A role=status that is already
 * there when a page loads is not read out, so the line takes the keyboard's
 * focus once when the page opens: a screen reader reads it once, and the next
 * Tab goes on from there (WCAG 4.1.3). It is not a Tab stop of its own
 * (tabIndex -1). Used as it is on the unsubscribe page ("not saved").
 */
export function FocusedStatus({ text, className = "" }: { text: string; className?: string }) {
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    line.current?.focus();
  }, []);
  return (
    <p ref={line} tabIndex={-1} className={className} role="status">
      {text}
    </p>
  );
}

/** The community's line at the top of a page ("Write something first.", "Posted."), in its own look. */
export function CommunityFlash({ text, warn = false, className = "" }: { text: string; warn?: boolean; className?: string }) {
  return <FocusedStatus text={text} className={`cm-flash ${className} ${warn ? "cm-flash-warn" : ""}`} />;
}
