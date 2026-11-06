"use client";

import { useEffect, useRef, useState } from "react";
import { useStudioStore } from "@/components/studio-store-pin";
import { formatMoney } from "@/lib/money";

/**
 * The one button of the review screen (app/studio/closing-refunds): gives
 * back every amount listed, from the creator's own Stripe account, and says
 * what happened in a status region that takes the focus. A second press
 * while one runs does nothing; the server makes each refund once whatever
 * is pressed (lib/closing-refunds.ts).
 */
type Result =
  | { kind: "idle" | "sending" }
  | { kind: "done"; lines: string[] }
  | { kind: "error"; message: string };

type Money = { amount: number; cur: string };
const sum = (rows: Money[]) => {
  const by = new Map<string, number>();
  for (const row of rows) by.set(row.cur, (by.get(row.cur) ?? 0) + row.amount);
  return [...by].map(([cur, amount]) => formatMoney(amount, cur)).join(" and ");
};

function refusal(code: unknown): string {
  if (code === "changed") return "Something changed at Stripe since this page was drawn, so nothing was refunded. Reload the page to see the amounts as they are now.";
  if (code === "busy") return "Refunds for this store are already being made. Wait a minute, then reload the page.";
  if (code === "not_closing") return "Your store is no longer closing, so nothing was refunded.";
  if (code === "signed_out") return "Sign in again, then come back to this page. Nothing was refunded.";
  if (code === "forbidden") return "Only the store's owner can give refunds. Nothing was refunded.";
  return "The refunds could not be made just now. Nothing was refunded twice. Reload the page and try again.";
}

export function ClosingRefundsConfirm({ mark, label, back }: { mark: string; label: string; back: string }) {
  const sid = useStudioStore();
  const [state, setState] = useState<Result>({ kind: "idle" });
  const said = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.kind === "done" || state.kind === "error") said.current?.focus();
  }, [state.kind]);

  async function confirm() {
    if (!sid || state.kind === "sending") return;
    setState({ kind: "sending" });
    try {
      const response = await fetch("/api/store/closing-refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-nimbus-store": sid },
        body: JSON.stringify({ mark }),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok || data.ok !== true) {
        setState({ kind: "error", message: refusal(data.error) });
        return;
      }
      const given = Array.isArray(data.given) ? (data.given as Money[]) : [];
      const short = Array.isArray(data.short) ? (data.short as Money[]) : [];
      const lines: string[] = [];
      lines.push(given.length ? `Refunded: ${given.length} ${given.length === 1 ? "member" : "members"}, ${sum(given)} in all.` : "Nothing was refunded.");
      if (short.length) lines.push(`Not refunded yet: ${short.length} (${sum(short)}). Your Stripe balance did not cover them. Add funds in Stripe, then reload this page and press the button again. On the closing day they are tried once more.`);
      if (Number(data.pending) > 0) lines.push(`Waiting at Stripe: ${data.pending}. Stripe sends them as soon as it can.`);
      if (Number(data.disputed) > 0) lines.push(`Not refunded because the payment is disputed: ${data.disputed}.`);
      if (Number(data.over) > 0) lines.push(`Not refunded by us: ${data.over}, past this closing's limit. Refund them from Stripe.`);
      const notYet = Number(data.failed) + Number(data.left);
      if (notYet > 0) lines.push(`Not done yet: ${notYet}. Reload the page and press the button again; nobody is refunded twice.`);
      setState({ kind: "done", lines });
    } catch {
      setState({ kind: "error", message: refusal("") });
    }
  }

  return (
    <div className="mt-6">
      {state.kind === "done" ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={confirm} disabled={state.kind === "sending"} aria-busy={state.kind === "sending"}>
            {state.kind === "sending" ? "Refunding…" : label}
          </button>
          <a href={back} className="btn btn-secondary">
            Go back without refunding
          </a>
        </div>
      )}
      <div ref={said} tabIndex={-1} role="status" aria-live="polite" className="mt-4 outline-none">
        {state.kind === "done" ? (
          <div className="notice">
            {state.lines.map((line) => (
              <p key={line} className="mt-1 text-ink">{line}</p>
            ))}
            <p className="mt-3">
              <a href={back} className="text-ink underline">Back to your studio</a>
            </p>
          </div>
        ) : state.kind === "error" ? (
          <p className="notice notice-warn text-ink">{state.message}</p>
        ) : null}
      </div>
    </div>
  );
}
