"use client";

import { useId, useState } from "react";
import type { FunnelLaunchIssue } from "@/lib/funnel-launch-review";
import type { FunnelExplanation } from "@/lib/funnel-explain";

/** Drawn by the page above every explanation, never written by the model (lib/funnel-explain.ts). */
export const EXPLAIN_LABEL = "AI explanation: written by AI from this check. The check decides; this only explains it.";

/** What each refusal of app/api/store/funnel-explain means, in plain words. */
export function explainErrorText(reason: string): string {
  switch (reason) {
    case "used":
      return "You have used this month's AI writing jobs. They come back when your plan's month renews.";
    case "off":
      return "AI writing is not part of this store's plan right now.";
    case "stale":
      return "This check has changed since the page loaded. Reload the page to see the current checks.";
    case "gone":
      return "This funnel no longer exists. Reload the page.";
    case "unknown":
      return "The funnel could not be checked just now. Nothing was used. Try again in a moment.";
    case "failed":
      return "No explanation could be written this time. The attempt used one AI writing job.";
    case "slow":
    case "studio":
      return "Too many requests right now. Try again in a minute.";
    default:
      return "Something went wrong. Reload the page and try again.";
  }
}

const readExplanation = (value: unknown): FunnelExplanation | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.why !== "string" || !Array.isArray(record.todo) || !record.todo.every((item) => typeof item === "string")) return null;
  return { why: record.why, todo: record.todo as string[] };
};

/**
 * "Explain this with AI" beside one funnel check (26 [E9]): one of the month's
 * AI writing jobs, asked only when pressed, shown under a label the page draws.
 * The check itself is not changed, hidden or reordered by anything here.
 */
export function FunnelIssueExplain({ funnelId, issue, left, onLeft }: {
  funnelId: string;
  issue: FunnelLaunchIssue;
  /** The month's AI writing jobs left, as the studio last read them. */
  left: number;
  onLeft: (left: number) => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const [answer, setAnswer] = useState<FunnelExplanation | null>(null);

  async function ask() {
    if (busy) return;
    setBusy(true);
    setSaid("Writing an explanation.");
    try {
      const response = await fetch("/api/store/funnel-explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ funnel: funnelId, issue }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: unknown; value?: unknown; left?: unknown; error?: unknown } | null;
      const value = body?.ok === true ? readExplanation(body.value) : null;
      if (value) {
        setAnswer(value);
        setSaid("The explanation is shown below this check.");
        if (typeof body?.left === "number" && Number.isSafeInteger(body.left) && body.left >= 0) onLeft(body.left);
      } else {
        const reason = typeof body?.error === "string" ? body.error : "";
        setSaid(explainErrorText(reason));
        if (reason === "failed") onLeft(Math.max(0, left - 1));
        if (reason === "used") onLeft(0);
      }
    } catch {
      setSaid(explainErrorText(""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      {answer ? (
        <div role="group" aria-labelledby={`${id}-label`} className="mt-1 rounded-lg border border-line p-3">
          <p id={`${id}-label`} className="text-xs font-semibold text-ink-soft">{EXPLAIN_LABEL}</p>
          <p className="mt-2 text-ink">{answer.why}</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink">
            {answer.todo.map((step, index) => <li key={index}>{step}</li>)}
          </ol>
          <button type="button" className="btn btn-ghost mt-2 inline-flex min-h-11 items-center" onClick={() => { setAnswer(null); setSaid("The explanation was hidden."); }}>
            Hide the explanation
          </button>
        </div>
      ) : (
        <>
          <button type="button" className="btn btn-ghost inline-flex min-h-11 items-center" aria-describedby={`${id}-cost`} disabled={busy || left < 1} onClick={ask}>
            {busy ? "Writing an explanation…" : "Explain this with AI"}
          </button>
          <p id={`${id}-cost`} className="mt-1 text-xs text-ink-soft">
            {left < 1 ? "No AI writing jobs are left this month." : `Uses 1 of your ${left} AI writing jobs left this month.`} The check above stays as it is.
          </p>
        </>
      )}
      <p role="status" aria-live="polite" className="mt-1 text-xs text-ink-soft">{said}</p>
    </div>
  );
}
