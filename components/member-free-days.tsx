"use client";

import { useId, useState } from "react";
import { toast } from "@/components/toast";
import { EmailInput } from "@/components/email-input";
import { formatMoney } from "@/lib/money";
import { BLOCK_WORDS, FREE_DAYS_MAX, type FreeDaysSub, movedCharge, parseFreeDays } from "@/lib/member-free-days-rules";

const DATE = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const day = (seconds: number) => DATE.format(new Date(seconds * 1000));
const daysWord = (n: number) => (n === 1 ? "1 free day" : `${n} free days`);
const AGAIN = "That could not be done just now. Try again in a minute.";

/**
 * Give one member free days on their running membership (641 [WG1]): their
 * address, then their memberships here with each next charge, then how many
 * days, then a review that shows the new date, then one press. Nothing
 * changes before that press; the server reads everything again from your
 * Stripe account (lib/member-free-days.ts).
 */
export function MemberFreeDays({ titles }: { titles: Record<string, string> }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [found, setFound] = useState<{ email: string; memberships: FreeDaysSub[] } | null>(null);
  const [days, setDays] = useState("7");
  const [review, setReview] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [given, setGiven] = useState<{ id: string; nextCharge: number; emailed: boolean } | null>(null);
  const count = parseFreeDays(days);

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const response = await fetch("/api/store/member-free-days", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return response.ok ? data : { ok: false, message: typeof data.message === "string" ? data.message : AGAIN };
    } catch {
      return { ok: false, message: AGAIN };
    }
  }

  async function find(event: React.FormEvent) {
    event.preventDefault();
    setBusy("find");
    setMessage(null);
    setReview("");
    setGiven(null);
    const data = await post({ action: "find", email });
    setBusy("");
    if (data.ok !== true || !Array.isArray(data.memberships)) {
      setFound(null);
      setMessage(typeof data.message === "string" ? data.message : AGAIN);
      return;
    }
    setFound({ email, memberships: data.memberships as FreeDaysSub[] });
  }

  async function give(m: FreeDaysSub) {
    if (!found || count === null) return;
    setBusy(m.id);
    setMessage(null);
    const data = await post({ action: "give", email: found.email, subscription: m.id, days: count, expected: m.nextCharge });
    setBusy("");
    if (data.ok !== true || typeof data.nextCharge !== "number") {
      setMessage(typeof data.message === "string" ? data.message : AGAIN);
      return;
    }
    const nextCharge = data.nextCharge;
    setReview("");
    setGiven({ id: m.id, nextCharge, emailed: data.emailed === true });
    setFound({ ...found, memberships: found.memberships.map((s) => (s.id === m.id ? { ...s, nextCharge } : s)) });
    toast(`${daysWord(count)} given. The next charge is now ${day(nextCharge)}.`);
  }

  return (
    <div>
      <p className="text-sm text-ink-soft">
        For one member, as a thank-you or to make up for a problem: their next charge moves a number of days later, on your Stripe account. They
        keep everything their membership includes, and get an email from your store with the new date. Nothing changes until you review the new
        date and press &quot;Give&quot;.
      </p>
      <form onSubmit={find} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block min-w-0 flex-1" htmlFor={`${id}-email`}>
          <span className="field-label">The member&apos;s email</span>
          <EmailInput id={`${id}-email`} required autoComplete="off" value={email} onChange={setEmail} className="field" />
        </label>
        <button type="submit" className="btn btn-secondary" disabled={busy !== "" || !email.trim()} aria-busy={busy === "find"}>
          Find their memberships
        </button>
      </form>
      {message ? <p className="notice notice-error mt-3" role="alert">{message}</p> : null}
      {found ? (
        <div className="mt-4" role="status">
          {found.memberships.length === 0 ? (
            <p className="text-sm text-ink-soft">
              {/* Stripe's email filter is exact (lib/address-customers.ts): an empty list is not proof of no membership. */}
              {`No running membership was found under ${found.email}. Stripe matches capital letters exactly, so type the address the way the member typed it at checkout.`}
            </p>
          ) : (
            <>
              <label className="block max-w-xs" htmlFor={`${id}-days`}>
                <span className="field-label">Free days to give</span>
                <input
                  id={`${id}-days`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={FREE_DAYS_MAX}
                  step={1}
                  required
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  aria-describedby={`${id}-days-hint`}
                  aria-invalid={count === null}
                  className="field"
                />
              </label>
              <p id={`${id}-days-hint`} className="field-hint mt-1 text-sm text-ink-soft">
                {count === null
                  ? `Type a whole number from 1 to ${FREE_DAYS_MAX}.`
                  : `A whole number from 1 to ${FREE_DAYS_MAX}. Up to ${FREE_DAYS_MAX} days, one quarter: for longer, a discount code says it better.`}
              </p>
              <ul className="mt-3 space-y-2">
                {found.memberships.map((m) => (
                  <li key={m.id} className="rounded-[10px] px-3 py-2 ring-1 ring-line">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm text-ink">
                        {`${titles[m.product] ?? "A membership"} · ${m.amount && m.currency ? formatMoney(m.amount, m.currency.toUpperCase()) : "amount not known"}${m.interval ? ` a ${m.interval}` : ""}`}
                        <span className="block text-ink-soft">
                          {m.blocked ? `Cannot be moved: ${BLOCK_WORDS[m.blocked]}.` : `Next charge: ${day(m.nextCharge)}`}
                        </span>
                      </span>
                      {m.blocked || review === m.id ? null : (
                        <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== "" || count === null} onClick={() => { setReview(m.id); setGiven(null); setMessage(null); }}>
                          Review the new date
                        </button>
                      )}
                    </div>
                    {review === m.id && !m.blocked && count !== null ? (
                      <div className="mt-3 rounded-[8px] bg-sand p-3">
                        <p className="text-sm text-ink">
                          {`Review: the next charge moves from ${day(m.nextCharge)} to ${day(movedCharge(m.nextCharge, count))}, ${daysWord(count)} later. ${found.email} gets an email from your store saying so, counted in your store's emails.`}
                        </p>
                        <p className="mt-1 text-sm text-ink-soft">
                          While the free days run, Stripe shows the membership as in a free trial. A member who has paid still counts as paying here, and can switch plans or move to yearly once the next charge is paid.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button type="button" className="btn btn-primary btn-sm" disabled={busy !== ""} aria-busy={busy === m.id} onClick={() => void give(m)}>
                            {`Give ${daysWord(count)}`}
                          </button>
                          <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== ""} onClick={() => setReview("")}>
                            Go back
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {given?.id === m.id ? (
                      <p className="mt-2 text-sm text-ink">
                        {`Done: the next charge is now ${day(given.nextCharge)}. ${given.emailed ? "The member was emailed the new date." : "The email to the member could not be sent (your store's emails may be used up for this month), so tell them yourself."}`}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
