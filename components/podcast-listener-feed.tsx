"use client";

import { useId, useState } from "react";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

/** What the studio says after a listener's feed address was replaced (lib/podcast-access.ts, replaceFeed). */
export const LISTENER_FEED_RESULTS: Record<string, string> = {
  sent: "Done. Their old feed address no longer works, and we emailed them a new one. Their podcast app will need the new address.",
  ended: "Done. Their old feed address no longer works. That email no longer has this podcast, so no new address was sent.",
  none: "That email has no feed of this podcast, so nothing changed. Check the address and try again.",
  unsent: "Their old feed address no longer works, but the email with the new one could not be sent. They can get it on the podcast's page with “Email me my feed”.",
};

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  email: "That does not look like an email address. Type the address the listener bought with.",
  limited: "You have replaced many feed addresses this hour. Try again in an hour.",
  unknown: "This podcast is no longer here. Reload the page.",
  unavailable: "We could not check that listener just now, so nothing changed. Try again in a moment.",
};

type Answer = { ok: boolean; error?: string; result?: string };

/**
 * One listener's feed address that got out, replaced by the creator (audit of private podcasts, M3): the old address
 * stops working at once, and the listener gets a new one by email. Asked once more before anything changes (WCAG
 * 3.3.6); what happened is said in a live region.
 */
export function PodcastListenerFeed({ productId }: { productId: string }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null);

  async function replace(): Promise<void> {
    setBusy(true);
    setSaid(null);
    let answer: Answer;
    try {
      const response = await fetch("/api/store/podcast/listener", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: productId, email: email.trim() }) });
      answer = (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Answer;
    } catch {
      answer = { ok: false, error: "server_error" };
    }
    setBusy(false);
    setConfirming(false);
    if (answer.ok && answer.result && LISTENER_FEED_RESULTS[answer.result]) {
      setSaid({ text: LISTENER_FEED_RESULTS[answer.result], error: answer.result === "unsent" || answer.result === "none" });
      if (answer.result !== "none") setEmail("");
      return;
    }
    setSaid({ text: MESSAGES[answer.error ?? ""] ?? MESSAGES.server_error ?? "Something went wrong. Try again.", error: true });
  }

  return (
    <section className="card mt-6 p-6 sm:p-8" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="text-lg font-semibold tracking-[-0.02em] text-ink">A listener&apos;s feed address got out?</h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-soft">
        If a listener&apos;s private feed was shared, give them a new one. Their old address stops working at once. If they still
        have the podcast, we email them the new address; their podcast app will need it. Nobody else sees it, not even you.
      </p>
      <div className="mt-4 space-y-3">
        <div>
          <label htmlFor={`${id}-email`} className="field-label">The listener&apos;s email</label>
          <input
            id={`${id}-email`}
            className="field mt-1"
            type="email"
            autoComplete="off"
            maxLength={320}
            value={email}
            disabled={confirming || busy}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="listener@example.com"
          />
        </div>
        {confirming ? (
          <div className="space-y-3">
            <p className="font-semibold text-ink">{`Replace the feed address of ${email.trim()}? Their app stops getting episodes until they add the new address from our email.`}</p>
            <div className="flex flex-wrap gap-3">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void replace()}>
                {busy ? "Replacing…" : "Yes, replace it"}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" disabled={!email.trim()} onClick={() => { setSaid(null); setConfirming(true); }}>
            Replace their feed address
          </button>
        )}
        <p className={said?.error ? "notice notice-error" : said ? "notice" : "sr-only"} role="status" aria-live="polite">{said?.text ?? ""}</p>
      </div>
    </section>
  );
}
