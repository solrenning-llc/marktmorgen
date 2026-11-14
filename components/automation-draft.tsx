"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AI_ALLOWANCE_UNKNOWN } from "@/components/ai-assist";
import { MAX_AI_NOTES } from "@/lib/ai-rules";
import { readAiAnswer } from "@/lib/ai-response";
import { type AutomationDraftValue, explainDraft, isAutomationDraftValue, readDraftSaveResult, toFlowRaw } from "@/lib/automation-draft";

/** What is said when a draft is not made, by the reason the server gives. */
const DRAFT_MESSAGES: Record<string, string> = {
  notes: "Write your goal first: what should happen, and to whom.",
  used: "This month's writing help is used up. It starts again with your next billing month.",
  slow: "A few at a time: wait a minute, then try again.",
  failed: "The draft did not come back usable just now. Nothing was saved. Started attempts count toward the monthly allowance. Try again in a moment, or say the goal another way.",
  long: "Your goal is too long to draft from. Say it in fewer words.",
  off: "The writing help is not available right now.",
  forbidden: "Your role on this store cannot save workflows.",
};
const UNCONFIRMED = "Whether a draft was made could not be confirmed. Check your writing allowance before trying again.";

/**
 * A workflow drafted with AI from a goal the creator writes (20 [E3],
 * lib/automation-draft.ts): the draft is shown whole, step by step in the
 * code's own words, every email readable, and only then saved, paused,
 * through the Email Studio's own route, or discarded (and brought back if
 * that was a slip). Nothing is sent or switched on from here.
 */
export function AutomationDraftBox({ ai }: { ai: { on: boolean; left: number; known?: false } }) {
  const [goal, setGoal] = useState("");
  const [left, setLeft] = useState(ai.left);
  const [known, setKnown] = useState(ai.known !== false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saves, setSaves] = useState(0);
  const [value, setValue] = useState<AutomationDraftValue | null>(null);
  const [discarded, setDiscarded] = useState<AutomationDraftValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!ai.on) return null;

  async function draft() {
    if (drafting) return;
    if (!goal.trim()) {
      setError(DRAFT_MESSAGES.notes);
      return;
    }
    setDrafting(true);
    setError(null);
    setMessage("");
    try {
      const response = await fetch("/api/store/automation-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: goal }),
      });
      const data = readAiAnswer(response.ok, await response.json().catch(() => null));
      if (data.ok) {
        setLeft(data.left);
        setKnown(true);
        if (!isAutomationDraftValue(data.value)) {
          setError(UNCONFIRMED);
          return;
        }
        setValue(data.value);
        setDiscarded(null);
        setMessage("Your draft is below. Read each step, then save it paused or discard it.");
        return;
      }
      // An answer the studio cannot place may have counted a job: the allowance is unknown until the page is read again.
      if (!Object.hasOwn(DRAFT_MESSAGES, data.error)) setKnown(false);
      setError(Object.hasOwn(DRAFT_MESSAGES, data.error) ? DRAFT_MESSAGES[data.error] : UNCONFIRMED);
    } catch {
      setKnown(false);
      setError(UNCONFIRMED);
    } finally {
      setDrafting(false);
    }
  }

  async function save() {
    if (!value || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/store/mail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "flow", flow: toFlowRaw(value.draft) }),
      });
      const result = readDraftSaveResult(response.ok, await response.json().catch(() => null));
      if (result === "saved") {
        setMessage(`Saved, paused: “${value.draft.name}” is in Workflows below. Read it there, change what you like, and switch it on when you are ready.`);
        setValue(null);
        setDiscarded(null);
        setSaves((n) => n + 1);
      } else setMessage(result);
    } catch {
      setMessage("Whether it was saved could not be confirmed. Check Workflows below before saving it again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="automation-draft-title" className="card mt-8 p-5">
      <h2 id="automation-draft-title" className="text-lg font-semibold text-ink">
        Start a workflow from a goal
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-soft">
        Say what you want to happen, in your own words. AI drafts a workflow from the steps the Email Studio already has and the products in your store. You read every step first. It is saved paused, and nothing is sent until you switch it on.
      </p>
      <div className="mt-4 space-y-3">
        <label htmlFor="automation-goal" className="block text-sm font-semibold text-ink">Your goal</label>
        <p id="automation-goal-help" className="text-sm text-ink-soft">
          Say what should happen and to whom. For example: remind people who leave the checkout for my course, and stop once they buy. Only your store&apos;s products and links are used.
        </p>
        <textarea
          id="automation-goal"
          className="field"
          rows={3}
          maxLength={MAX_AI_NOTES}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          aria-describedby="automation-goal-help automation-goal-left"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-secondary inline-flex min-h-11 items-center" onClick={() => void draft()} disabled={drafting || busy || !known || left <= 0} aria-busy={drafting}>
            {drafting ? "Drafting…" : "Draft a workflow"}
          </button>
          <span id="automation-goal-left" className="text-xs text-ink-soft">
            {known ? `${left} left this month. Started attempts count, even if they fail.` : AI_ALLOWANCE_UNKNOWN}
          </span>
        </div>
        {error ? (
          <p className="notice notice-error text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {value ? (
        <DraftReview
          value={value}
          busy={busy}
          onSave={() => void save()}
          onDiscard={() => {
            setDiscarded(value);
            setValue(null);
            setMessage("The draft was discarded. Nothing was saved.");
          }}
        />
      ) : null}
      <p role="status" aria-live="polite" className="mt-3 text-sm text-ink">
        {message}
      </p>
      {saves > 0 ? <ShowSaved key={saves} /> : null}
      {discarded && !value ? (
        <button
          type="button"
          className="btn btn-secondary btn-sm inline-flex min-h-11 items-center"
          onClick={() => {
            setValue(discarded);
            setDiscarded(null);
            setMessage("The draft is back.");
          }}
        >
          Bring the draft back
        </button>
      ) : null}
    </section>
  );
}

/** Reads the page again once a save is confirmed, so the new workflow shows in Workflows; what is typed and said here stays. */
function ShowSaved() {
  const router = useRouter();
  useEffect(() => router.refresh(), [router]);
  return null;
}

/** One draft, shown whole: its name, each step in the code's words, every email to read, and the two choices. */
export function DraftReview({ value, busy, onSave, onDiscard }: { value: AutomationDraftValue; busy: boolean; onSave: () => void; onDiscard: () => void }) {
  const lines = explainDraft(value.draft, value.titles);
  const emails = value.draft.steps.flatMap((step) => (step.kind === "email" ? [step] : []));
  return (
    <div className="mt-5 rounded-[var(--r-sm)] bg-sand p-4">
      <p className="text-sm text-ink-soft">Your draft</p>
      <h3 className="mt-1 text-base font-semibold text-ink">{value.draft.name}</h3>
      <ol className="mt-3 list-decimal space-y-1 pl-6 text-sm text-ink">
        {lines.map((text, i) => (
          <li key={i}>{text}</li>
        ))}
      </ol>
      <div className="mt-3 space-y-2">
        {emails.map((step, i) => (
          <details key={i} className="rounded-[var(--r-sm)] bg-white p-3">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-ink">{`Read the email “${step.subject}”`}</summary>
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{step.body}</p>
          </details>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary inline-flex min-h-11 items-center" onClick={onSave} disabled={busy} aria-busy={busy}>{busy ? "Saving…" : "Save it, paused"}</button>
        <button type="button" className="btn btn-secondary inline-flex min-h-11 items-center" onClick={onDiscard} disabled={busy}>Discard this draft</button>
      </div>
    </div>
  );
}
