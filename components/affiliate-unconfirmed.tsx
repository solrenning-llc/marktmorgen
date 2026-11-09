"use client";

/**
 * Second-level commissions waiting as "buyer not confirmed" (lib/affiliates.ts, owner through Claude 1, 9 November
 * 2026, 15h42): the sale's order named no buyer, so nobody can check that the buyer is not the affiliate or the
 * person who invited them. The program keeps looking for a few days; until then the creator may vouch for one line in
 * person. Pressing the button first shows what approving does and asks to confirm (WCAG 3.3.6); nothing is sent before.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { formatMoney } from "@/lib/money";

export type WaitingLine = { ref: string; at: number; title: string; aff: string; base: number; rate: number; commission: number; currency: string };

const money = (cents: number, currency: string) => formatMoney(Math.max(0, cents), currency);
const day = (seconds: number) => {
  const date = new Date(seconds * 1000);
  return seconds > 0 && Number.isFinite(date.getTime()) ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Date unavailable";
};

const PROBLEMS: Record<string, string> = {
  not_waiting: "That line was already decided. Reload the page to see where it stands.",
  gone: "That sale is no longer in your records. Reload the page.",
};

async function confirmLine(ref: string): Promise<string | null> {
  try {
    const response = await fetch("/api/store/affiliates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "tier-confirm", ref }) });
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (data.ok) return null;
    return PROBLEMS[data.error ?? ""] ?? "That could not be saved. Reload the page and try again.";
  } catch {
    return "That could not be saved. Check your connection and try again.";
  }
}

/** The lines waiting, newest first, each with its review before the approval. */
export function AffiliateUnconfirmed({ lines, total, who, days }: { lines: readonly WaitingLine[]; total: number; who: Record<string, string>; days: number }) {
  const router = useRouter();
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ ref: string; text: string } | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  // The confirmation takes the focus when it opens, and gives it back to the button that opened it when it closes.
  useEffect(() => {
    if (asking) confirmButton.current?.focus();
  }, [asking]);

  if (!lines.length) return null;

  async function approve(ref: string) {
    setBusy(ref);
    setProblem(null);
    const failed = await confirmLine(ref);
    setBusy(null);
    if (failed) return setProblem({ ref, text: failed });
    setAsking(null);
    toast("Approved. It is in your next payment batch.");
    router.refresh();
  }

  return (
    <section aria-labelledby="unconfirmed-title" className="card p-6 sm:p-8">
      <h2 id="unconfirmed-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        Commissions waiting for a buyer check
      </h2>
      <p className="mt-2 text-sm text-ink-soft">
        {`These sales did not give us the buyer's email, so we cannot tell whether the buyer is the affiliate who invited the seller. We keep looking for ${days} days and decide on our own if the email turns up. Until then they are not in your payment batch. If you know the buyer is somebody else, you can approve one.`}
      </p>
      <p className="mt-2 text-sm text-ink-soft" role="status">
        {total > lines.length ? `Showing ${lines.length} of ${total} waiting.` : `${total} waiting.`}
      </p>
      <ul className="mt-4 divide-y divide-line">
        {lines.map((line) => {
          const open = asking === line.ref;
          const who2 = who[line.aff] ?? "A removed affiliate";
          return (
            <li key={line.ref} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="min-w-0">
                  <span className="block font-semibold text-ink">{line.title}</span>
                  <span className="block text-xs text-ink-soft [overflow-wrap:anywhere]">{`${day(line.at)} · ${who2} · ${money(line.base, line.currency)} before tax · ${line.rate}% · A sale by somebody they invited`}</span>
                </span>
                <span className="text-right">
                  <span className="block font-semibold tabular-nums text-ink">{money(line.commission, line.currency)}</span>
                  <span className="block text-xs font-semibold text-ink-soft">Buyer not confirmed</span>
                </span>
              </div>
              {!open ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm mt-2 min-h-11"
                  disabled={busy !== null}
                  aria-label={`Review and approve ${money(line.commission, line.currency)} for ${who2}, sale of ${line.title} on ${day(line.at)}`}
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    setProblem(null);
                    setAsking(line.ref);
                  }}
                >
                  Review and approve
                </button>
              ) : (
                <div className="notice notice-warn mt-3 text-sm" role="group" aria-label={`Confirm approving ${money(line.commission, line.currency)} for ${who2}`}>
                  <p className="font-semibold text-ink">{`Approve ${money(line.commission, line.currency)} for ${who2}?`}</p>
                  <p className="mt-1 text-ink-soft">
                    Approve only if you know the buyer is not this affiliate, and not the affiliate who invited them. It goes into your next payment batch and counts as owed. You cannot undo it here. If it was a mistake, record a smaller payout.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button ref={confirmButton} type="button" className="btn btn-primary btn-sm min-h-11" disabled={busy !== null} onClick={() => approve(line.ref)}>
                      Yes, approve it
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm min-h-11"
                      disabled={busy !== null}
                      onClick={() => {
                        setAsking(null);
                        setProblem(null);
                        // Back to the button that opened it, once it is on the page again.
                        const back = opener.current;
                        window.setTimeout(() => back?.focus(), 0);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {problem?.ref === line.ref ? (
                <p className="notice notice-error mt-3 text-sm" role="alert">
                  {problem.text}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
