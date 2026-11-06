"use client";

import { useState } from "react";

import { StoreField } from "@/components/studio-store-pin";
import { accountingMonths } from "@/lib/accounting-export-rules";

/**
 * Sales of one month, or half of one, as a file Xero or QuickBooks imports
 * (queue item 37 [F6]; app/api/store/export, what=sales and format). A plain
 * GET form, like the other downloads beside it, so nothing prefetches a file
 * that reads Stripe. Shown only to a role that may take sales out.
 */
export function AccountingExportForm() {
  // The months as the browser first draws them; the server checks the one sent.
  const [months] = useState(() => accountingMonths(Date.now()));
  return (
    <form action="/api/store/export" method="get" className="mt-4 border-t border-line pt-4" aria-labelledby="accounting-export-title">
      <StoreField />
      <input type="hidden" name="what" value="sales" />
      <h3 id="accounting-export-title" className="text-sm font-bold text-ink">
        Sales for your accounting app
      </h3>
      <p id="accounting-export-help" className="mt-1 max-w-[80ch] text-xs text-ink-soft">
        A file to import into Xero (Sales, Invoices, Import) or QuickBooks Online (Settings, Import data, Invoices). Each day&apos;s
        sales are one invoice to &quot;Online customers&quot;, one line for each product, with the tax buyers paid in its own
        column, so choose &quot;tax exclusive&quot; when you import. Dates are month/day/year, in UTC, and today is added once it is
        over. Sales in another currency are invoices of their own, which your app takes only with more than one currency turned
        on. Refunds and Stripe fees are not sales, so they are not in it: they are in your Stripe reports.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <fieldset className="text-sm" aria-describedby="accounting-export-help">
          <legend className="field-label">App</legend>
          <div className="mt-1 flex gap-3">
            <label className="inline-flex min-h-11 items-center gap-2">
              <input type="radio" name="format" value="xero" defaultChecked />
              Xero
            </label>
            <label className="inline-flex min-h-11 items-center gap-2">
              <input type="radio" name="format" value="quickbooks" />
              QuickBooks
            </label>
          </div>
        </fieldset>
        <label className="text-sm">
          <span className="field-label">Month</span>
          <select name="month" defaultValue={months[0]?.value} className="field mt-1 w-auto py-2">
            {months.map((month, i) => (
              <option key={month.value} value={month.value}>
                {i === 0 ? `${month.label} (so far)` : month.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="field-label">Days</span>
          <select name="half" defaultValue="" className="field mt-1 w-auto py-2">
            <option value="">The whole month</option>
            <option value="1">The 1st to the 15th</option>
            <option value="2">The 16th to the end</option>
          </select>
        </label>
      </div>
      <details className="mt-3 text-sm">
        <summary className="inline-flex min-h-11 cursor-pointer items-center">More options (you can skip these)</summary>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="field-label">Sales account code (Xero only)</span>
            <input name="account" maxLength={10} placeholder="For example, 200" className="field mt-1 w-auto py-2" aria-describedby="accounting-account-help" />
            <span id="accounting-account-help" className="mt-1 block text-xs text-ink-soft">
              The code of your sales account in Xero. Empty: you choose it in Xero.
            </span>
          </label>
          <label className="text-sm">
            <span className="field-label">Tax rate</span>
            <input name="tax" maxLength={50} placeholder="For example, Tax Exempt" className="field mt-1 w-auto py-2" aria-describedby="accounting-tax-help" />
            <span id="accounting-tax-help" className="mt-1 block text-xs text-ink-soft">
              The tax rate&apos;s name exactly as your app shows it. Empty: you choose it in your app.
            </span>
          </label>
        </div>
      </details>
      <button type="submit" className="btn btn-secondary btn-sm mt-3">
        Download for my accounting app
      </button>
    </form>
  );
}
