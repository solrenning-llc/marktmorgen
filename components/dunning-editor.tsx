"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { CARD_NOTICE_DAYS, type Dunning, REMINDER_CHOICES, REMINDER_DAYS, type ReminderCount } from "@/lib/dunning-rules";
import { STUDIO_MESSAGES, SESSION_ENDED } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  dunning: "Pick one, two or three emails.",
  none: "This account has no store yet.",
  signed_out: SESSION_ENDED,
  server_error: "We could not confirm these reminder settings. Reload this page to check before trying again.",
};

const CHOICE_WORDS: Record<ReminderCount, string> = {
  1: "1 email, within a day of it failing",
  2: `2 emails: within a day, and ${REMINDER_DAYS[1]} days after the first`,
  3: `3 emails: within a day, then ${REMINDER_DAYS[1]} and ${REMINDER_DAYS[2]} days after the first`,
};

/** What members are told when a payment fails, and before their card stops working (lib/dunning-rules.ts). */
export function DunningEditor({ dunning, connected }: { dunning: Dunning; connected: boolean }) {
  const router = useRouter();
  const [saved, setSaved] = useState(dunning);
  const [reminders, setReminders] = useState<ReminderCount>(dunning.reminders);
  const [cardNotice, setCardNotice] = useState(dunning.cardNotice);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = reminders !== saved.reminders || cardNotice !== saved.cardNotice;

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/dunning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reminders, cardNotice }),
      });
      const raw: unknown = await response.json().catch(() => null);
      const reply = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      const snapshot = reply?.dunning && typeof reply.dunning === "object" && !Array.isArray(reply.dunning) ? reply.dunning as Record<string, unknown> : null;
      if (response.ok && reply?.ok === true && !("error" in reply) && snapshot?.reminders === reminders && snapshot.cardNotice === cardNotice) {
        setSaved({ reminders, cardNotice });
        toast("Payment reminder settings saved.");
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
    "When a member's payment fails, they get an email from your store with Stripe's page that pays it, with the same card or a new one. The card that pays is used for their next payments too.",
    "Choose up to three emails about the same payment. Each one goes only while it is still unpaid, and none goes once it is paid.",
    `Before a payment fails at all: when the card a member pays with expires before their next payment, they are emailed up to ${CARD_NOTICE_DAYS} days ahead, once per card, with a page that puts a new card on that membership. Nothing is charged there.`,
    "Every email is in your store's language, comes from your store, and replies reach you. Stripe goes on retrying the card on its own schedule.",
  ];

  return (
    <section aria-busy={busy} className="card mt-8 p-6 sm:p-8" aria-labelledby="dunning-title" data-dunning-editor>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="dunning-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          When a member&apos;s payment fails
        </h2>
        <span className={`tag ${connected ? "tag-live" : ""}`}>{connected ? "On" : "Needs Stripe"}</span>
      </div>
      <ul className="mt-4 space-y-2 text-sm text-ink-soft">
        {bullets.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      <form
        className="mt-5 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="block min-w-0" htmlFor="dunning-reminders">
          <span className="field-label">Emails about each failed payment</span>
          <span className="relative mt-2 block min-w-0">
          <select
            id="dunning-reminders"
            disabled={busy}
            className="field block w-full min-w-0 max-w-full appearance-none overflow-hidden pr-10"
            value={reminders}
            onChange={(event) => setReminders(Number(event.target.value) as ReminderCount)}
          >
            {REMINDER_CHOICES.map((n) => (
              <option key={n} value={n}>
                {CHOICE_WORDS[n]}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-soft" />
          </span>
        </label>
        <label className="flex min-h-11 items-center gap-3 text-sm text-ink" htmlFor="dunning-card">
          <input disabled={busy} id="dunning-card" type="checkbox" className="h-5 w-5" checked={cardNotice} onChange={(event) => setCardNotice(event.target.checked)} />
          <span>Email a member before their card expires</span>
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || !changed} aria-busy={busy}>
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
