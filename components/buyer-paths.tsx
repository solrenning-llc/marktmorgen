"use client";

import Link from "next/link";
import { useState } from "react";
import { toast, toastProblem } from "@/components/toast";
import { useStudioHref } from "@/components/studio-store-pin";

export type PathRow = {
  from: { id: string; title: string };
  to: { id: string; title: string; price: string };
  buyers: number;
  /** "12 days later", "the same day". */
  when: string;
  /** "offer": nothing is offered after `from` yet, and `to` can be; "change": offers exist, change them; null: it cannot be offered. */
  offer: "offer" | "change" | null;
  bundle: boolean;
};

/**
 * What buyers get next (lib/next-bought.ts), in the studio's numbers: each
 * product beside the one its buyers most often bought later, how many of them
 * and how long after, with the step that sells it sooner — one click after
 * paying, or both in one bundle.
 */
export function BuyerPaths({ rows, starts, canEdit }: { rows: PathRow[]; starts: { title: string; buyers: number }[]; canEdit: boolean }) {
  const href = useStudioHref();
  const [busy, setBusy] = useState<string | null>(null);
  const [made, setMade] = useState<Set<string>>(new Set());

  async function offer(row: PathRow) {
    const key = `${row.from.id}>${row.to.id}`;
    setBusy(key);
    try {
      const response = await fetch("/api/store/next-offer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: row.from.id, to: row.to.id }) });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (body.ok) {
        setMade((all) => new Set(all).add(key));
        toast(`${row.to.title} is now offered in one click after paying for ${row.from.title}.`);
      } else {
        toastProblem(
          body.error === "has_funnel"
            ? `${row.from.title} already has offers after paying. Add this one there.`
            : body.error === "target" || body.error === "kind"
              ? `${row.to.title} cannot be offered after paying for ${row.from.title} as they are now.`
              : "That did not save. Try again.",
        );
      }
    } catch {
      toastProblem("That did not save. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="buyer-paths-title" className="card mt-8 p-6 sm:p-8" id="buyer-paths">
      <h2 id="buyer-paths-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        What buyers get next
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-soft">
        For each product, what the same buyers went on to buy afterward, on a later visit, and how long after: counted from
        every sale on your Stripe account, from three buyers up. Offer that product right after paying, or put both in one
        bundle, and they get it without waiting.
      </p>
      {starts.length ? (
        <p className="mt-3 text-sm text-ink">
          <span className="font-semibold">Most often bought first: </span>
          {starts.map((s) => `${s.title} (${s.buyers.toLocaleString("en-US")} ${s.buyers === 1 ? "buyer" : "buyers"})`).join(", ")}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-ink-soft">
          Nothing to show yet: once three buyers of one product come back and buy another, it shows here.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {rows.map((row) => {
            const key = `${row.from.id}>${row.to.id}`;
            return (
              <li key={key} className="py-3" data-path="">
                <p className="text-sm text-ink">
                  <span className="font-semibold">{row.from.title}</span>
                  <span className="text-ink-soft" aria-hidden="true">{" → "}</span>
                  <span className="sr-only"> then </span>
                  <span className="font-semibold">{row.to.title}</span>
                </p>
                <p className="mt-0.5 text-xs text-ink-soft">{`${row.buyers.toLocaleString("en-US")} buyers, usually ${row.when}`}</p>
                {canEdit ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {made.has(key) ? (
                      <Link href={href(`/studio/funnels?product=${row.from.id}`)} className="btn btn-ghost btn-sm">
                        Offered after paying · change it
                      </Link>
                    ) : row.offer === "offer" ? (
                      <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void offer(row)}>
                        {`Offer it after paying, for ${row.to.price}`}
                      </button>
                    ) : row.offer === "change" ? (
                      <Link href={href(`/studio/funnels?product=${row.from.id}`)} className="btn btn-secondary btn-sm">
                        Add it to the offers after paying
                      </Link>
                    ) : null}
                    {row.bundle ? (
                      <Link href={href(`/studio/bundles?new=1&items=${row.from.id},${row.to.id}`)} className="btn btn-ghost btn-sm">
                        Bundle them
                      </Link>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
