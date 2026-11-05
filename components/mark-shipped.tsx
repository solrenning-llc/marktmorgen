"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "@/components/toast";
import { NewTab } from "@/components/new-tab";
import { CURRENT_SHIPMENT_MAIL_LIFECYCLE, readShipmentConfirmation, readShippedRecord, readShipmentMailStatus, type ShipmentMailStatus } from "@/lib/shipment-record";

const MESSAGES: Record<string, string> = {
  tracking: "Paste a tracking link that starts with https://, or leave it empty.",
  unknown: "That order could not be found as a shipped one. Reload the page.",
  stripe: "Your Stripe account did not answer just now. Nothing was sent. Try again in a moment.",
  mail_unavailable: "The shipment email could not be safely saved. Reload to check the order before trying again.",
  role: "Your role on this store does not include orders.",
  signed_out: "Your session ended. Log in again.",
};

const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });

/**
 * Where a physical order is going, and the one press that tells its buyer it
 * is on its way (lib/shipments.ts), with a tracking link if there is one.
 */
export function MarkShipped({
  session,
  to,
  shipped,
}: {
  session: string;
  to: { name: string; lines: string[] } | null;
  shipped: { at: number; tracking: string } | null;
}) {
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const inFlight = useRef(false);
  const [done, setDone] = useState(() => readShippedRecord(shipped));
  const [tracking, setTracking] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mail, setMail] = useState<ShipmentMailStatus | null>(null);
  useEffect(() => {
    if (CURRENT_SHIPMENT_MAIL_LIFECYCLE === "never_activated" || !done || mail) return;
    const controller = new AbortController();
    void fetch(`/api/store/shipped?session=${encodeURIComponent(session)}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const raw: unknown = await response.json();
        if (!response.ok || !raw || typeof raw !== "object" || Array.isArray(raw) ||
            !Object.hasOwn(raw, "ok") || (raw as { ok?: unknown }).ok !== true || Object.hasOwn(raw, "error")) return;
        const state = readShipmentMailStatus((raw as { mail?: unknown }).mail);
        if (state) setMail(state);
      }).catch(() => {});
    return () => controller.abort();
  }, [done, mail, session]);
  const id = `ship-${session.slice(-10)}`;
  return (
    <div className="mt-3 rounded-xl bg-white px-4 py-3 text-sm">
      <p className="text-xs font-semibold text-ink-soft">Ship to</p>
      {to && to.lines.length ? (
        <address className="mt-0.5 not-italic font-semibold leading-relaxed text-ink">
          {[to.name, ...to.lines].filter(Boolean).map((line, i) => (
            <span key={i} className="block break-words">{line}</span>
          ))}
        </address>
      ) : (
        <p className="mt-0.5 text-ink-soft">The address is on this payment in your Stripe dashboard.</p>
      )}
      {done ? (
        <p className="mt-2 font-semibold text-ink" role="status">
          {`Marked as shipped on ${day(done.at)}.`}
          {!mail || mail.state === "not_recorded" ? (
            <span className="mt-1 block font-normal">The email&apos;s acceptance was not recorded. No automatic resend is scheduled.</span>
          ) : null}
          {mail && mail.state !== "accepted" && mail.state !== "not_recorded" ? (
            <span className="mt-1 block font-normal">
              {mail.state === "acceptance_unknown" ? "The email's acceptance is unknown. It will not be sent again automatically."
                : mail.state === "refused" ? "The email service refused this message. It has been kept; no new send is confirmed."
                : mail.state === "on_hold" ? "The email is saved. Automatic sending is on hold while its sending budget is checked."
                : "The email is saved and waiting. Sending is not confirmed yet."}
              {mail.delayed ? " It has been waiting for more than 72 hours." : ""}
            </span>
          ) : null}
          {done.tracking ? (
            <>
              {" "}
              <a href={done.tracking} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">Tracking<NewTab /></a>
            </>
          ) : null}
        </p>
      ) : (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          aria-busy={busy}
          onSubmit={async (event) => {
            event.preventDefault();
            if (!ready || inFlight.current) return;
            inFlight.current = true;
            setBusy(true);
            setError(null);
            try {
              const response = await fetch("/api/store/shipped", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ session, tracking }),
              });
              const data: unknown = await response.json().catch(() => null);
              const confirmed = readShipmentConfirmation(data, response.ok);
              if (confirmed) {
                setDone(confirmed.shipped);
                setMail(confirmed.mail ?? { state: "not_recorded", delayed: false });
                toast(confirmed.emailed ? "Marked as shipped. The email was accepted for sending." : confirmed.mail?.state === "queued" ? "Marked as shipped. The email is saved and waiting." : "Marked as shipped. No new email was confirmed.");
                return;
              }
              const reason = data && typeof data === "object" && Object.hasOwn(data, "ok") && (data as { ok?: unknown }).ok === false && Object.hasOwn(data, "error") ? (data as { error?: unknown }).error : null;
              setError(typeof reason === "string" && Object.hasOwn(MESSAGES, reason) ? MESSAGES[reason] : "The shipment was not confirmed. Reload to check its status before trying again.");
            } catch {
              setError("The shipment was not confirmed. Reload to check its status before trying again.");
            } finally {
              inFlight.current = false;
              setBusy(false);
            }
          }}
        >
          <label className="min-w-[12rem] flex-1" htmlFor={id}>
            <span className="text-xs font-semibold text-ink-soft">Tracking link (optional)</span>
            <input id={id} type="url" inputMode="url" className="field mt-1" placeholder="https://" value={tracking} disabled={!ready || busy} onChange={(e) => setTracking(e.target.value)} />
          </label>
          <button type="submit" aria-busy={busy} disabled={!ready || busy} className="btn btn-secondary btn-sm">
            {busy ? "Marking…" : "Mark as shipped"}
          </button>
          {error ? <p className="notice notice-error w-full" role="alert">{error}</p> : null}
        </form>
      )}
    </div>
  );
}
