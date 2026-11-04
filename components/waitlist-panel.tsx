"use client";

import { useState } from "react";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { MAX_LAUNCH_ADDRESS, MAX_LAUNCH_NOTE } from "@/lib/waitlist-rules";
import type { WaitlistView } from "@/lib/waitlist";
import type { PreorderView } from "@/lib/preorders";
import { MAX_PREORDER_DAYS, PREORDER_PROBLEMS, type PreorderProblem, addDays, todayOf } from "@/lib/preorder-rules";

const MESSAGES: Record<string, string> = {
  ...PREORDER_PROBLEMS,
  ...STUDIO_MESSAGES,
  free: "A free product already takes addresses. A waitlist is for something paid.",
  address: "Add a postal address for the bottom of the email: US law asks for one in any email about something for sale.",
  busy: "The launch email is still going out. Wait for it to finish.",
  unknown: "That product is no longer in your store. Reload the page.",
  empty: "Buyers have pre-ordered it, and they get it the moment it goes on sale. Add its file, its link or a lesson first.",
  soon: "Mark it coming soon first: pre-orders are taken instead of a buy button.",
  day: `Choose a day from tomorrow to ${MAX_PREORDER_DAYS} days ahead.`,
  agree: "Check the box that says you refund every pre-order in full if it does not come out: buyers are told so.",
};

async function postPreorder(payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string; view?: PreorderView }> {
  try {
    const response = await fetch("/api/store/preorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as { ok: boolean; error?: string; view?: PreorderView };
  } catch {
    return { ok: false, error: "server_error" };
  }
}

/** A day as the studio says it: "November 20, 2026". */
function dayWords(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

async function post(payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string; view?: WaitlistView }> {
  try {
    const response = await fetch("/api/store/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as { ok: boolean; error?: string; view?: WaitlistView };
  } catch {
    return { ok: false, error: "server_error" };
  }
}

/**
 * "Coming soon" for one paid product: the switch, how many are waiting, and
 * the button that puts it on sale and tells them.
 */
export function WaitlistPanel({
  productId,
  initial,
  suggestedAddress,
  preorders = null,
  preorderBlocked = null,
  hasContent = true,
  price,
}: {
  productId: string;
  initial: WaitlistView | null;
  suggestedAddress: string;
  /** Its pre-orders, when it takes or took any (lib/preorders.ts). */
  preorders?: PreorderView | null;
  /** Why it cannot take pre-orders, when it cannot (lib/preorder-rules.ts). */
  preorderBlocked?: PreorderProblem | null;
  /** Whether it has its file, its link or a lesson: what pre-orders get when it goes on sale. */
  hasContent?: boolean;
  /** Its price, in the store's currency, as the waitlist's email carries it. */
  price: string;
}) {
  const [view, setView] = useState<WaitlistView>(initial ?? { soon: false, confirmed: 0, waiting: 0, launch: null });
  const [pre, setPre] = useState<PreorderView>(preorders ?? { day: null, waiting: 0, given: 0, refunded: 0 });
  const [day, setDay] = useState(preorders?.day ?? "");
  const [agree, setAgree] = useState(false);
  const [editingDay, setEditingDay] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  // "Change" on a row of the review before the sale: back to that field, the review closed (487 [IT4], pattern 8).
  function changeAnswer(id: string) {
    setConfirming(false);
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  }
  const [address, setAddress] = useState(suggestedAddress);
  const [confirming, setConfirming] = useState(false);

  async function act(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const answer = await post({ id: productId, ...payload });
    setBusy(false);
    if (answer.ok && answer.view) setView(answer.view);
    else setError(MESSAGES[answer.error ?? ""] ?? MESSAGES.server_error ?? "Something went wrong. Try again.");
    return answer.ok;
  }

  async function actPreorder(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const answer = await postPreorder({ id: productId, ...payload });
    setBusy(false);
    if (answer.ok && answer.view) {
      setPre(answer.view);
      setEditingDay(false);
      setAgree(false);
    } else setError(MESSAGES[answer.error ?? ""] ?? MESSAGES.server_error ?? "Something went wrong. Try again.");
  }

  const launch = view.launch;
  const sending = launch !== null && !launch.finished;
  const today = todayOf();
  const taking = pre.day !== null && today <= pre.day;
  const late = pre.day !== null && today > pre.day;
  const dayForm = (
    <div className="space-y-3">
      <label className="block">
        <span className="field-label">The day it is expected</span>
        <input
          type="date"
          className="field mt-1 max-w-xs"
          min={addDays(today, 1)}
          max={addDays(today, MAX_PREORDER_DAYS)}
          value={day}
          onChange={(e) => setDay(e.target.value)}
        />
        <span className="mt-1 block text-xs text-ink-soft">Shown to buyers as expected, not promised. Pre-orders stop by themselves after it.</span>
      </label>
      <label className="flex min-h-11 items-start gap-3 text-sm text-ink">
        <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>I refund every pre-order in full if it does not come out. Buyers are told so on its page and in their receipt.</span>
      </label>
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !day || !agree} onClick={() => void actPreorder({ day, agree })}>
        {taking || late ? "Save the new day" : "Take pre-orders"}
      </button>
    </div>
  );

  return (
    <div className="mt-3 rounded-[var(--r-sm)] border border-line bg-white p-4">
      <label className="flex min-h-11 items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0"
          checked={view.soon}
          disabled={busy || sending}
          onChange={(e) => void act({ action: "soon", on: e.target.checked })}
        />
        <span>
          <span className="block font-semibold text-ink">Coming soon, with a waitlist</span>
          <span className="block text-sm text-ink-soft">
            Instead of a buy button, visitors leave their email and confirm it from their inbox. No checkout opens until you put
            it on sale.
          </span>
        </span>
      </label>

      {view.soon || view.confirmed || view.waiting ? (
        <p className="mt-2 text-sm text-ink">
          <strong>{view.confirmed.toLocaleString("en-US")}</strong>
          {` confirmed ${view.confirmed === 1 ? "address" : "addresses"}`}
          {view.waiting ? <span className="text-ink-soft">{` · ${view.waiting.toLocaleString("en-US")} not confirmed yet, and not emailed`}</span> : null}
        </p>
      ) : null}

      {view.soon ? (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <p className="text-sm font-semibold text-ink">Pre-orders</p>
          {preorderBlocked ? (
            <p className="text-sm text-ink-soft">{PREORDER_PROBLEMS[preorderBlocked]}</p>
          ) : taking && !editingDay ? (
            <>
              <p className="text-sm text-ink">
                {`Taking pre-orders: paid today, expected on ${dayWords(pre.day as string)}. The waitlist is still there for whoever would rather wait.`}
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setDay(pre.day ?? ""); setEditingDay(true); }}>
                  Change the day
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void actPreorder({ day: null })}>
                  Stop taking pre-orders
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-ink-soft">
                {late
                  ? `It was expected on ${dayWords(pre.day as string)}, so pre-orders stopped by themselves. Set a new day to take more, or put it on sale.`
                  : "Sell it before it is ready: buyers pay today, see the day it is expected, and get it by email the moment you put it on sale. Nothing is added at checkout and no offer follows."}
              </p>
              {dayForm}
            </>
          )}
          {pre.waiting || pre.given || pre.refunded ? (
            <p className="text-sm text-ink">
              <strong>{pre.waiting.toLocaleString("en-US")}</strong>
              {` pre-ordered and waiting`}
              <span className="text-ink-soft">{` · ${pre.given.toLocaleString("en-US")} handed over · ${pre.refunded.toLocaleString("en-US")} refunded`}</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {view.soon ? (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <p className="text-sm font-semibold text-ink">Put it on sale and tell the waitlist</p>
          {pre.waiting ? (
            <p className="text-sm text-ink">
              {hasContent
                ? `Each of the ${pre.waiting.toLocaleString("en-US")} pre-orders is handed over at the same moment, and its buyer is emailed the way to open it.`
                : `${pre.waiting.toLocaleString("en-US")} buyers have pre-ordered it and get it the moment it goes on sale: add its file, its link or a lesson first.`}
            </p>
          ) : null}
          <p className="text-sm text-ink-soft">
            {view.confirmed
              ? `It goes on sale at once, and ${view.confirmed === 1 ? "the confirmed address gets" : `each of the ${view.confirmed.toLocaleString("en-US")} confirmed addresses gets`} one email with its link and price. Then the waitlist's addresses are deleted; whoever also asked to hear from you is on your list already.`
              : "Nobody has confirmed yet, so no email goes out: it just goes on sale."}
          </p>
          {view.confirmed ? (
            <>
              <label className="block">
                <span className="field-label">A note in the email (optional)</span>
                <textarea
                  id={`waitlist-${productId}-note`}
                  className="field mt-1"
                  rows={3}
                  maxLength={MAX_LAUNCH_NOTE}
                  value={note}
                  onChange={(e) => { setNote(e.target.value); setConfirming(false); }}
                  placeholder="Thank you for waiting. Reply to this email if you have any questions."
                />
              </label>
              <label className="block">
                <span className="field-label">Postal address at the bottom of the email</span>
                <input
                  id={`waitlist-${productId}-address`}
                  className="field mt-1"
                  maxLength={MAX_LAUNCH_ADDRESS}
                  value={address}
                  onChange={(e) => { setAddress(e.target.value); setConfirming(false); }}
                  placeholder="123 Main St, Austin, TX 78701"
                  autoComplete="street-address"
                />
                <span className="mt-1 block text-xs text-ink-soft">US law (CAN-SPAM) asks for one in any email about something for sale. A PO box counts.</span>
              </label>
            </>
          ) : null}
          {confirming && view.confirmed ? (
            <div id={`waitlist-${productId}-review`} className="rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink">
              <h3 id={`waitlist-${productId}-review-title`} tabIndex={-1} className="font-semibold">Check before it goes out</h3>
              {/* A summary list, one answer a row (GOV.UK "Check answers"). */}
              <dl className="mt-2 divide-y divide-line">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                  <dt className="basis-full font-semibold sm:basis-28 sm:shrink-0">Goes on sale</dt>
                  <dd className="min-w-0 basis-full break-words sm:basis-0 sm:flex-1">Now, as soon as you press again.</dd>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                  <dt className="basis-full font-semibold sm:basis-28 sm:shrink-0">Price</dt>
                  <dd className="min-w-0 basis-full break-words sm:basis-0 sm:flex-1">{`${price}. Change it in the product's details above.`}</dd>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                  <dt className="basis-full font-semibold sm:basis-28 sm:shrink-0">Emails</dt>
                  <dd className="min-w-0 basis-full break-words sm:basis-0 sm:flex-1">{view.confirmed === 1 ? "One to the confirmed address, with its link and price." : `One to each of the ${view.confirmed.toLocaleString("en-US")} confirmed addresses, with its link and price.`}</dd>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                  <dt className="basis-full font-semibold sm:basis-28 sm:shrink-0">Note</dt>
                  <dd className="min-w-0 basis-full whitespace-pre-line break-words sm:basis-0 sm:flex-1">{note.trim() || "No note"}</dd>
                  <dd><button type="button" className="inline-flex min-h-11 items-center font-bold underline underline-offset-4" onClick={() => changeAnswer(`waitlist-${productId}-note`)}>Change<span className="sr-only"> note</span></button></dd>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                  <dt className="basis-full font-semibold sm:basis-28 sm:shrink-0">Postal address</dt>
                  <dd className="min-w-0 basis-full break-words sm:basis-0 sm:flex-1">{address.trim() || "None yet. Add one before it can go out."}</dd>
                  <dd><button type="button" className="inline-flex min-h-11 items-center font-bold underline underline-offset-4" onClick={() => changeAnswer(`waitlist-${productId}-address`)}>Change<span className="sr-only"> postal address</span></button></dd>
                </div>
              </dl>
            </div>
          ) : null}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            // An email about something for sale needs the postal address: without one, the second press is not offered.
            disabled={busy || (pre.waiting > 0 && !hasContent) || (confirming && view.confirmed > 0 && !address.trim())}
            onClick={async () => {
              if (!confirming) {
                setConfirming(true);
                // The review opens with the focus on its heading, so it is read once, in order.
                requestAnimationFrame(() => document.getElementById(`waitlist-${productId}-review-title`)?.focus());
                return;
              }
              setConfirming(false);
              await act({ action: "launch", note, address });
            }}
          >
            {confirming
              ? view.confirmed
                ? `Press again: on sale now, ${view.confirmed.toLocaleString("en-US")} ${view.confirmed === 1 ? "email" : "emails"}`
                : "Press again to put it on sale"
              : view.confirmed
                ? "Put it on sale and tell the waitlist"
                : "Put it on sale"}
          </button>
        </div>
      ) : null}

      {launch ? (
        <p className="mt-3 text-sm text-ink-soft" role="status">
          {launch.finished
            ? `Launched. ${launch.sent.toLocaleString("en-US")} of ${launch.total.toLocaleString("en-US")} waitlist emails went out.`
            : `On sale. The waitlist email is going out: ${launch.sent.toLocaleString("en-US")} of ${launch.total.toLocaleString("en-US")} so far, sent in batches every five minutes.`}
        </p>
      ) : null}

      {error ? <p className="notice notice-error mt-3 text-sm" role="alert">{error}</p> : null}
    </div>
  );
}
