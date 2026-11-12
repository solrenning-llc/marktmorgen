"use client";

import { useId, useState } from "react";

/**
 * Two small working copies of what a buyer meets on a store page, so a
 * creator can try the idea before signing up. They charge nothing and send
 * nothing; the labels are the store page's own.
 */

function Frame({ bar, children }: { bar: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[var(--r-xl)] border border-white/10 bg-white text-ink shadow-[var(--shadow-device)]">
      <div className="flex items-center gap-2 border-b border-line bg-paper px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-sand-deep" />
          <span className="h-2.5 w-2.5 rounded-full bg-sand-deep" />
          <span className="h-2.5 w-2.5 rounded-full bg-sand-deep" />
        </span>
        <span className="min-w-0 flex-1 truncate rounded-[6px] bg-white px-2.5 py-1 text-center text-[11px] font-medium text-ink-soft ring-1 ring-line">
          {bar}
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * What pressing a demo's button says. Before this, the button did nothing at all (VR site sweep, 12/11/2026):
 * a button that looks like it pays and answers nothing is make-believe (AGENTS.md, VR Part A, item 2). It now says
 * plainly what would happen on a real store, and that nothing happens here.
 */
export function demoPressedWords(price: number): string {
  return `This is a preview, so nothing happens here. On your store, this button opens a secure checkout for $${price}.`;
}

const OPTIONS = [
  { id: "one", label: "1 week", detail: "PDF, 1 page", price: 27 },
  { id: "five", label: "5 weeks", detail: "PDF, 5 pages", price: 39 },
  { id: "season", label: "The season", detail: "PDF, 12 pages", price: 69 },
];

/** Price options: pick one and the button follows. */
export function OptionsDemo() {
  const name = useId();
  const [chosen, setChosen] = useState("five");
  const [pressed, setPressed] = useState(false);
  const price = OPTIONS.find((o) => o.id === chosen)?.price ?? 0;
  return (
    <Frame bar="Pick a size">
      <form className="p-5" onSubmit={(e) => { e.preventDefault(); setPressed(true); }}>
        <fieldset>
          <legend className="text-[15px] font-semibold text-ink">Weekly meal planner</legend>
          <p className="mt-0.5 text-[12.5px] text-ink-soft">A plan for every night, with the shopping list.</p>
          <div className="mt-4 space-y-2">
            {OPTIONS.map((o) => (
              <label
                key={o.id}
                className={`flex cursor-pointer items-center justify-between gap-3 rounded-[var(--r-sm)] border px-3.5 py-3 transition-colors ${
                  chosen === o.id ? "border-violet-brand bg-lilac/60" : "border-line bg-white hover:border-line-strong"
                }`}
              >
                <span className="flex items-center gap-3">
                  <input
                    type="radio"
                    name={name}
                    value={o.id}
                    checked={chosen === o.id}
                    onChange={() => setChosen(o.id)}
                    className="h-4 w-4 accent-[var(--violet)]"
                  />
                  <span>
                    <span className="block text-[13.5px] font-semibold text-ink">{o.label}</span>
                    <span className="block text-[12px] text-ink-soft">{o.detail}</span>
                  </span>
                </span>
                <span className="text-[13.5px] font-semibold tabular-nums text-ink">{`$${o.price}`}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-4 flex items-center justify-between rounded-[var(--r-sm)] bg-sand px-3.5 py-2.5 text-[13px] text-ink-soft" aria-live="polite">
          <span>Charged at checkout</span>
          <span className="font-semibold tabular-nums text-ink">{`$${price}`}</span>
        </p>
        <button type="submit" className="btn btn-primary btn-block mt-3" aria-describedby={`${name}-note`}>
          Continue with this option
        </button>
        <p id={`${name}-note`} className="mt-3 text-center text-[12px] text-ink-soft">
          A preview to try: nothing is charged here.
        </p>
        <p role="status" className="mt-2 text-center text-[13px] font-semibold text-ink">
          {pressed ? demoPressedWords(price) : ""}
        </p>
      </form>
    </Frame>
  );
}

/** An order bump and a payment plan: the button says what is charged. */
export function BumpDemo() {
  const id = useId();
  const [bump, setBump] = useState(false);
  const [plan, setPlan] = useState(false);
  const [pressed, setPressed] = useState(false);
  const base = 39;
  const extra = 4;
  const label = plan
    ? bump
      ? `Start the plan with Recipe cards: $${13 + extra} today`
      : "Start the plan: $13 today"
    : bump
      ? `Buy both for $${base + extra}`
      : `Buy for $${base}`;
  return (
    <Frame bar="At checkout">
      <form className="p-5" onSubmit={(e) => { e.preventDefault(); setPressed(true); }}>
        <p className="text-[15px] font-semibold text-ink">Five-week meal planner</p>
        <fieldset className="mt-4">
          <legend className="sr-only">How to pay</legend>
          <div className="space-y-2">
            {[
              { v: false, t: "Pay in full", p: `$${base}` },
              { v: true, t: "3 monthly payments of $13", p: "$13 today" },
            ].map((o) => (
              <label
                key={o.t}
                className={`flex cursor-pointer items-center justify-between gap-3 rounded-[var(--r-sm)] border px-3.5 py-3 ${
                  plan === o.v ? "border-violet-brand bg-lilac/60" : "border-line bg-white"
                }`}
              >
                <span className="flex items-center gap-3">
                  <input
                    type="radio"
                    name={`${id}-pay`}
                    checked={plan === o.v}
                    onChange={() => setPlan(o.v)}
                    className="h-4 w-4 accent-[var(--violet)]"
                  />
                  <span className="text-[13.5px] font-semibold text-ink">{o.t}</span>
                </span>
                <span className="text-[13px] font-semibold tabular-nums text-ink">{o.p}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-[var(--r-sm)] border border-dashed border-line-strong px-3.5 py-3">
          <input
            type="checkbox"
            checked={bump}
            onChange={(e) => setBump(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--violet)]"
          />
          <span>
            <span className="block text-[13.5px] font-semibold text-ink">{`Add Recipe cards for $${extra}`}</span>
            <span className="block text-[12px] text-ink-soft">The cards that go with it. $6 on their own.</span>
          </span>
        </label>
        <button type="submit" className="btn btn-primary btn-block mt-4" aria-live="polite">
          {label}
        </button>
        <p className="mt-3 text-center text-[12px] text-ink-soft">
          A preview to try: nothing is charged here. The box is never checked for the buyer.
        </p>
        <p role="status" className="mt-2 text-center text-[13px] font-semibold text-ink">
          {pressed ? demoPressedWords((plan ? 13 : base) + (bump ? extra : 0)) : ""}
        </p>
      </form>
    </Frame>
  );
}
