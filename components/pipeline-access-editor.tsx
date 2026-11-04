"use client";

import { useState } from "react";
import { pipelineNames } from "@/lib/crm-rules";
import type { AccessMap, PipelineAccess } from "@/lib/pipeline-access-rules";

type Member = { email: string; role: "editor" | "support" };

const WORDS: Record<PipelineAccess, string> = { edit: "Can change", view: "Can only see", none: "No access" };

/** What a teammate has for each pipeline as kept, or as an unreadable record leaves it (no access). */
function currentOf(map: AccessMap | null | undefined, pipelineId: string): PipelineAccess {
  return map === null ? "none" : (map?.[pipelineId] ?? "edit");
}

/**
 * Who on the team may see and change each sales pipeline (639 [GL7](7),
 * unit 3), on the team page. One choice per teammate and pipeline: can
 * change (as before), can only see, or no access. Admins and the owner are
 * never restricted, and the page says so for the roles the team has. A teammate's choices are saved
 * together with their own Save button, never on each change of a choice
 * (moving through a choice with the arrow keys changes nothing until Save),
 * and what happened is said inside that teammate's group. A Save sends the
 * record as this page read it, so one from a page opened before another
 * change is refused with a sentence to reload, never written over it.
 */
export function PipelineAccessEditor({ members, pipelines, initial }: { members: Member[]; pipelines: { id: string; name: string }[]; initial: Record<string, AccessMap | null> }) {
  const [access, setAccess] = useState(initial);
  // What is chosen but not saved yet, by teammate and pipeline.
  const [draft, setDraft] = useState<Record<string, Record<string, PipelineAccess>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Record<string, { kind: "status" | "error"; text: string }>>({});
  // The one live region of the editor: each message is shown in its teammate's group and said once here,
  // with the teammate's address first. A message said again (the same refusal twice) is said again,
  // by turning a trailing no-break space on or off, so pressing Save is never met with silence.
  const [heard, setHeard] = useState({ text: "", turn: false });
  const say = (email: string, kind: "status" | "error", text: string) => {
    setSaid((all) => ({ ...all, [email]: { kind, text } }));
    setHeard((was) => ({ text: `${email}: ${text}`, turn: !was.turn }));
  };
  // Two pipelines may share a name: each choice reads as the board shows it, "Sales" and "Sales (2)".
  const names = pipelineNames(pipelines);
  const nameOf = (p: { id: string; name: string }) => names.get(p.id) ?? p.name;

  const chosen = (email: string, pipelineId: string): PipelineAccess => draft[email]?.[pipelineId] ?? currentOf(access[email], pipelineId);
  // A record that could not be read is always something to save: Save writes it whole, even when every
  // choice is left at No access, so it never stays unreadable.
  const changed = (email: string) => access[email] === null || pipelines.some((p) => chosen(email, p.id) !== currentOf(access[email], p.id));

  async function save(email: string) {
    if (busy) {
      say(email, "status", "Another teammate's access is being saved. Press Save again in a moment.");
      return;
    }
    if (!changed(email)) {
      say(email, "status", "Nothing to save: choose a different access for a pipeline first.");
      return;
    }
    const choices = Object.fromEntries(pipelines.map((p) => [p.id, chosen(email, p.id)]));
    // The record as this page has it: a change made since in another tab, or by someone else, is never written over.
    const was = access[email] === undefined ? {} : access[email];
    setBusy(email);
    say(email, "status", "Saving…");
    try {
      const response = await fetch("/api/store/pipeline-access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, choices, was }) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; access?: AccessMap; message?: string; error?: string };
      if (answer.ok && answer.access) {
        const kept = answer.access;
        setAccess((all) => ({ ...all, [email]: kept }));
        setDraft((all) => ({ ...all, [email]: {} }));
        // Said from what was kept, never from what was asked.
        say(email, "status", `Saved. ${pipelines.map((p) => `${nameOf(p)}: ${WORDS[currentOf(kept, p.id)].toLowerCase()}`).join("; ")}.`);
      } else {
        say(email, "error", answer.message ?? (answer.error === "data_full" ? "Your store has no room left for more records. Delete some you no longer need, then save again." : "That did not save. Try again in a moment."));
      }
    } catch {
      say(email, "error", "That did not save. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {heard.text ? `${heard.text}${heard.turn ? "\u00a0" : ""}` : ""}
      </p>
      {members.length ? (
        <ul className="mt-4 space-y-5">
          {members.map((member) => {
            const map = access[member.email];
            const slug = member.email.replace(/[^a-z0-9]/gi, "-");
            const message = said[member.email];
            const errorId = `pipeline-access-error-${slug}`;
            return (
              <li key={member.email}>
                <fieldset className="rounded-xl bg-paper p-4 ring-1 ring-line">
                  <legend className="px-1 text-sm font-semibold text-ink [overflow-wrap:anywhere]">{member.email}</legend>
                  {map === null ? <p className="mt-1 text-sm text-danger-text">This person&apos;s access could not be read, so they see no pipeline. Choose what they may do with each one and save; the others stay at No access until you do.</p> : null}
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    {pipelines.map((pipeline) => (
                      <label key={pipeline.id} className="block min-w-0 text-sm">
                        <span className="field-label [overflow-wrap:anywhere]">{nameOf(pipeline)}</span>
                        <select
                          className="field mt-1"
                          value={chosen(member.email, pipeline.id)}
                          // Never aria-invalid: every choice offered is a valid one, and no refusal (busy, changed
                          // elsewhere, no room, no connection) says a chosen value is wrong; the error is tied to
                          // the choices by aria-describedby instead (WCAG 3.3.1, 4.1.2).
                          aria-describedby={message?.kind === "error" ? errorId : undefined}
                          onChange={(event) => {
                            const value = event.target.value as PipelineAccess;
                            setDraft((all) => ({ ...all, [member.email]: { ...all[member.email], [pipeline.id]: value } }));
                          }}
                        >
                          {(["edit", "view", "none"] as const).map((value) => (
                            <option key={value} value={value}>
                              {WORDS[value]}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <button type="button" className="btn btn-secondary btn-sm" aria-disabled={busy !== null || undefined} aria-describedby={message?.kind === "error" ? errorId : undefined} onClick={() => void save(member.email)}>
                      Save
                      <span className="sr-only">{` the access of ${member.email}`}</span>
                    </button>
                    {changed(member.email) ? <span className="text-sm text-ink-soft">Not saved yet.</span> : null}
                  </div>
                  {/* Shown here, beside the Save button, and said once by the editor's one live region above. */}
                  {message?.kind === "status" ? <p className="mt-2 text-sm text-ink-soft">{message.text}</p> : null}
                  <p id={errorId} className="mt-2 text-sm text-danger-text" hidden={message?.kind !== "error"}>
                    {message?.kind === "error" ? message.text : ""}
                  </p>
                </fieldset>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-ink-soft">Nobody on your team can be restricted yet: only Support people can.</p>
      )}
    </div>
  );
}
