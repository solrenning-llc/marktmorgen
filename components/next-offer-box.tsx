"use client";

import { useState } from "react";
import type { ReactNode } from "react";

/**
 * The frame of the next product suggested after a purchase
 * (components/next-offer-card.tsx): what the server drew, the way to the
 * product's own page, and "No thanks", which hides it here and keeps it
 * from the page and the email for this order (app/api/store/assistant-next).
 *
 * The buyer is told it won't be suggested again only when the server says it
 * kept that ({ ok: true }). A rate limit, an order with nothing kept, a page
 * that is not the answer or a dropped connection keeps the offer and says it
 * did not go through, so No thanks can be pressed again.
 */
export function NextOfferBox({
  handle,
  session,
  href,
  see,
  dismiss,
  dismissed,
  failed,
  note,
  children,
}: {
  handle: string;
  session: string;
  href: string;
  see: string;
  dismiss: string;
  dismissed: string;
  /** Said when the dismissal was not kept. */
  failed: string;
  note: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<"shown" | "sending" | "failed" | "gone">("shown");

  async function hide() {
    if (state === "sending") return;
    setState("sending");
    let kept = false;
    try {
      const response = await fetch("/api/store/assistant-next", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ h: handle, s: session }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: unknown } | null;
      kept = response.ok && data?.ok === true;
    } catch {
      kept = false;
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
            // aria-disabled, not disabled: a disabled button drops the keyboard focus.
            aria-disabled={state === "sending"}
            className="st-footer-link inline-flex min-h-11 items-center px-1 text-sm font-semibold"
          >
            {dismiss}
          </button>
        </div>
        {state === "failed" ? (
          <p className="mt-3 text-sm font-semibold" role="alert">
            {failed}
          </p>
        ) : null}
        {note ? <p className="st-muted mt-3 text-xs">{note}</p> : null}
      </div>
    </section>
  );
}
