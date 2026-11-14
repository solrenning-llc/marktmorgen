"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { CADENCE_NAMES, MAX_BENEFIT_TEXT, type Benefit, type Cadence } from "@/lib/tier-benefit-rules";

/** One row as the page hands it over: no person key, and the address only to a role that may see buyers. */
export type BenefitRow = {
  benefit: string;
  sub: string;
  email: string;
  period: string;
  until: number | null;
  given: { at: number; by: string } | null | "unknown";
};

export type BenefitsPanel =
  | { state: "none" }
  | { state: "unknown"; why: "benefits" | "stripe" | "erased" }
  | {
      state: "ok";
      benefits: Benefit[];
      rows: BenefitRow[];
      /** Rows not handed over to keep the page small, by benefit (waiting ones past the first MAX_GIVE_AT_ONCE). */
      more: Record<string, number>;
      waiting: Record<string, { trial: number; unpaid: number; paused: number }>;
      complete: boolean;
      unreadable: number;
    };

const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Benefits you hand over by hand on each membership (422 [PT2], unit 1):
 * add one, see who is still waiting for it and until when, and mark them
 * given, many at once, after a count and a confirmation. Marking is your
 * own record; nothing is sent to anyone. Everything is read again from your
 * Stripe account on each press (lib/tier-benefits.ts).
 */
export function TierBenefits({
  panel,
  memberships,
  canDefine,
  canMark,
}: {
  panel: BenefitsPanel;
  memberships: { id: string; title: string }[];
  canDefine: boolean;
  canMark: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});
  const [confirming, setConfirming] = useState("");
  const [retiring, setRetiring] = useState("");
  const [product, setProduct] = useState(memberships[0]?.id ?? "");
  const [text, setText] = useState("");
  const [cadence, setCadence] = useState<Cadence>("once");

  const titleOf = (p: string) => memberships.find((m) => m.id === p)?.title ?? "A membership you have since removed";

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const response = await fetch("/api/store/tier-benefits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return response.ok ? data : { ok: false, message: typeof data.message === "string" ? data.message : "That could not be done just now. Nothing was changed. Try again in a minute." };
    } catch {
      return { ok: false, message: "That could not be done just now. Nothing was changed. Try again in a minute." };
    }
  }

  async function act(key: string, body: Record<string, unknown>, said: (data: Record<string, unknown>) => string): Promise<boolean> {
    setBusy(key);
    setMessage(null);
    const data = await post(body);
    setBusy("");
    if (data.ok !== true) {
      setMessage({ error: true, text: typeof data.message === "string" ? data.message : "That could not be done just now. Try again in a minute." });
      return false;
    }
    const words = said(data);
    setMessage({ error: false, text: words });
    toast(words);
    router.refresh();
    return true;
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (await act("add", { action: "add", product, text, cadence }, () => "Benefit added. Members owed it are listed below.")) setText("");
  }

  async function give(benefit: string, chosen: string[]) {
    const items = chosen.map((key) => {
      const [sub, period] = key.split("|");
      return { sub, period };
    });
    const ok = await act(`give:${benefit}`, { action: "give", benefit, items }, (d) => {
      const parts = [`${Number(d.given) || 0} marked given`];
      if (Number(d.already)) parts.push(`${d.already} already marked`);
      if (Number(d.notOwed)) parts.push(`${d.notOwed} no longer owed, left as they were`);
      if (Number(d.unknown)) parts.push(`${d.unknown} could not be read, so not marked`);
      return `${parts.join(", ")}.`;
    });
    setConfirming("");
    if (ok) setPicked({ ...picked, [benefit]: new Set() });
  }

  const toggle = (benefit: string, key: string, on: boolean) => {
    const next = new Set(picked[benefit] ?? []);
    if (on) next.add(key);
    else next.delete(key);
    setPicked({ ...picked, [benefit]: next });
  };

  return (
    <div>
      <p className="max-w-2xl text-sm text-ink-soft">
        Things you hand over yourself with a membership, like a signed print once or a call every month. Here you see who is
        still waiting for each one, and mark it given when you have handed it over. Marking is your own record: nothing is
        sent, charged or shipped from here.
      </p>

      <div aria-live="polite" className="mt-3">
        {message ? (
          <p className={`notice ${message.error ? "notice-error" : "notice-info"}`} role={message.error ? "alert" : undefined}>
            {message.text}
          </p>
        ) : null}
      </div>

      {panel.state === "unknown" ? (
        <p className="notice notice-error mt-4" role="alert">
          {panel.why === "stripe"
            ? "Your memberships could not be read from Stripe just now, so who is waiting is not known. Nothing was changed. Reload the page in a minute."
            : panel.why === "erased"
              ? "We could not check which people you deleted from your store just now, so who is waiting is not shown. Nothing was changed. Reload the page in a minute."
              : "Your benefits could not be read just now, so who is waiting is not known. Nothing was changed. Reload the page in a minute."}
        </p>
      ) : panel.state === "ok" ? (
        <>
          {!panel.complete || panel.unreadable ? (
            <p className="notice notice-info mt-4">
              {`Some of your memberships could not be read${panel.unreadable ? ` (${panel.unreadable})` : ""}, or there were more than one reading takes, so someone may be missing from these lists. Nobody is shown as given who was not marked.`}
            </p>
          ) : null}
          {panel.benefits.map((b) => {
            const rows = panel.rows.filter((r) => r.benefit === b.id);
            const pending = rows.filter((r) => r.given === null);
            const unknown = rows.filter((r) => r.given === "unknown");
            const given = rows.filter((r) => r.given && r.given !== "unknown");
            const chosen = [...(picked[b.id] ?? [])].filter((key) => pending.some((r) => `${r.sub}|${r.period}` === key));
            const wait = panel.waiting[b.id] ?? { trial: 0, unpaid: 0, paused: 0 };
            const more = panel.more[b.id] ?? 0;
            const titleId = `${id}-${b.id}`;
            return (
              <section key={b.id} aria-labelledby={titleId} className="mt-6 rounded-xl p-4 ring-1 ring-line" data-benefit={b.id}>
                <h3 id={titleId} className="text-base font-semibold text-ink [overflow-wrap:anywhere]">{b.text}</h3>
                <p className="mt-1 text-sm text-ink-soft">
                  {`${titleOf(b.product)} · ${CADENCE_NAMES[b.cadence]} · added ${day(b.since)}`}
                  {b.retired ? ` · retired ${day(b.retired)}, still listed for what was owed before` : ""}
                </p>
                <p className="mt-2 text-sm text-ink">
                  {`${plural(pending.length + more, "member waiting", "members waiting")}, ${plural(given.length, "marked given", "marked given")}${b.cadence === "monthly" ? " for their current month" : ""}.`}
                  {unknown.length ? ` ${plural(unknown.length, "member", "members")} could not be read, so whether it was given is not known.` : ""}
                </p>
                {wait.trial || wait.unpaid || wait.paused ? (
                  <p className="mt-1 text-sm text-ink-soft">
                    {[
                      wait.trial ? `${plural(wait.trial, "member", "members")} in a free trial, not owed it until they pay` : "",
                      wait.unpaid ? `${plural(wait.unpaid, "member", "members")} whose payment has not gone through${b.cadence === "monthly" ? ", not owed this month yet" : ""}` : "",
                      wait.paused ? `${plural(wait.paused, "member", "members")} paused, not owed it while paused` : "",
                    ]
                      .filter(Boolean)
                      .join(". ") + "."}
                  </p>
                ) : null}

                {pending.length === 0 && !more ? (
                  <p className="mt-3 text-sm text-ink-soft">
                    {panel.complete && !panel.unreadable && !unknown.length ? "Nobody is waiting for this benefit right now." : "Nobody waiting among the memberships that could be read."}
                  </p>
                ) : canMark ? (
                  <fieldset className="mt-3">
                    <legend className="text-sm font-semibold text-ink">{`Who is waiting for “${b.text}”`}</legend>
                    <label className="mt-2 flex min-h-11 items-center gap-3 text-sm text-ink">
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        checked={chosen.length === pending.length && pending.length > 0}
                        onChange={(e) => setPicked({ ...picked, [b.id]: new Set(e.target.checked ? pending.map((r) => `${r.sub}|${r.period}`) : []) })}
                      />
                      {`Select all ${pending.length} shown`}
                    </label>
                    <ul className="mt-1 divide-y divide-line">
                      {pending.map((r) => {
                        const key = `${r.sub}|${r.period}`;
                        return (
                          <li key={key}>
                            <label className="flex min-h-11 items-center gap-3 py-1 text-sm text-ink [overflow-wrap:anywhere]">
                              <input type="checkbox" className="h-5 w-5" checked={chosen.includes(key)} onChange={(e) => toggle(b.id, key, e.target.checked)} />
                              <span>
                                {r.email || "A member"}
                                <span className="block text-xs text-ink-soft">{r.until ? `For their month ending ${day(r.until)}` : "Once; no date was promised"}</span>
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                    {more ? <p className="mt-2 text-xs text-ink-soft">{`And ${more} more. Mark these, and the next ones are shown.`}</p> : null}
                    {confirming === b.id ? (
                      <div className="mt-3 rounded-xl bg-paper p-3 ring-1 ring-line" role="group" aria-label="Confirm marking">
                        <p className="text-sm text-ink">{`Mark ${plural(chosen.length, "member", "members")} as given “${b.text}”? This records that you handed it over. You can take a mark back.`}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button type="button" className="btn btn-primary" disabled={busy !== ""} aria-busy={busy === `give:${b.id}`} onClick={() => void give(b.id, chosen)}>
                            Confirm
                          </button>
                          <button type="button" className="btn btn-secondary" disabled={busy !== ""} onClick={() => setConfirming("")}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" className="btn btn-secondary mt-3" disabled={busy !== "" || chosen.length === 0} onClick={() => setConfirming(b.id)}>
                        {chosen.length ? `Mark ${chosen.length} as given` : "Select who you handed it to"}
                      </button>
                    )}
                  </fieldset>
                ) : null}

                {canMark && unknown.length ? (
                  <ul className="mt-3 space-y-1 text-sm text-ink-soft">
                    {unknown.map((r) => (
                      <li key={`${r.sub}|${r.period}`} className="[overflow-wrap:anywhere]">{`${r.email || "A member"}: could not be read whether it was given; not shown as given or waiting`}</li>
                    ))}
                  </ul>
                ) : null}

                {canMark && given.length ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm font-semibold text-ink">{`Marked given (${given.length})`}</summary>
                    <ul className="mt-2 divide-y divide-line">
                      {given.map((r) => (
                        <li key={`${r.sub}|${r.period}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-1 text-sm">
                          <span className="[overflow-wrap:anywhere]">
                            {r.email || "A member"}
                            <span className="block text-xs text-ink-soft">
                              {r.given && r.given !== "unknown" ? `Marked ${day(r.given.at)}${r.given.by ? ` by ${r.given.by}` : ""}` : ""}
                            </span>
                          </span>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={busy !== ""}
                            aria-busy={busy === `undo:${r.sub}`}
                            onClick={() => void act(`undo:${r.sub}`, { action: "undo", benefit: b.id, sub: r.sub, period: r.period }, (d) => (d.undone ? "Mark taken back. They are waiting again." : "There was no mark to take back."))}
                          >
                            {`Take back the mark for ${r.email || "this member"}`}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                {canDefine && !b.retired ? (
                  retiring === b.id ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Confirm retiring">
                      <p className="text-sm text-ink">Retire it? Nobody is owed it from now on; what was owed before stays listed.</p>
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy !== ""} onClick={() => void act(`retire:${b.id}`, { action: "retire", benefit: b.id }, () => "Benefit retired.").then(() => setRetiring(""))}>
                        Confirm retiring
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== ""} onClick={() => setRetiring("")}>
                        Keep it
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="btn btn-secondary btn-sm mt-3" disabled={busy !== ""} onClick={() => setRetiring(b.id)}>
                      {`Retire “${b.text}”`}
                    </button>
                  )
                ) : null}
              </section>
            );
          })}
        </>
      ) : (
        <p className="mt-4 text-sm text-ink-soft">No benefit yet.</p>
      )}

      {canDefine ? (
        memberships.length ? (
          <form onSubmit={add} className="mt-6 grid gap-3 sm:max-w-xl">
            <h3 className="text-base font-semibold text-ink">Add a benefit</h3>
            <label className="block" htmlFor={`${id}-product`}>
              <span className="field-label">Membership</span>
              <select id={`${id}-product`} className="field" value={product} onChange={(e) => setProduct(e.target.value)}>
                {memberships.map((m) => (
                  <option key={m.id} value={m.id}>{m.title}</option>
                ))}
              </select>
            </label>
            <label className="block" htmlFor={`${id}-text`}>
              <span className="field-label">What you hand over</span>
              <input
                id={`${id}-text`}
                className="field"
                required
                maxLength={MAX_BENEFIT_TEXT}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="For example: a signed print"
                aria-describedby={`${id}-text-help`}
              />
              <span id={`${id}-text-help`} className="mt-1 block text-xs text-ink-soft">{`${text.length} of ${MAX_BENEFIT_TEXT} characters`}</span>
            </label>
            <fieldset>
              <legend className="field-label">How often</legend>
              <div className="flex flex-wrap gap-4">
                {(Object.keys(CADENCE_NAMES) as Cadence[]).map((c) => (
                  <label key={c} className="flex min-h-11 items-center gap-2 text-sm text-ink">
                    <input type="radio" name={`${id}-cadence`} className="h-5 w-5" value={c} checked={cadence === c} onChange={() => setCadence(c)} />
                    {c === "once" ? "Once, after they have paid" : "Every month they have paid for"}
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <button type="submit" className="btn btn-primary" disabled={busy !== "" || !text.trim() || !product} aria-busy={busy === "add"}>
                Add the benefit
              </button>
            </div>
          </form>
        ) : (
          <p className="mt-6 text-sm text-ink-soft">Add a membership first: benefits are set on a membership.</p>
        )
      ) : null}
    </div>
  );
}
