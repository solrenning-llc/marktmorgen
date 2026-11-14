"use client";

import { useState } from "react";
import { PLAN_TITLES, monthlyEmails, publishedPriceWords, type Tier } from "@/lib/plan";
import { findPlanFit } from "@/lib/plan-fit-rules";

function numberWords(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * A browser-only, descriptive first slice of the public plan-fit calculator (266 [CI4]).
 * `domains` is the deployment's real custom-domain availability (isDomainsConfigured()):
 * without it the custom-domain choice is not offered, and an unknown answer counts as off.
 */
export function PlanFitCalculator({ domains = false }: { domains?: boolean }) {
  const [monthlyListEmails, setMonthlyListEmails] = useState("");
  const [needsListEmail, setNeedsListEmail] = useState(false);
  const [needsCustomDomain, setNeedsCustomDomain] = useState(false);
  const [needsBrandingRemoval, setNeedsBrandingRemoval] = useState(false);
  const result = findPlanFit({ monthlyListEmails, needsListEmail, needsCustomDomain: domains && needsCustomDomain, needsBrandingRemoval });

  let answer: React.ReactNode;
  if (result.kind === "incomplete") {
    answer = <>Enter a whole number of list emails per month to see which plan fits.</>;
  } else if (result.kind === "invalid") {
    answer = <>Enter a whole, non-negative number of list emails per month.</>;
  } else if (result.kind === "no-fit") {
    answer = <>No current plan covers {numberWords(result.monthlyListEmails)} list emails per month. Scale includes up to {numberWords(result.maximumMonthlyListEmails)}; see the published allowances below.</>;
  } else {
    const tier: Tier = result.tier;
    const emailAllowance = monthlyEmails(tier);
    answer = (
      <>
        <p className="font-semibold">{PLAN_TITLES[tier]} fits the needs selected here.</p>
        <p className="mt-2">
          Published price: {publishedPriceWords(tier, "month")} or {publishedPriceWords(tier, "year")}.
        </p>
        <p className="mt-2">
          {emailAllowance > 0
            ? `List email: up to ${numberWords(emailAllowance)} per month.`
            : "List email is not included in Store."}
        </p>
        <p className="mt-2">
          This check covers list email and the selected built-in Pro tools only. It does not check every allowance or feature.
        </p>
      </>
    );
  }

  return (
    <section id="plan-fit" aria-labelledby="plan-fit-heading" className="mt-20 max-w-3xl">
      <h2 id="plan-fit-heading" className="t-h2">Find a plan that fits</h2>
      <p className="mt-4 text-ink-soft">
        Check the list email allowance and the built-in Pro tools you need. This runs in your browser and does not create an account or change a plan.
        For other needs, compare the <a href="#selling-and-delivery" className="underline underline-offset-4">published allowances</a>.
      </p>

      <div className="mt-6 rounded-2xl border border-line bg-white p-6 sm:p-8">
        <label htmlFor="plan-fit-list-emails" className="block font-semibold">List emails you expect to send each month</label>
        <p id="plan-fit-list-emails-help" className="mt-2 text-sm text-ink-soft">
          Campaigns and sequences share this allowance. Enter 0 if you do not plan to send list email.
        </p>
        <input
          id="plan-fit-list-emails"
          name="monthlyListEmails"
          type="number"
          min="0"
          step="1"
          inputMode="numeric"
          value={monthlyListEmails}
          onChange={(event) => setMonthlyListEmails(event.currentTarget.value)}
          aria-describedby="plan-fit-list-emails-help"
          className="mt-3 block min-h-12 w-full max-w-sm rounded-xl border border-line-strong bg-white px-3 text-ink"
        />

        <fieldset className="mt-6">
          <legend className="font-semibold">Built-in tools you need</legend>
          <div className="mt-3 grid gap-3">
            <label className="flex min-h-11 items-center gap-3">
              <input type="checkbox" checked={needsListEmail} onChange={(event) => setNeedsListEmail(event.currentTarget.checked)} />
              <span>Send email to a list</span>
            </label>
            {domains ? (
              <label className="flex min-h-11 items-center gap-3">
                <input type="checkbox" checked={needsCustomDomain} onChange={(event) => setNeedsCustomDomain(event.currentTarget.checked)} />
                <span>Use a custom domain</span>
              </label>
            ) : null}
            <label className="flex min-h-11 items-center gap-3">
              <input type="checkbox" checked={needsBrandingRemoval} onChange={(event) => setNeedsBrandingRemoval(event.currentTarget.checked)} />
              <span>Remove Marktmorgen branding</span>
            </label>
          </div>
        </fieldset>

        <div role="status" aria-live="polite" aria-atomic="true" className="mt-6 rounded-xl bg-paper p-4">
          {answer}
        </div>
      </div>
    </section>
  );
}
