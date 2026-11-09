"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import { EMAIL_ADDRESS_RULE, wholeAddress } from "@/lib/email-address-rule";

/**
 * Looks up one buyer by their address (lib/buyer-profile.ts). The address is
 * sent once, in the body of a request, and swapped for a token: the page it
 * opens never has the address in its own.
 */
export function PersonFind({ initial = "" }: { initial?: string }) {
  const [email, setEmail] = useState(initial);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          const response = await fetch("/api/store/person", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "find", email }),
          });
          const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; href?: string; error?: string; message?: string };
          if (answer.ok && answer.href) {
            window.location.assign(answer.href);
            return;
          }
          toast(
            // The server's own words first, where it gave them (a figure used, no place this month: lib/metered-limits.ts).
            answer.message ? answer.message : answer.error === "email"
              ? "That is not an email address. Check it and try again."
              : answer.error === "limited"
                ? "That is a lot of lookups in one hour. Try again a little later."
                : "That did not work. Try again in a moment.",
          );
        } catch {
          toast("That did not work. Check your connection and try again.");
        }
        setBusy(false);
      }}
    >
      <label className="min-w-0 flex-1 text-sm">
        <span className="field-label">A buyer&apos;s email address</span>
        <input
          type="email"
          pattern={EMAIL_ADDRESS_RULE}
          title={wholeAddress()}
          required
          autoComplete="off"
          spellCheck={false}
          className="field mt-1 py-2"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
        {busy ? "Looking…" : "Open their page"}
      </button>
    </form>
  );
}
