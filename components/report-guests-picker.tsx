"use client";

import { useId, useState } from "react";
import {
  FIGURES_OFFERED,
  FIGURE_WORDS,
  INVITE_DAYS,
  MAX_REPORT_GUESTS,
  REPORT_FIGURES,
  STATUS_WORDS,
  type GuestStatus,
  type ReportEvery,
  type ReportFigure,
  type ShareView,
} from "@/lib/report-guests-rules";

/**
 * Your numbers by email to people outside your team (405 [HX1]): a partner,
 * an investor, whoever keeps your books. Pick the figures (none is picked
 * until you pick it), every week or every month, and up to three addresses.
 * Each new address is emailed an invitation and gets nothing until it says
 * yes; each email after has a link to stop it. Nothing saves until "Save";
 * the result is said in a live region. For whoever runs the team.
 */

const REFUSALS: Record<string, string> = {
  too_many: `You can add at most ${MAX_REPORT_GUESTS} addresses.`,
  not_an_address: "One of the addresses is not an email address. Check it, then save again.",
  on_the_team: "is on your team. Your team gets its own copy of the weekly email instead.",
  own_address: "is your own address. You get the weekly email already.",
  twice: "is in the list twice.",
  no_key: "Invitations cannot be sent right now, so nothing was saved. Try again later.",
  signed_out: "You are signed out. Sign in again, then save.",
  forbidden: "Only the owner and people who run the team can change this.",
};

const EVERY_LABELS: Record<ReportEvery, string> = { week: "Every week", month: "Every month" };

type Saved = { ok?: boolean; error?: string; address?: string; notSent?: string[] } & Partial<ShareView>;

function rowsOf(view: ShareView): string[] {
  const rows = view.guests.map((guest) => guest.address);
  while (rows.length < MAX_REPORT_GUESTS) rows.push("");
  return rows;
}

export function ReportGuestsPicker({ initial }: { initial: ShareView | "unknown" }) {
  const id = useId();
  const known = initial === "unknown" ? null : initial;
  const [figures, setFigures] = useState<Set<ReportFigure>>(new Set(known?.figures ?? []));
  const [every, setEvery] = useState<ReportEvery>(known?.every ?? "week");
  const [rows, setRows] = useState<string[]>(known ? rowsOf(known) : []);
  const [statuses, setStatuses] = useState<Map<string, GuestStatus>>(new Map((known?.guests ?? []).map((g) => [g.address, g.status])));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");

  const titleId = `${id}-title`;
  if (!known) {
    return (
      <section aria-labelledby={titleId} className="mt-6">
        <h3 id={titleId} className="text-sm font-bold text-ink">
          Send your numbers to people outside your team
        </h3>
        <p className="mt-1 text-sm text-ink-soft">Your list could not be read just now, so it is not shown. Reload the page to try again.</p>
      </section>
    );
  }

  async function save() {
    setBusy(true);
    setSaid("Saving…");
    try {
      const response = await fetch("/api/store/report-guests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ figures: REPORT_FIGURES.filter((f) => figures.has(f)), every, addresses: rows }),
      });
      const body = (await response.json().catch(() => ({}))) as Saved;
      if (body.ok && body.figures && body.every && body.guests) {
        const view = { figures: body.figures, every: body.every, guests: body.guests };
        setFigures(new Set(view.figures));
        setEvery(view.every);
        setRows(rowsOf(view));
        setStatuses(new Map(view.guests.map((g) => [g.address, g.status])));
        const notSent = body.notSent ?? [];
        setSaid(
          notSent.length
            ? `Saved. The invitation to ${notSent.join(", ")} was not sent: your store's emails for this period may be used up. Remove the address and add it again later to send a new one.`
            : "Saved.",
        );
        return;
      }
      const why = body.error && REFUSALS[body.error];
      setSaid(why ? (body.address ? `${body.address} ${why}` : why) : "That did not save, and nothing changed. Try again in a minute.");
    } catch {
      setSaid("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={titleId} className="mt-6">
      <h3 id={titleId} className="text-sm font-bold text-ink">
        Send your numbers to people outside your team
      </h3>
      <p className="mt-1 text-sm text-ink-soft">
        For a partner, an investor or whoever keeps your books. They get only the figures you pick. Each new address is
        emailed an invitation first and gets nothing until it says yes, within {INVITE_DAYS} days. Every email has a link
        to stop it. Each email counts as one of your store&apos;s emails.
      </p>
      <form
        className="mt-3 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset>
          <legend className="text-sm font-bold text-ink">Figures to send</legend>
          <div className="mt-1">
            {FIGURES_OFFERED.map((figure) => (
              <label key={figure} className="flex min-h-11 items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-violet-brand"
                  checked={figures.has(figure)}
                  disabled={busy}
                  onChange={(event) => {
                    const next = new Set(figures);
                    if (event.target.checked) next.add(figure);
                    else next.delete(figure);
                    setFigures(next);
                  }}
                />
                {FIGURE_WORDS[figure]}
              </label>
            ))}
          </div>
          <p className="text-xs text-ink-soft">Money in is what buyers paid, renewals included, less refunds, before payment fees. Visits are the people who opened your store&apos;s pages.</p>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-bold text-ink">How often</legend>
          <div className="mt-1 flex flex-wrap gap-x-6">
            {(Object.keys(EVERY_LABELS) as ReportEvery[]).map((value) => (
              <label key={value} className="flex min-h-11 items-center gap-2 text-sm text-ink">
                <input type="radio" name={`${id}-every`} className="h-5 w-5 accent-violet-brand" checked={every === value} disabled={busy} onChange={() => setEvery(value)} />
                {EVERY_LABELS[value]}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-bold text-ink">Addresses (up to {MAX_REPORT_GUESTS})</legend>
          <div className="mt-1 space-y-3">
            {rows.map((value, i) => {
              const status = statuses.get(value.trim().toLowerCase());
              const statusId = `${id}-status-${i}`;
              return (
                <div key={i}>
                  <label htmlFor={`${id}-address-${i}`} className="block text-sm text-ink">
                    Address {i + 1}
                  </label>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <input
                      id={`${id}-address-${i}`}
                      type="email"
                      inputMode="email"
                      autoComplete="off"
                      maxLength={254}
                      className="field min-h-11 min-w-0 flex-1"
                      value={value}
                      disabled={busy}
                      aria-describedby={status ? statusId : undefined}
                      onChange={(event) => setRows(rows.map((row, j) => (j === i ? event.target.value : row)))}
                    />
                    {value ? (
                      <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRows(rows.map((row, j) => (j === i ? "" : row)))}>
                        Remove address {i + 1}
                      </button>
                    ) : null}
                  </div>
                  {status ? (
                    <p id={statusId} className="mt-1 text-xs text-ink-soft">
                      {STATUS_WORDS[status]}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </fieldset>
        <p className="text-xs text-ink-soft">A removed address stops getting the email at once. Adding it again sends a new invitation.</p>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          Save
        </button>
        <p role="status" aria-live="polite" className="text-sm text-ink">
          {said}
        </p>
      </form>
    </section>
  );
}
