"use client";

import { useEffect, useState } from "react";
import type { MailAnswer } from "@/lib/mail-response";
import { MAX_FLOW_VERSIONS } from "@/lib/flow-versions-rules";

type Request = (payload: Record<string, unknown>) => Promise<MailAnswer>;
type Version = { at: number; name: string; trigger: string; steps: number };

const ERRORS: Record<string, string> = {
  unknown: "This workflow is not there anymore. Reload the page.",
  version: "That version is not kept anymore. Reload the list.",
  product: "That version starts from, or names, a product your store no longer has. Edit the workflow instead.",
  form: "That version starts from a form your store no longer has, or one without an email field. Edit the workflow instead.",
  stage: "That version starts from a deal stage your store no longer has. Edit the workflow instead.",
  stage_taken: "Another workflow already starts from that deal stage. Edit the workflow instead.",
  step: "A step of that version names something your store no longer has. Edit the workflow instead.",
  goal: "That version's goal names something your store no longer has. Edit the workflow instead.",
  flow_write_unconfirmed: "Putting it back could not be confirmed. Reload the page to see which version is in use.",
};

const when = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * A workflow's earlier versions, newest first, each put back with one button
 * (639 [GL7](19), lib/flow-versions.ts). Putting one back keeps the version
 * in use, so it can be undone the same way, and keeps the workflow on or off.
 */
export function WorkflowVersions({ flowId, request, onRestored }: { flowId: string; request: Request; onRestored: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    request({ action: "flow-versions", id: flowId }).then((a) => {
      if (!live) return;
      if (a.ok && Array.isArray(a.versions)) setVersions(a.versions as Version[]);
      else setError(ERRORS[a.error ?? ""] ?? "The earlier versions could not be read just now. Try again in a moment.");
    });
    return () => {
      live = false;
    };
  }, [flowId, request]);

  async function restore(version: Version) {
    setBusy(true);
    setError(null);
    setDone(null);
    const a = await request({ action: "flow-restore", id: flowId, at: version.at });
    setBusy(false);
    if (!a.ok) return setError(ERRORS[a.error ?? ""] ?? "That version could not be put back just now. Try again in a moment.");
    setDone(`The version from ${when(version.at)} is in use again. The one it replaced is now at the top of this list, so you can undo this the same way.`);
    const again = await request({ action: "flow-versions", id: flowId });
    if (again.ok && Array.isArray(again.versions)) setVersions(again.versions as Version[]);
    onRestored();
  }

  const titleId = `versions-${flowId}`;
  return (
    <section aria-labelledby={titleId} className="mt-3 rounded-[var(--r-sm)] border border-line bg-paper p-4 text-sm">
      <h4 id={titleId} className="font-semibold text-ink">
        Earlier versions
      </h4>
      <p className="mt-1 text-ink-soft">
        {`Each time you save a change to what this workflow does, the version before it is kept here: the last ${MAX_FLOW_VERSIONS}, while your store has room. Putting one back keeps it switched on or off as it is now. Who is already in it carries on from the step they are at.`}
      </p>
      {done ? (
        <p className="notice mt-3" role="status">
          {done}
        </p>
      ) : null}
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
      {versions === null && !error ? (
        <p className="mt-3 text-ink-soft" role="status">
          Reading the earlier versions…
        </p>
      ) : null}
      {versions && versions.length === 0 ? <p className="mt-3 text-ink-soft">No earlier version yet. One is kept the next time you save a change.</p> : null}
      {versions && versions.length ? (
        <ol className="mt-3 space-y-2">
          {versions.map((v) => (
            <li key={v.at} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-sm)] bg-white px-3 py-2">
              <span>
                <span className="font-semibold text-ink">{when(v.at)}</span>
                <span className="text-ink-soft">{` · “${v.name}”, ${v.steps} ${v.steps === 1 ? "step" : "steps"}`}</span>
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                aria-busy={busy}
                disabled={busy}
                aria-label={`Put this version back: ${when(v.at)}`}
                onClick={() => restore(v)}
              >
                Put this version back
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
