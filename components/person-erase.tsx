"use client";

import { useState } from "react";
import { keptLines, linesOf } from "@/lib/person-data";

const ERRORS: Record<string, string> = {
  confirm: "Type DELETE in capital letters to confirm.",
  expired: "This page's search ran out: it works for an hour. Find the person again, then delete them.",
  incomplete: "Part of it could not be deleted just now. They are already kept from your emails. Press Delete again in a moment to finish; nothing is deleted twice.",
  limited: "Nothing was deleted: your store's studio requests are used until its allowance opens again.",
  unavailable: "That could not be done just now. Nothing was deleted. Try again in a moment.",
  email: "This person's address could not be read. Nothing was deleted.",
};

/**
 * "Delete this person" on a buyer's page (lib/person-erasure.ts), for the
 * owner and admins. It says, before anything happens, exactly what goes,
 * what stays and why, from the registry the erasure itself runs from
 * (lib/person-data.ts), and asks for DELETE to be typed.
 */
export function PersonErase({ token, email }: { token: string; email: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The month's budget for people's data requests was used up: the deletion is scheduled, with the date it is done by.
  const [scheduled, setScheduled] = useState("");

  async function erase() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/store/person", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "erase", token, confirm: typed.trim() }),
      });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; href?: string; error?: string; message?: string };
      if (answer.ok && answer.href) {
        window.location.assign(answer.href);
        return;
      }
      if (answer.error === "scheduled" && answer.message) {
        setScheduled(answer.message);
        return;
      }
      setError(((answer.error === "limited" || answer.error === "unavailable") && answer.message) || ERRORS[answer.error ?? ""] || ERRORS.unavailable);
    } catch {
      setError("That did not go through. Check your connection and try again. Nothing was deleted.");
    } finally {
      setBusy(false);
    }
  }

  const deleted = linesOf("erased", "team");
  const fingerprint = linesOf("suppression")[0] ?? "";
  const kept = keptLines("team");
  const notYet = linesOf("open");

  return (
    <div>
      {!open ? (
        <button type="button" className="btn btn-danger btn-sm mt-4" onClick={() => setOpen(true)} aria-expanded={false} aria-controls="erase-panel">
          Delete this person
        </button>
      ) : (
        <div id="erase-panel" className="mt-4 rounded-2xl border-2 border-pink-brand/30 bg-white p-5" role="region" aria-labelledby="erase-heading">
          <h3 id="erase-heading" className="text-base font-semibold text-ink [overflow-wrap:anywhere]">{`Delete ${email} from your store`}</h3>
          <p className="mt-2 text-sm text-ink-soft">This cannot be undone. It happens at once, for your whole team, or, if your store has used up this month&apos;s budget for people&apos;s data requests, by itself within a month.</p>

          <h4 className="mt-4 text-sm font-semibold text-ink">Deleted</h4>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
            {deleted.map((line) => (
              <li key={line}>{line}.</li>
            ))}
          </ul>

          <h4 className="mt-4 text-sm font-semibold text-ink">Kept, and why</h4>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
            <li>{fingerprint}</li>
            {kept.map((line) => (
              <li key={line.what}>{`${line.what}. ${line.why}`}</li>
            ))}
          </ul>

          {notYet.length ? (
            <>
              <h4 className="mt-4 text-sm font-semibold text-ink">Not deleted by this</h4>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                {notYet.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : null}

          <p className="mt-4 text-sm text-ink-soft">
            Links already emailed to them stop working. If you also keep them somewhere else, such as a connected email platform or your own files, delete them there too.
          </p>

          <label htmlFor="erase-confirm" className="field-label mt-4 block">
            Type DELETE to confirm
          </label>
          <input
            id="erase-confirm"
            className="field mt-2 max-w-xs"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={error ? "erase-error" : undefined}
          />
          {error ? (
            <p id="erase-error" className="notice notice-error mt-3" role="alert">
              {error}
            </p>
          ) : null}
          {scheduled ? (
            <p className="notice notice-info mt-3" role="status">
              {scheduled}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="btn btn-danger-solid btn-sm" disabled={busy || typed.trim() !== "DELETE" || Boolean(scheduled)} aria-busy={busy} onClick={() => void erase()}>
              {busy ? "Deleting…" : "Delete this person"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setOpen(false); setTyped(""); setError(""); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
