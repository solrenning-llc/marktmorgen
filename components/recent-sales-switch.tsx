"use client";

import { useState } from "react";
import { toast, toastProblem } from "@/components/toast";
import { RECENT_DAYS, SHOWN } from "@/lib/recent-sales-rules";

/**
 * The creator's switch for showing their latest real purchases on their store
 * (lib/recent-sales.ts), with what it shows and what it never does.
 */
export function RecentSalesSwitch({ on: initial, live }: { on: boolean; live: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      const response = await fetch("/api/store/recent-sales", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: !on }) });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; on?: boolean };
      if (body.ok && typeof body.on === "boolean") {
        setOn(body.on);
        toast(body.on ? "Your store shows its latest purchases from the next one." : "Your store no longer shows its latest purchases.");
      } else toastProblem("That did not save. Try again.");
    } catch {
      toastProblem("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="recent-title" className="card p-6 sm:p-8">
      <h2 id="recent-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        Latest purchases on your store
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-soft">
        {`A small card at the bottom of your front page and product pages: what was bought, how long ago, and the country the card was billed in. Never who. Only purchases paid on your Stripe account in the last ${RECENT_DAYS} days, up to ${SHOWN} a visit, each once; a refunded one is left out, and nothing is shown when there is none. Nothing can be typed in.`}
      </p>
      {!live ? <p className="mt-2 text-sm text-ink-soft">It starts with the first purchase after you connect Stripe and switch it on.</p> : null}
      <button type="button" className={`btn ${on ? "btn-secondary" : "btn-primary"} mt-4`} disabled={busy} onClick={() => void toggle()} aria-pressed={on}>
        {on ? "Stop showing them" : "Show my latest purchases"}
      </button>
    </section>
  );
}
