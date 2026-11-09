"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AiAssist, AiOn } from "@/components/ai-assist";
import { type AutomationDraftValue, explainDraft, isAutomationDraftValue, readDraftSaveResult, toFlowRaw } from "@/lib/automation-draft";

/**
 * A workflow drafted with AI from a goal the creator writes (20 [E3],
 * lib/automation-draft.ts): the draft is shown whole, step by step in the
 * code's own words, every email readable, and only then saved, paused,
 * through the Email Studio's own route, or discarded (and brought back if
 * that was a slip). Nothing is sent or switched on from here.
 */
export function AutomationDraftBox({ ai }: { ai: { on: boolean; left: number; known?: false } }) {
  const [saves, setSaves] = useState(0);
  const [value, setValue] = useState<AutomationDraftValue | null>(null);
  const [discarded, setDiscarded] = useState<AutomationDraftValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!ai.on) return null;

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
      <div className="mt-4">
        <AiOn value={ai}>
          <AiAssist<AutomationDraftValue>
            title="Draft a workflow with AI"
            hint="Say what should happen and to whom. For example: welcome new subscribers, then offer the course a few days later. Only your store's products and links are used."
            placeholder="For example: remind people who leave the checkout for my course, and stop once they buy."
            payload={() => ({ kind: "automation" })}
            validateResult={isAutomationDraftValue}
            onResult={(drafted) => {
              setValue(drafted);
              setDiscarded(null);
              setMessage("");
            }}
            done="Your draft is below. Read each step, then save it paused or discard it."
          />
        </AiOn>
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
