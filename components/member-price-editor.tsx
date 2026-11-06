"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { formatMoney } from "@/lib/money";
import { MAX_MEMBER_RULES, MEMBER_PERCENT_CHOICES, type MemberPrices, type MemberRule } from "@/lib/member-price-rules";
import { type MemberEditChoices, type MemberEditField, checkMemberEdit, memberRuleLine } from "@/lib/member-price-edit";

type Problem = { message: string; field: MemberEditField; rule: number | null };

const SAVE_FAILED = "It could not be saved just now. Nothing was changed. Try again in a moment.";

function newRuleId(): string {
  return `r${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/**
 * Member and past-buyer prices (620 [SZ4]), set by the creator for their own
 * store: whoever holds one of their memberships, or bought one of their
 * products, pays less on the products they choose. Off until they switch it
 * on. Every change is reviewed in plain words ("will pay $X instead of $Y
 * for ...") before it is saved; the server checks it again
 * (app/api/store/member-price) and names the field to fix.
 */
export function MemberPriceEditor({
  initial,
  currency,
  choices,
  connected,
}: {
  initial: MemberPrices;
  currency: string;
  /** What the store sells now, or null when it could not be read. */
  choices: MemberEditChoices | null;
  /** Whether the store's Stripe account is connected: needed to switch it on. */
  connected: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = useState(initial.on);
  // A product that is no longer sold can't be picked here: it is taken out on opening, said so, and saved only after the review.
  const sold = new Set(choices?.qualifying.map((q) => q.id) ?? []);
  const lowerable = new Set(choices?.discounted.map((d) => d.id) ?? []);
  const [rules, setRules] = useState<MemberRule[]>(() =>
    initial.rules.map((rule) => ({ ...rule, by: rule.by.filter((id) => sold.has(id)), products: rule.products.filter((id) => lowerable.has(id)) })),
  );
  const [dropped] = useState(() => initial.rules.some((rule) => rule.by.some((id) => !sold.has(id)) || rule.products.some((id) => !lowerable.has(id))));
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);

  if (!choices) {
    return (
      <div className="card p-6 sm:p-8" id="member-prices">
        <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">Member prices</h2>
        <p className="notice notice-error mt-3" role="alert">
          Your products could not be read just now, so member prices can&apos;t be changed. Reload the page to try again.
        </p>
      </div>
    );
  }
  const options = choices;
  const body = { on, rules };
  const changed = JSON.stringify(body) !== JSON.stringify({ on: initial.on, rules: initial.rules });

  const update = (index: number, change: Partial<MemberRule>) => {
    setProblem(null);
    setRules((rows) => rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
  };
  const toggle = (list: string[], id: string, checked: boolean) => (checked ? [...list.filter((v) => v !== id), id] : list.filter((v) => v !== id));

  function review() {
    const checked = checkMemberEdit(body, options, connected);
    if (!checked.ok) {
      setProblem({ message: checked.message, field: checked.field, rule: checked.rule });
      return;
    }
    setProblem(null);
    setReviewing(true);
    requestAnimationFrame(() => reviewRef.current?.focus());
  }

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch("/api/store/member-price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; field?: MemberEditField; rule?: number | null };
      if (!data.ok) {
        setReviewing(false);
        setProblem({ message: typeof data.message === "string" && data.message ? data.message : SAVE_FAILED, field: data.field ?? "form", rule: data.rule ?? null });
        return;
      }
      setReviewing(false);
      toast(on ? "Saved. Member prices are on." : "Saved. Member prices are off: everybody pays your normal prices.");
      router.refresh();
    } catch {
      setReviewing(false);
      setProblem({ message: SAVE_FAILED, field: "form", rule: null });
    } finally {
      setBusy(false);
    }
  }

  const problemAt = (field: MemberEditField, index: number | null) => problem !== null && problem.field === field && problem.rule === index;
  const fieldError = (field: MemberEditField, index: number, id: string) =>
    problemAt(field, index) ? (
      <p id={id} className="mt-1 text-sm font-semibold text-danger">
        {problem?.message}
      </p>
    ) : null;

  if (reviewing) {
    return (
      <div className="card p-6 sm:p-8" id="member-prices">
        <h2 ref={reviewRef} tabIndex={-1} className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Review your member prices
        </h2>
        <p className="mt-2 text-ink-soft">
          {on
            ? "Member prices will be on. This is what buyers will pay:"
            : "Member prices will be off: everybody pays your normal prices. Your rules are kept for later:"}
        </p>
        {rules.length ? (
          <ol className="mt-3 list-decimal space-y-2 pl-6 text-ink">
            {rules.map((rule) => (
              <li key={rule.id}>{memberRuleLine(rule, options, currency)}</li>
            ))}
          </ol>
        ) : (
          <p className="mt-3 text-ink">You have no rules.</p>
        )}
        <p className="mt-3 text-sm text-ink-soft">
          A buyer sees the lower price after they sign in, or open the link we email them, with the address they bought with.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button type="button" className="btn btn-primary btn-sm min-h-11" onClick={() => void save()} disabled={busy} aria-busy={busy}>
            {busy ? "Saving…" : "Confirm and save"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm min-h-11" onClick={() => setReviewing(false)} disabled={busy}>
            Go back and change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card p-6 sm:p-8" id="member-prices">
      <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">Member prices</h2>
      <p className="mt-2 text-ink-soft">
        People who have one of your memberships, or bought one of your products, pay less on the products you choose. Stripe takes it off at
        checkout, with no code to type. Off until you switch it on.
      </p>

      <label className="mt-5 flex min-h-11 cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0"
          checked={on}
          onChange={(event) => {
            setProblem(null);
            setOn(event.target.checked);
          }}
          aria-describedby={problemAt("on", null) ? "member-on-error" : undefined}
        />
        <span>
          <span className="block font-semibold text-ink">Give members lower prices</span>
          <span className="block text-sm text-ink-soft">
            On products bought once at one price, the same ones a sale covers. When a sale or a fair price also applies, the largest is taken off,
            never two.
          </span>
        </span>
      </label>
      {problemAt("on", null) ? (
        <p id="member-on-error" className="mt-1 text-sm font-semibold text-danger">
          {problem?.message}
        </p>
      ) : null}
      {dropped ? (
        <p className="notice notice-warn mt-3" role="status">
          A product in your rules is no longer sold, so it was taken out of them below. Review and save to keep this change.
        </p>
      ) : null}
      {!connected ? <p className="mt-2 text-sm text-ink-soft">Connect your Stripe account to switch member prices on. You can write your rules now.</p> : null}

      {rules.map((rule, index) => {
        const percentId = `member-percent-${rule.id}`;
        return (
          <fieldset key={rule.id} className="mt-6 rounded-2xl bg-paper p-4 ring-1 ring-line">
            <legend className="px-1 font-semibold text-ink">{`Rule ${index + 1}`}</legend>
            {problemAt("rules", index) ? (
              <p className="text-sm font-semibold text-danger">{problem?.message}</p>
            ) : null}

            <fieldset className="mt-2" aria-describedby={problemAt("by", index) ? `member-by-error-${rule.id}` : undefined}>
              <legend className="field-label">Who pays less</legend>
              <p className="text-sm text-ink-soft">Anyone who has one of these. A membership counts while it is paid; a product counts once it is paid and not refunded.</p>
              {options.qualifying.length ? (
                <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
                  {options.qualifying.map((q) => (
                    <li key={q.id}>
                      <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
                        <input type="checkbox" className="h-4 w-4" checked={rule.by.includes(q.id)} onChange={(event) => update(index, { by: toggle(rule.by, q.id, event.target.checked) })} />
                        <span className="min-w-0 break-words">{`${q.title} (${q.membership ? "membership" : "bought once"})`}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-ink-soft">You have no paid products yet. Add one first.</p>
              )}
              {fieldError("by", index, `member-by-error-${rule.id}`)}
            </fieldset>

            <div className="mt-4 max-w-xs">
              <label htmlFor={percentId} className="field-label">
                How much less
              </label>
              <select
                id={percentId}
                className="field mt-1 min-h-11"
                value={rule.percent}
                onChange={(event) => update(index, { percent: Number(event.target.value) })}
                aria-describedby={problemAt("percent", index) ? `${percentId}-error` : undefined}
              >
                {MEMBER_PERCENT_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>{`${choice}% less`}</option>
                ))}
              </select>
              {fieldError("percent", index, `${percentId}-error`)}
            </div>

            <fieldset className="mt-4" aria-describedby={problemAt("products", index) ? `member-products-error-${rule.id}` : undefined}>
              <legend className="field-label">Which products cost less</legend>
              <label className="mt-1 flex min-h-11 items-center gap-3 text-sm text-ink">
                <input type="radio" name={`member-all-${rule.id}`} checked={rule.all} onChange={() => update(index, { all: true, products: [] })} className="h-4 w-4" />
                Every product a sale can cover, including ones you add later
              </label>
              <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
                <input type="radio" name={`member-all-${rule.id}`} checked={!rule.all} onChange={() => update(index, { all: false })} className="h-4 w-4" />
                Only the ones I pick
              </label>
              {!rule.all ? (
                options.discounted.length ? (
                  <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-2xl border border-line p-3">
                    {options.discounted.map((d) => (
                      <li key={d.id}>
                        <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={rule.products.includes(d.id)}
                            onChange={(event) => update(index, { products: toggle(rule.products, d.id, event.target.checked) })}
                          />
                          <span className="min-w-0 break-words">{`${d.title}, ${formatMoney(d.priceCents, currency)}`}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-ink-soft">None of your products can have a member price yet: add one sold once at one price.</p>
                )
              ) : null}
              <p className="mt-2 text-xs text-ink-soft">Memberships, calls, products with price options and products whose buyers name the price never get one.</p>
              {fieldError("products", index, `member-products-error-${rule.id}`)}
            </fieldset>

            {rule.by.length && (rule.all || rule.products.length) ? <p className="mt-4 text-sm text-ink">{memberRuleLine(rule, options, currency)}</p> : null}

            <button
              type="button"
              onClick={() => {
                setProblem(null);
                setRules((rows) => rows.filter((_, i) => i !== index));
              }}
              className="mt-4 inline-flex min-h-11 min-w-11 items-center gap-2 rounded-full px-3 text-sm font-semibold text-ink-soft hover:bg-danger-soft hover:text-danger"
            >
              <Icon name="trash" size={17} />
              Remove this rule<span className="sr-only">{` (rule ${index + 1})`}</span>
            </button>
          </fieldset>
        );
      })}

      {rules.length < MAX_MEMBER_RULES ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm mt-4 min-h-11"
          onClick={() => {
            setProblem(null);
            setRules((rows) => [...rows, { id: newRuleId(), percent: 20, by: [], all: true, products: [] }]);
          }}
        >
          <Icon name="plus" size={17} />
          Add a rule
        </button>
      ) : (
        <p className="mt-4 text-sm text-ink-soft">{`You have the most rules a store can have (${MAX_MEMBER_RULES}).`}</p>
      )}

      {problem ? (
        <p className="notice notice-error mt-4" role="alert">
          {`${problem.rule !== null ? `Rule ${problem.rule + 1}: ` : ""}${problem.message}`}
        </p>
      ) : null}
      <button type="button" className="btn btn-primary btn-sm mt-4 min-h-11" onClick={review} disabled={busy || !changed}>
        Review changes
      </button>
    </div>
  );
}
