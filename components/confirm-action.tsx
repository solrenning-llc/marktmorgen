"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A button for something that cannot be undone (568 [GD2] (h); WCAG 3.3.4 and, at AAA, 3.3.6): the first press
 * asks, in plain words, what will happen; only "Yes, …" does it, and "Keep it" (where focus goes, the safe choice)
 * puts the button back. The same shape as revoking an API key (components/api-key-editor.tsx).
 */
export function ConfirmAction({
  children,
  question,
  yes,
  onConfirm,
  disabled = false,
  busy = false,
  className = "btn btn-ghost btn-sm",
  label,
}: {
  /** What the first button says, as before. */
  children: ReactNode;
  /** What will happen, said before it does: "Delete this post? It cannot be brought back." */
  question: string;
  /** The words of the button that does it: "Yes, delete". */
  yes: string;
  onConfirm: () => void | Promise<unknown>;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
  /** The first button's accessible name, when its words alone do not say what it acts on. */
  label?: string;
}) {
  const [asking, setAsking] = useState(false);
  // When the question closes (Keep it, Escape, or done), the focus goes back to the button that opened it (2.4.3),
  // as the browser's own dialog did, never to the top of the page.
  const trigger = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    if (wasAsking.current && !asking) trigger.current?.focus();
    wasAsking.current = asking;
  }, [asking]);
  if (!asking) {
    return (
      <button ref={trigger} type="button" className={className} disabled={disabled} aria-label={label} onClick={() => setAsking(true)}>
        {children}
      </button>
    );
  }
  return (
    <span role="group" aria-label={question} className="flex flex-wrap items-center gap-2 text-sm" data-confirm-action onKeyDown={(e) => { if (e.key === "Escape") setAsking(false); }}>
      <span className="font-semibold text-ink">{question}</span>
      {/* Unavailable while it waits, but never disabled: a disabled button cannot keep the focus, and the browser
          would drop it to the top of the page (2.4.3). aria-disabled says so, and a press then does nothing. */}
      <button
        type="button"
        className="btn btn-danger btn-sm"
        aria-disabled={disabled || busy || undefined}
        aria-busy={busy}
        onClick={async () => {
          if (disabled || busy || pending.current) return;
          pending.current = true;
          try {
            await onConfirm();
          } finally {
            pending.current = false;
          }
          setAsking(false);
        }}
      >
        {yes}
      </button>
      {/* The safe choice takes focus, so Enter pressed twice by mistake keeps it. */}
      <button type="button" className="btn btn-ghost btn-sm" autoFocus onClick={() => setAsking(false)}>
        Keep it
      </button>
    </span>
  );
}
