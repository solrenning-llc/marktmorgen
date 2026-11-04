"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import type { AccessMap, PipelineAccess } from "@/lib/pipeline-access-rules";

type Member = { email: string; role: "editor" | "support" };

const WORDS: Record<PipelineAccess, string> = { edit: "Can change", view: "Can only see", none: "No access" };

/**
 * Who on the team may see and change each sales pipeline (639 [GL7](7),
 * unit 3), on the team page. One choice per teammate and pipeline: can
 * change (as before), can only see, or no access. Admins and the owner are
 * never restricted, and the page says so. Each choice is saved on its own,
 * and the previous one is a choice away.
 */
export function PipelineAccessEditor({ members, pipelines, initial }: { members: Member[]; pipelines: { id: string; name: string }[]; initial: Record<string, AccessMap | null> }) {
  const [access, setAccess] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function choose(email: string, pipeline: { id: string; name: string }, value: PipelineAccess) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/store/pipeline-access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, pipeline: pipeline.id, access: value }) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; access?: AccessMap; message?: string; error?: string };
      if (answer.ok && answer.access) {
        setAccess((all) => ({ ...all, [email]: answer.access! }));
        toast(`${email}: ${WORDS[value].toLowerCase()} in ${pipeline.name}.`);
      } else {
        setError(answer.message ?? (answer.error === "data_full" ? "Your store's data room is full. Delete something you no longer need first." : "That did not save. Try again in a moment."));
      }
    } catch {
      setError("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {members.length ? (
        <ul className="mt-4 space-y-5">
          {members.map((member) => {
            const map = access[member.email];
            return (
              <li key={member.email}>
                <fieldset className="rounded-xl bg-paper p-4 ring-1 ring-line">
                  <legend className="px-1 text-sm font-semibold text-ink [overflow-wrap:anywhere]">{member.email}</legend>
                  {map === null ? <p className="mt-1 text-sm text-danger-text">This person&apos;s access could not be read, so they see no pipeline until it is saved again.</p> : null}
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    {pipelines.map((pipeline) => {
                      const current: PipelineAccess = map === null ? "none" : (map?.[pipeline.id] ?? "edit");
                      return (
                        <label key={pipeline.id} className="block min-w-0 text-sm">
                          <span className="field-label [overflow-wrap:anywhere]">{pipeline.name}</span>
                          <select className="field mt-1" value={current} disabled={busy} onChange={(event) => void choose(member.email, pipeline, event.target.value as PipelineAccess)}>
                            {(["edit", "view", "none"] as const).map((value) => (
                              <option key={value} value={value}>
                                {WORDS[value]}
                              </option>
                            ))}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-ink-soft">Nobody on your team can be restricted yet: only Editors and Support can. Admins and you see and change every pipeline.</p>
      )}
      <p className="mt-3 text-sm text-danger-text" role="alert">
        {error}
      </p>
    </div>
  );
}
