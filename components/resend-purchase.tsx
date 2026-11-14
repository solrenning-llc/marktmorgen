"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES, SESSION_ENDED } from "@/lib/studio-messages";

const UNCERTAIN = "Sending could not be confirmed. Check with the buyer before trying again.";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  unknown: "That sale could not be found on your Stripe account.",
  call: "A booked call has its own confirmation, sent with the calendar file.",
  refunded: "That sale was refunded in full, so there is nothing to send.",
  limited: "That is the most for now: a sale's email can be sent again 3 times a day, and a store's 30 times an hour. Try again later, or write to the buyer yourself.",
  failed: "The email service did not take it just now. Try again in a moment.",
  role: "Your role on this store does not include this.",
  signed_out: SESSION_ENDED,
  server_error: "Stripe or the email service did not answer. Try again in a moment.",
};

/** "Send the purchase email again", on one sale in the studio's list of sales. */
export function ResendPurchase({ reference, email }: { reference: string; email: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col" data-purchase-resend="">
      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        className="inline-flex min-h-11 -my-2.5 items-center text-xs font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep"
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          setError(null);
          try {
            const response = await fetch("/api/store/resend", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reference }),
            });
            const data: unknown = await response.json().catch(() => null);
            const record = data !== null && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
            if (response.ok && record?.ok === true && !Object.prototype.hasOwnProperty.call(record, "error")) {
              toast(`Purchase email accepted for sending to ${email}.`);
            } else {
              const code = record?.ok === false && typeof record.error === "string" && Object.prototype.hasOwnProperty.call(MESSAGES, record.error) ? record.error : null;
              setError(code ? MESSAGES[code] : UNCERTAIN);
            }
          } catch {
            setError(UNCERTAIN);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Sending…" : "Send the purchase email again"}
      </button>
      {error ? (
        <span className="mt-1 text-xs text-danger-text" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
