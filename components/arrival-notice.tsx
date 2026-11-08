"use client";

import { type ReactNode, useEffect, useRef } from "react";

/**
 * A notice a page is drawn with after a form sent it back there (a plain
 * POST answered by a redirect, such as "?link=sent"): the page loads afresh,
 * so the focus would start at its top and a screen reader would not reach
 * the answer. The notice takes the focus once, when it is first drawn, and
 * is read out where it stands; it is never focused again on its own.
 */
export function ArrivalNotice({ className, children }: { className: string; children: ReactNode }) {
  const own = useRef<HTMLDivElement>(null);
  useEffect(() => {
    own.current?.focus();
  }, []);
  return (
    <div ref={own} tabIndex={-1} data-arrival="focus" role="status" className={className}>
      {children}
    </div>
  );
}
