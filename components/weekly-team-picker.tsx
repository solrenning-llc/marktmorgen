"use client";

import { useState } from "react";
import { toast, toastProblem } from "@/components/toast";

/**
 * Which team members get the weekly email too (lib/stats-report.ts). Only
 * members whose role sees the numbers are offered; each gets their own stop link.
 */
export function WeeklyTeamPicker({ members, chosen }: { members: string[]; chosen: string[] }) {
  const [picked, setPicked] = useState(new Set(chosen));
  const [busy, setBusy] = useState(false);
  if (!members.length) return null;
  async function save(next: Set<string>) {
    setBusy(true);
    try {
      const response = await fetch("/api/store/weekly-team", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emails: [...next] }) });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; emails?: string[] };
      if (body.ok && body.emails) {
        setPicked(new Set(body.emails));
        toast("Saved.");
      } else toastProblem("That did not save. Try again.");
    } catch {
      toastProblem("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset className="mt-4">
      <legend className="text-sm font-bold text-ink">Send the weekly email to your team too</legend>
      <div className="mt-2 space-y-1.5">
        {members.map((email) => (
          <label key={email} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-violet-brand"
              checked={picked.has(email)}
              disabled={busy}
              onChange={(e) => {
                const next = new Set(picked);
                if (e.target.checked) next.add(email);
                else next.delete(email);
                void save(next);
              }}
            />
            <span className="text-ink">{email}</span>
          </label>
        ))}
      </div>
      <p className="mt-1 text-xs text-ink-soft">The same email you get on Mondays, with their own link to stop their copy. Only team members who can see your numbers are listed.</p>
    </fieldset>
  );
}
