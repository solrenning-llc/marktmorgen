"use client";

import { useState } from "react";
import type { ReactNode } from "react";

/**
 * The frame of the next product suggested after a purchase
 * (components/next-offer-card.tsx): what the server drew, the way to the
 * product's own page, and "No thanks", which hides it here and keeps it
 * from the page and the email for this order (app/api/store/assistant-next).
 * Only a reply of `200 { ok: true }` is a kept no; any other reply keeps the
 * box, says the answer was not saved, and leaves "No thanks" to try again.
 */
export function NextOfferBox({
  handle,
  session,
  href,
  see,
  dismiss,
  dismissed,
  unsaved,
  note,
  children,
}: {
  handle: string;
  session: string;
  href: string;
  see: string;
  dismiss: string;
  dismissed: string;
  unsaved: string;
  note: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<"shown" | "sending" | "gone" | "failed">("shown");

  async function hide() {
    setState("sending");
    let kept = false;
    try {
      const response = await fetch("/api/store/assistant-next", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ h: handle, s: session }),
      });
      const reply = (await response.json().catch(() => null)) as { ok?: unknown } | null;
      kept = response.ok && reply?.ok === true;
    } catch {
      // No reply: the no was not kept, so it is not confirmed.
    }
    setState(kept ? "gone" : "failed");
  }

  if (state === "gone") {
    return (
      <p className="st-muted mt-6 text-sm" role="status">
        {dismissed}
      </p>
    );
  }
  return (
    <section aria-labelledby="next-offer-title" className="mt-7 overflow-hidden rounded-2xl" style={{ border: "1px solid var(--st-line)" }} data-next-offer="">
      {children}
      <div className="px-5 pb-5 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <a href={href} className="btn st-btn">
            {see}
          </a>
          <button
            type="button"
            onClick={() => void hide()}
            disabled={state === "sending"}
            className="st-footer-link inline-flex min-h-11 items-center px-1 text-sm font-semibold"
          >
            {dismiss}
          </button>
        </div>
        {state === "failed" ? (
          <p role="alert" className="mt-3 text-sm font-semibold">
            {unsaved}
          </p>
        ) : null}
        {note ? <p className="st-muted mt-3 text-xs">{note}</p> : null}
      </div>
    </section>
  );
}
