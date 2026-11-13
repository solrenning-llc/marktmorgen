"use client";

import { useId, useState } from "react";
import { toast } from "@/components/toast";
import { EmailInput } from "@/components/email-input";
import { formatMoney } from "@/lib/money";
import type { MemberSub } from "@/lib/member-discount";

/**
 * Give one member a discount on their running membership (616 [WP15](8)):
 * their address, then their memberships here and your active codes, then
 * one press for one membership. Nothing changes before that press; the server
 * reads everything again from your Stripe account (lib/member-discount.ts).
 */
export function MemberDiscount({ titles }: { titles: Record<string, string> }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [found, setFound] = useState<{ email: string; memberships: MemberSub[]; codes: { id: string; code: string }[] } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const response = await fetch("/api/store/member-discount", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return response.ok ? data : { ok: false, message: typeof data.message === "string" ? data.message : "That could not be done just now. Try again in a minute." };
    } catch {
      return { ok: false, message: "That could not be done just now. Try again in a minute." };
    }
  }

  async function find(event: React.FormEvent) {
    event.preventDefault();
    setBusy("find");
    setMessage(null);
    const data = await post({ action: "find", email });
    setBusy("");
    if (data.ok !== true || !Array.isArray(data.memberships) || !Array.isArray(data.codes)) {
      setFound(null);
      setMessage(typeof data.message === "string" ? data.message : "That could not be done just now. Try again in a minute.");
      return;
    }
    const codes = data.codes as { id: string; code: string }[];
    setFound({ email, memberships: data.memberships as MemberSub[], codes });
    setCode(codes[0]?.id ?? "");
  }

  async function apply(subscription: string) {
    if (!found) return;
    setBusy(subscription);
    setMessage(null);
    const data = await post({ action: "apply", email: found.email, subscription, code });
    setBusy("");
    if (data.ok !== true) {
      setMessage(typeof data.message === "string" ? data.message : "That could not be done just now. Try again in a minute.");
      return;
    }
    toast("Discount put on the membership. Stripe takes it off from the next renewal, by the code's own rules.");
    setFound({ ...found, memberships: found.memberships.map((m) => (m.id === subscription ? { ...m, discounted: true } : m)) });
  }

  return (
    <div>
      <p className="text-sm text-ink-soft">
        For one member: one of your active codes on their running membership, from the next renewal, by the code&apos;s own rules. A
        membership that already has a discount is left as it is. Nothing changes until you press &quot;Put the code on&quot;.
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
            <p className="text-sm text-ink-soft">{`${found.email} has no running membership at this store.`}</p>
          ) : found.codes.length === 0 ? (
            <p className="text-sm text-ink-soft">You have no active discount code. Make one under Discounts first.</p>
          ) : (
            <>
              <label className="block max-w-xs" htmlFor={`${id}-code`}>
                <span className="field-label">Code to put on</span>
                <select id={`${id}-code`} className="field" value={code} onChange={(e) => setCode(e.target.value)}>
                  {found.codes.map((c) => (
                    <option key={c.id} value={c.id}>{c.code}</option>
                  ))}
                </select>
              </label>
              <ul className="mt-3 space-y-2">
                {found.memberships.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] px-3 py-2 ring-1 ring-line">
                    <span className="text-sm text-ink">
                      {`${titles[m.product] ?? "A membership"} · ${m.amount && m.currency ? formatMoney(m.amount, m.currency.toUpperCase()) : "amount not known"}${m.interval ? ` a ${m.interval}` : ""}`}
                      {m.discounted ? <span className="text-ink-soft"> · a discount already comes off</span> : null}
                      {m.discounted === null ? <span className="text-ink-soft"> · whether a discount already comes off could not be read, so it is left as it is</span> : null}
                    </span>
                    {m.discounted === false ? (
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy !== "" || !code} aria-busy={busy === m.id} onClick={() => void apply(m.id)}>
                        Put the code on
                      </button>
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
