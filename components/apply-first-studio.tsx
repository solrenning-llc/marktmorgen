"use client";

import { useState } from "react";
import type { ApplicationState } from "@/lib/apply-first-rules";
import { APPLY_LINK_DAYS_DEFAULT, APPLY_LINK_DAYS_MAX, APPLY_LINK_DAYS_MIN } from "@/lib/apply-first-days";
import { DECIDE_WORDS, DECLINED_WORDS, approvedWords, dayWords, stateWords } from "@/lib/apply-first-words";

export type ApplicationRow = {
  id: string;
  email: string;
  /** The product's name, or a sentence saying it could not be read. */
  product: string;
  state: ApplicationState;
  at: number;
  expiresAt: number;
};

type Said = { text: string; ok: boolean };

const DAY_CHOICES = Array.from({ length: APPLY_LINK_DAYS_MAX - APPLY_LINK_DAYS_MIN + 1 }, (_, i) => APPLY_LINK_DAYS_MIN + i);

/**
 * A store's applications to buy (604 [WP3]), each with the creator's answer:
 * approve, with how long its buy link works, or decline after a second press
 * that says it can't be undone. Each answer is said beside its application,
 * in a polite live region, and stays until the next one: nothing here runs
 * out. "Changed" and "could not confirm" are said as such, never as done.
 */
export function ApplyFirstStudio({ rows, now, canDecide }: { rows: ApplicationRow[]; now: number; canDecide: boolean }) {
  const [list, setList] = useState(rows);
  const [days, setDays] = useState<Record<string, number>>({});
  const [asking, setAsking] = useState("");
  const [busy, setBusy] = useState("");
  const [said, setSaid] = useState<Record<string, Said>>({});

  const tell = (id: string, text: string, ok: boolean) => {
    setSaid((all) => ({ ...all, [id]: { text, ok } }));
    requestAnimationFrame(() => document.getElementById(`apply-said-${id}`)?.focus());
  };

  async function decide(row: ApplicationRow, action: "approve" | "decline") {
    if (busy) return;
    setBusy(row.id);
    const chosen = days[row.id] ?? APPLY_LINK_DAYS_DEFAULT;
    try {
      const response = await fetch("/api/store/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "approve" ? { action, id: row.id, days: chosen } : { action, id: row.id }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: unknown; application?: { state?: unknown; expiresAt?: unknown }; message?: unknown } | null;
      const state = data?.application?.state;
      const expiresAt = data?.application?.expiresAt;
      if (response.ok && data?.ok === true && (state === "approved" || state === "declined") && typeof expiresAt === "number") {
        setList((all) => all.map((r) => (r.id === row.id ? { ...r, state, expiresAt } : r)));
        setAsking("");
        tell(row.id, state === "approved" ? approvedWords(chosen, expiresAt) : DECLINED_WORDS, true);
      } else {
        // A sentence from the server is shown as it is; anything else is not known to be saved.
        tell(row.id, typeof data?.message === "string" && data.message ? data.message : DECIDE_WORDS.unknown, false);
      }
    } catch {
      tell(row.id, DECIDE_WORDS.unknown, false);
    } finally {
      setBusy("");
    }
  }

  if (!list.length) {
    return <p className="mt-8 text-ink-soft">No applications yet.</p>;
  }

  return (
    <ul className="mt-8 grid gap-4" aria-label="Applications, oldest first">
      {list.map((row) => {
        const open = row.state === "approved" && now < row.expiresAt;
        const mayApprove = row.state === "submitted" || (row.state === "approved" && !open);
        const mayDecline = row.state === "submitted" || row.state === "approved";
        const message = said[row.id];
        return (
          <li key={row.id} className="card p-5">
            <h2 className="t-h4 break-words">{row.email}</h2>
            <dl className="mt-2 grid gap-1 text-ink-soft sm:grid-cols-[auto_1fr] sm:gap-x-4">
              <dt>Product</dt>
              <dd className="text-ink">{row.product}</dd>
              <dt>Applied</dt>
              <dd className="text-ink">{dayWords(row.at)}</dd>
              <dt>Status</dt>
              <dd className="text-ink">
                {stateWords(row.state, row.expiresAt, now)}
                {row.state === "approved" ? ` (buy link ${open ? "works until" : "ended on"} ${dayWords(row.expiresAt)}, UTC)` : ""}
              </dd>
            </dl>
            {canDecide && (mayApprove || mayDecline) ? (
              <div className="mt-4 flex flex-wrap items-end gap-3">
                {mayApprove ? (
                  <>
                    <label className="grid gap-1" htmlFor={`apply-days-${row.id}`}>
                      <span>Buy link works for</span>
                      <select
                        id={`apply-days-${row.id}`}
                        className="field"
                        value={days[row.id] ?? APPLY_LINK_DAYS_DEFAULT}
                        onChange={(event) => setDays((all) => ({ ...all, [row.id]: Number(event.target.value) }))}
                      >
                        {DAY_CHOICES.map((n) => (
                          <option key={n} value={n}>{n === 1 ? "1 day" : `${n} days`}</option>
                        ))}
                      </select>
                    </label>
                    <button type="button" className="btn btn-primary" disabled={busy !== ""} aria-busy={busy === row.id} aria-label={`Approve ${row.email}`} onClick={() => void decide(row, "approve")}>
                      Approve
                    </button>
                  </>
                ) : null}
                {mayDecline && asking !== row.id ? (
                  <button id={`apply-decline-${row.id}`} type="button" className="btn btn-secondary" disabled={busy !== ""} aria-label={`Decline ${row.email}`} onClick={() => {
                    setAsking(row.id);
                    requestAnimationFrame(() => document.getElementById(`apply-confirm-${row.id}`)?.focus());
                  }}>
                    Decline
                  </button>
                ) : null}
              </div>
            ) : null}
            {canDecide && mayDecline && asking === row.id ? (
              <div id={`apply-confirm-${row.id}`} tabIndex={-1} role="group" aria-labelledby={`apply-confirm-title-${row.id}`} className="notice mt-4">
                <p id={`apply-confirm-title-${row.id}`}>Decline the application from {row.email}? This can&apos;t be undone{row.state === "approved" ? ", and its buy link stops working" : ""}.</p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <button type="button" className="btn btn-primary" disabled={busy !== ""} aria-busy={busy === row.id} onClick={() => void decide(row, "decline")}>
                    Yes, decline
                  </button>
                  <button type="button" className="btn btn-secondary" disabled={busy !== ""} onClick={() => {
                    setAsking("");
                    requestAnimationFrame(() => document.getElementById(`apply-decline-${row.id}`)?.focus());
                  }}>
                    Keep it
                  </button>
                </div>
              </div>
            ) : null}
            <p id={`apply-said-${row.id}`} tabIndex={-1} role="status" aria-live="polite" className={message ? (message.ok ? "mt-4" : "notice mt-4") : "sr-only"}>
              {message?.text ?? ""}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
