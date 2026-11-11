"use client";

import { useEffect, useState } from "react";
import type { MailAnswer } from "@/lib/mail-response";
import { FLOW_VERSION_PAUSE_SECONDS, MAX_FLOW_VERSIONS } from "@/lib/flow-versions-rules";

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
  // Codex G2 on #1927: an unread history is never "none yet", and a version is put back only once the one it replaces is kept.
  flow_versions_unavailable: "The earlier versions could not be read just now. This does not mean there are none. Try again in a moment.",
  history_room: "The version in use could not be kept, so nothing was put back and nothing changed. Your store may be out of room for data. Free some room, or try again in a moment.",
};
// A version that no longer fits the store as it is now (another workflow took its start, a tag, a form field, a
// route or the plan changed): trying again gives the same answer, so it says what to do instead (Claude 1 on #1927).
const NO_LONGER_FITS = "That version no longer fits your store as it is now, so nothing was put back. Edit the workflow instead.";
for (const reason of ["signed_taken", "paid_request_taken", "tag", "trigger", "name", "placeholder", "route", "steps", "plan", "setup"]) ERRORS[reason] = NO_LONGER_FITS;

/** What the studio said when it would not take the requests this costs (lib/person-tasks.ts, studioRefusal): its own words. */
export const versionError = (a: MailAnswer, fallback: string) =>
  (a.error === "studio_used" || a.error === "unavailable") && typeof a.message === "string" && a.message ? a.message : (Object.hasOwn(ERRORS, a.error ?? "") ? ERRORS[a.error ?? ""] : fallback);
const errorOf = versionError;

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
      else setError(errorOf(a, "The earlier versions could not be read just now. Try again in a moment."));
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
    if (!a.ok) return setError(errorOf(a, "That version could not be put back just now. Try again in a moment."));
    // Said only when a version was kept: putting back what is already in use replaces nothing (Claude 5 on #1927).
    setDone(
      a.kept === true
        ? `The version from ${when(version.at)} is in use again. The one it replaced is now at the top of this list, so you can undo this the same way.`
        : `The version from ${when(version.at)} is already what this workflow does, so nothing changed and nothing new was kept.`,
    );
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
        {`When you save a change to what this workflow does, the version before it is kept here, at most one every ${FLOW_VERSION_PAUSE_SECONDS / 60} minutes while you keep editing: the last ${MAX_FLOW_VERSIONS}, while your store has room. Reading this list and putting a version back use more of your studio requests when the workflow is long. Putting one back keeps it switched on or off as it is now. Who is already in it goes on at the same step number in the version you put back; if that version has fewer steps, their run ends there, as when you remove a step.`}
      </p>
      {/* Kept mounted, empty until there is something to say, so a screen reader announces what is put into it. */}
      <div role="status">
        {done ? <p className="notice mt-3">{done}</p> : null}
      </div>
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
