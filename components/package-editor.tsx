"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { type Currency, fieldPrefix, formatMoney, plainAmount, readMoney } from "@/lib/money";
import { type CallPackage, MAX_PACKAGE_SESSIONS, MIN_PACKAGE_SESSIONS, PACKAGE_DAYS, packageSaving } from "@/lib/call-package-rules";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  server_error: "We could not confirm these package settings. Reload this page to check before trying again.",
  sessions: `A package holds ${MIN_PACKAGE_SESSIONS} to ${MAX_PACKAGE_SESSIONS} sessions.`,
  price: "Type the price of the whole package.",
  days: "Pick how long buyers have to use it.",
  call: "Packages are for calls booked in weekly hours.",
  lengths: "A call that offers several lengths has no package, because a package's sessions are free once bought. Remove the other lengths in the call's hours first.",
};

/** A weekly call's package: how many sessions, their price together, and how long to use them. */
export function PackageEditor({ productId, singleCents, currency, initial }: { productId: string; singleCents: number; currency: Currency; initial: CallPackage | null }) {
  const [saved, setSaved] = useState(initial);
  const [sessions, setSessions] = useState(initial?.sessions ?? 5);
  const [price, setPrice] = useState(initial ? plainAmount(initial.priceCents, currency) : "");
  const [days, setDays] = useState<number>(initial?.days ?? 90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(payload: Record<string, unknown>, done: string) {
    if (busy) return;
    const expected = payload.sessions === 0 ? null : { sessions, priceCents: readMoney(price.slice(0, 20), currency), days };
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/call-package", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: productId, ...payload }) });
      const raw: unknown = await response.json().catch(() => null);
      const reply = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      const pkg = reply?.package && typeof reply.package === "object" && !Array.isArray(reply.package) ? reply.package as Record<string, unknown> : null;
      const matches = expected === null ? reply?.package === null :
        expected.priceCents !== null && pkg?.sessions === expected.sessions && pkg.priceCents === expected.priceCents && pkg.days === expected.days;
      if (response.ok && reply?.ok === true && !("error" in reply) && matches) {
        setSaved(expected as CallPackage | null);
        toast(done);
      } else {
        const problem = reply?.ok !== true && typeof reply?.error === "string" && Object.hasOwn(MESSAGES, reply.error) ? MESSAGES[reply.error] : null;
        setError(problem ?? MESSAGES.server_error);
      }
    } catch {
      setError(MESSAGES.server_error ?? "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details data-package-editor={productId} aria-busy={busy} className="mt-3 rounded-[var(--r-sm)] border border-line bg-white p-4" open={Boolean(saved)}>
      <summary className="cursor-pointer text-sm font-semibold text-ink">
        {saved ? `Package: ${saved.sessions} sessions for ${formatMoney(saved.priceCents, currency)}` : "Also sell a package of sessions"}
      </summary>
      <p className="mt-2 text-sm text-ink-soft">
        Buyers pay once for several sessions and book each one here, from your open times, whenever they like. Every session gets
        the same confirmation, reminders, meeting link and move as a single booking.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="field-label">Sessions</span>
          <select disabled={busy} className="field mt-1" value={sessions} onChange={(e) => setSessions(Number(e.target.value))}>
            {Array.from({ length: MAX_PACKAGE_SESSIONS - MIN_PACKAGE_SESSIONS + 1 }, (_, i) => i + MIN_PACKAGE_SESSIONS).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">Price for all of them</span>
          <span className="mt-1 flex items-center gap-2">
            <span className="shrink-0 whitespace-nowrap text-sm text-ink-soft">{fieldPrefix(currency)}</span>
            <input disabled={busy} className="field" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={plainAmount(Math.round(singleCents * sessions * 0.85), currency)} />
          </span>
        </label>
        <label className="block">
          <span className="field-label">To use within</span>
          <select disabled={busy} className="field mt-1" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {PACKAGE_DAYS.map((d) => (
              <option key={d} value={d}>{d ? `${d} days` : "No limit"}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-2 text-xs text-ink-soft">
        {`One by one, ${sessions} sessions cost ${formatMoney(singleCents * sessions, currency)}.`}
        {saved && packageSaving(saved, singleCents) > 0 ? ` Your package saves buyers ${formatMoney(packageSaving(saved, singleCents), currency)}.` : ""}
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save({ sessions, price, days }, "Package settings saved.")}>
          {saved ? "Save the package" : "Offer the package"}
        </button>
        {saved ? (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void save({ sessions: 0 }, "Package taken off. Packages already bought keep their sessions.")}>
            Stop offering it
          </button>
        ) : null}
      </div>
      {error ? <p className="notice notice-error mt-3 text-sm" role="alert">{error}</p> : null}
    </details>
  );
}
