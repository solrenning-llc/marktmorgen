"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { parseYearlyAsk, type YearlyAsk } from "@/lib/yearly-switch-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  address: "Type the postal address where you can be reached. The law in the United States asks every email like this to carry one.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  server_error: "We could not confirm these yearly offer settings. Reload this page to check before trying again.",
};

/** The one email offering monthly members the yearly price (lib/yearly-ask.ts, lib/yearly-switch-rules.ts). */
export function YearlyAskEditor({ ask, suggestedAddress, sent, offersYearly }: { ask: YearlyAsk; suggestedAddress: string; sent: number | null; offersYearly: boolean }) {
  const router = useRouter();
  const [saved, setSaved] = useState(ask);
  const [on, setOn] = useState(ask.on);
  const [address, setAddress] = useState(ask.address || suggestedAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    const expected = parseYearlyAsk({ on, address });
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/yearly-ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on, address }) });
      const raw: unknown = await response.json().catch(() => null);
      const reply = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      const snapshot = reply?.yearlyAsk && typeof reply.yearlyAsk === "object" && !Array.isArray(reply.yearlyAsk) ? reply.yearlyAsk as Record<string, unknown> : null;
      if (response.ok && reply?.ok === true && !("error" in reply) && snapshot?.on === expected.on && snapshot.address === expected.address) {
        setSaved(expected);
        setOn(expected.on);
        setAddress(expected.address);
        toast("Yearly offer email settings saved.");
        router.refresh();
        return;
      }
      const problem = reply?.ok !== true && typeof reply?.error === "string" && Object.hasOwn(MESSAGES, reply.error) ? MESSAGES[reply.error] : null;
      setError(problem ?? MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  const bullets = [
    "Every member paying monthly for a membership with a yearly price sees “Pay yearly” on their membership page, with what it saves. Before anything is charged, Stripe works out the exact amount: the year, less what is left of the month they already paid.",
    "Turn on the email and each of them also gets one email from your store, from their third monthly payment on: what they pay now, what a year costs and what it saves. Once per membership, ever, and only if they agreed to hear from you and have not left your list.",
    "Never offered where it would cost you: not on a membership with a discount, nor while an affiliate's share for a set number of months still runs on it, and only where a year costs the member less than twelve of their own monthly payments.",
  ];

  return (
    <section aria-busy={busy} className="card mt-8 p-6 sm:p-8" aria-labelledby="yearly-ask-title" data-yearly-ask-editor>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="yearly-ask-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Monthly members switching to yearly
        </h2>
        <span className={`tag ${saved.on ? "tag-live" : ""}`}>{saved.on ? "Email on" : "Email off"}</span>
      </div>
      <ul className="mt-4 space-y-2 text-sm text-ink-soft">
        {bullets.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      {offersYearly ? null : (
        <p className="notice mt-4 text-sm" data-yearly-none>
          None of your memberships has a yearly price yet. Give a monthly membership one in its product settings, under “Or pay yearly”, and its members can switch.
        </p>
      )}
      {saved.on ? <p className="mt-3 text-sm text-ink">{sent === null ? "How many were sent this month could not be counted just now. Reload the page in a minute to see it." : `Sent this month: ${sent}`}</p> : null}
      <form
        className="mt-5 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="flex min-h-11 items-center gap-3 text-sm font-semibold text-ink" htmlFor="yearly-ask-on">
          <input disabled={busy} id="yearly-ask-on" type="checkbox" className="h-5 w-5" checked={on} onChange={(event) => setOn(event.target.checked)} />
          <span>Email monthly members the yearly price, once</span>
        </label>
        <label className="block" htmlFor="yearly-ask-address">
          <span className="field-label">Your postal address, printed at the bottom</span>
          <input disabled={busy} id="yearly-ask-address" className="field mt-2" maxLength={300} value={address} onChange={(event) => setAddress(event.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
