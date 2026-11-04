"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useHydrated } from "@/components/use-hydrated";
import { toast } from "@/components/toast";
import { MAX_PLACE_LINE, MAX_PLACE_LINES } from "@/lib/call-place";
import { MAX_HOURS_LINE, MAX_HOURS_LINES, type VisitUs, type VisitUsProblem, readVisitUs } from "@/lib/visit-us";

const PROBLEMS: Record<VisitUsProblem, string> = {
  place: `Write your address on up to ${MAX_PLACE_LINES} lines of ${MAX_PLACE_LINE} characters or fewer, as a visitor reads it, with no web link.`,
  hours: `Write your opening hours on up to ${MAX_HOURS_LINES} lines of ${MAX_HOURS_LINE} characters or fewer, with no web link or email address.`,
  phone: "Write a phone number with 6 to 15 digits. Spaces, dashes, dots, parentheses and a + at the start are fine.",
};
const FAILED = "We could not confirm this was saved. Reload this page to check before trying again.";

/**
 * "Visit us" on the store page (lib/visit-us.ts, 521 [LB2]): the address,
 * opening hours and phone of a business with a place, such as a salon, in the
 * creator's own words. Checked here with the same rules the server keeps, and
 * saved on its own; all three empty takes the block away.
 */
export function VisitUsEditor({ visitUs }: { visitUs: VisitUs | null }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const id = useId();
  const [place, setPlace] = useState(visitUs?.place?.lines.join("\n") ?? "");
  const [hours, setHours] = useState(visitUs?.hours.join("\n") ?? "");
  const [phone, setPhone] = useState(visitUs?.phone ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!hydrated || busy) return;
    const body = { place, hours, phone };
    // The same answer the server gives, before anything is sent.
    const read = readVisitUs(body);
    if (typeof read === "string") {
      setError(PROBLEMS[read]);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // What was read is what is sent: tidied, without empty rows, so it stays within the route's size.
      const tidy = { place: read?.place?.lines ?? null, hours: read?.hours ?? [], phone: read?.phone ?? null };
      const response = await fetch("/api/store/visit-us", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tidy) });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; visitUs?: unknown } | null;
      if (!response.ok || data?.ok !== true || JSON.stringify(data.visitUs ?? null) !== JSON.stringify(read)) {
        setError(data?.error && data.error in PROBLEMS ? PROBLEMS[data.error as VisitUsProblem] : FAILED);
        return;
      }
      toast(read ? "Visit us saved." : "Visit us taken off your store.");
      router.refresh();
    } catch {
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="card p-6 sm:p-8"
      data-visit-us-editor=""
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">Visit us</h2>
      <p className="mt-1 text-sm text-ink-soft">
        For a business people come to, such as a salon: your address, opening hours and phone, shown under your products. Leave all three empty to show nothing.
      </p>
      <div className="mt-4 grid gap-4">
        <div>
          <label htmlFor={`${id}-place`} className="field-label">Your place&apos;s address</label>
          <textarea id={`${id}-place`} className="field mt-2" rows={MAX_PLACE_LINES} value={place} onChange={(e) => setPlace(e.target.value)} aria-describedby={`${id}-place-help`} autoComplete="street-address" />
          <p id={`${id}-place-help`} className="mt-1 text-sm text-ink-soft">{`Up to ${MAX_PLACE_LINES} lines, as a visitor reads it. For example: Bela Studio, 12 Harbor Street, Portland, ME 04101.`}</p>
        </div>
        <div>
          <label htmlFor={`${id}-hours`} className="field-label">Opening hours</label>
          <textarea id={`${id}-hours`} className="field mt-2" rows={4} value={hours} onChange={(e) => setHours(e.target.value)} aria-describedby={`${id}-hours-help`} />
          <p id={`${id}-hours-help`} className="mt-1 text-sm text-ink-soft">{`Up to ${MAX_HOURS_LINES} lines, in your own words. For example: Tuesday to Saturday, 9am to 7pm.`}</p>
        </div>
        <div>
          <label htmlFor={`${id}-phone`} className="field-label">Phone</label>
          <input id={`${id}-phone`} type="tel" className="field mt-2" value={phone} onChange={(e) => setPhone(e.target.value)} aria-describedby={`${id}-phone-help`} autoComplete="tel" />
          <p id={`${id}-phone-help`} className="mt-1 text-sm text-ink-soft">Visitors can tap it to call you. For example: (207) 555-0142. Start with + and your country code if visitors may call from another country.</p>
        </div>
      </div>
      {error ? <p className="notice notice-error mt-4" role="alert">{error}</p> : null}
      <div className="mt-4">
        <button type="submit" className="btn btn-primary" disabled={!hydrated || busy}>
          {busy ? "Saving…" : "Save Visit us"}
        </button>
      </div>
    </form>
  );
}
