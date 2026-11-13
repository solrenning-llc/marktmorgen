"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import { formatMoney, parseCurrency, plainAmount, readMoney } from "@/lib/money";
import { GOAL_UNAVAILABLE_LINE, UNKNOWN_SALES_GOAL_CENTS, goalProgress, monthTitle } from "@/lib/sales-goal-rules";

/**
 * The month's goal (lib/sales-goal-rules.ts): how far along it is, what a day
 * has to bring from here, and a box to set or change it.
 */
export function SalesGoalCard({
  goal: given,
  byDay,
  today,
  currency,
}: {
  goal: number;
  /** Complete payments by day, including renewals; null means unavailable. */
  byDay: Record<string, number> | null;
  today: string;
  currency: string;
}) {
  const [goal, setGoal] = useState(given);
  const unavailable = goal === UNKNOWN_SALES_GOAL_CENTS;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(given > 0 ? plainAmount(given, currency) : "");
  const [busy, setBusy] = useState(false);
  const money = (cents: number) => formatMoney(cents, currency);
  const progress = unavailable || byDay === null ? null : goalProgress(goal, byDay, today);
  const month = monthTitle(today.slice(0, 7)).split(" ")[0];

  async function save(cents: number) {
    setBusy(true);
    try {
      const response = await fetch("/api/store/goal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cents }) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; goal?: number };
      if (answer.ok && typeof answer.goal === "number") {
        setGoal(answer.goal);
        setEditing(false);
        toast(answer.goal ? "Goal saved" : "Goal taken away");
      } else {
        toast("That did not save. Type an amount, like 3000, and try again.");
      }
    } catch {
      toast("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-ink">{`${month} goal`}</p>
        {!editing ? (
          <button type="button" className="inline-flex min-h-11 items-center text-sm font-semibold text-violet-deep underline underline-offset-4" onClick={() => setEditing(true)}>
            {goal > 0 ? "Change" : unavailable ? "Set a new goal" : "Set a goal for the month"}
          </button>
        ) : null}
      </div>
      {unavailable && !editing ? <p className="mt-2 text-sm text-ink-soft" role="status">{GOAL_UNAVAILABLE_LINE}</p> : null}
      {!unavailable && byDay === null && !editing ? <>
        {goal > 0 ? <p className="mt-1 text-sm text-ink">Your target: {money(goal)}.</p> : null}
        <p className="mt-2 text-sm text-ink-soft" role="status">Complete payment figures are not available. Goal progress, pace and achievement wait for a complete purchase and renewal reading.</p>
      </> : null}
      {progress && !editing ? (
        <>
          <p className="mt-1 text-sm text-ink">
            <span className="font-semibold tabular-nums">{money(progress.done)}</span>
            {` of ${money(progress.goal)}, ${Math.floor(progress.share * 100)}%`}
          </p>
          <div
            className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white ring-1 ring-line"
            role="progressbar"
            aria-label={`${month} goal`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, Math.floor(progress.share * 100))}
          >
            <div className={`h-full ${progress.reachedOn ? "bg-mint-deep" : "bg-violet-brand"}`} style={{ width: `${Math.min(100, progress.share * 100)}%` }} />
          </div>
          <p className="mt-2 text-xs text-ink-soft">
            {progress.reachedOn
              ? `Reached on ${month} ${Number(progress.reachedOn.slice(8))}.`
              : progress.days > progress.day
                ? `${money(progress.perDay)} a day reaches it in the ${progress.days - progress.day} ${progress.days - progress.day === 1 ? "day" : "days"} left. At the pace so far the month ends at ${money(progress.onPace)}.`
                : "The last day of the month."}{" "}
            Sales and renewals, before Stripe&apos;s fee, days in UTC.
          </p>
        </>
      ) : null}
      {!unavailable && !goal && !editing ? (
        <p className="mt-1 text-xs text-ink-soft">A figure for the month&apos;s money, and how much a day it takes to get there. It is in your Monday email too.</p>
      ) : null}
      {editing ? (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const cents = readMoney(text.replace(/,/g, ""), parseCurrency(currency));
            if (cents === null || cents <= 0) {
              toast("Type an amount, like 3000.");
              return;
            }
            save(cents);
          }}
        >
          <label className="text-sm">
            <span className="field-label">{`Each month, in ${currency.toUpperCase()}`}</span>
            <input className="field mt-1 w-40 py-2" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="3000" required />
          </label>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            Save
          </button>
          {goal ? (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => save(0)}>
              No goal
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : null}
    </div>
  );
}
