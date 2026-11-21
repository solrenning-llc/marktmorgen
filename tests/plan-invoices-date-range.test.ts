/**
 * Codex X5 on claude7/i4734-plan-invoices (LEVE): an invoice's `created` that is a safe integer but outside the range
 * a Date can hold was accepted, and the studio's invoice history showed "Invalid Date (UTC)" beside the amount. A date
 * the runtime cannot represent is an unreadable row, under the existing partial-read notice; every readable invoice
 * still shows. Synthetic invoices only, no Stripe call.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readPlanInvoicePage } from "@/lib/plan-invoices";
import { PlanInvoicesList } from "@/components/plan-invoices-list";

const owner = { customer: "cus_DateRange01", subscription: "sub_DateRange01" };
const invoice = (created: number, id = "in_DateRange01") => ({
  id, object: "invoice", status: "paid", number: "Date-1", created, total: 6900, amount_paid: 6900, amount_remaining: 0,
  currency: "usd", customer: owner.customer, parent: { subscription_details: { subscription: owner.subscription } },
});
const read = (...data: ReturnType<typeof invoice>[]) => readPlanInvoicePage({ object: "list", data, has_more: false }, owner);

for (const created of [Number.MAX_SAFE_INTEGER, 8_640_000_000_001]) {
  test(`an integer second outside the Date range is unreadable: ${created}`, () => {
    const page = read(invoice(created));
    assert.deepEqual([page.invoices.length, page.unreadable], [0, 1]);
  });
}

test("a date outside the range never hides a good invoice", () => {
  const page = read(invoice(Number.MAX_SAFE_INTEGER), invoice(1_795_000_000, "in_DateRange02"));
  assert.deepEqual([page.invoices.map((x) => x.id), page.unreadable], [["in_DateRange02"], 1]);
});

test("the studio says a row could not be read instead of showing Invalid Date", () => {
  const page = read(invoice(Number.MAX_SAFE_INTEGER));
  const html = renderToStaticMarkup(createElement(PlanInvoicesList, { read: { state: "listed", ...page } }));
  assert.doesNotMatch(html, /Invalid Date/);
  assert.match(html, /could not be read/);
});

test("ordinary invoice dates keep their exact seconds", () => {
  const page = read(invoice(1_795_000_000));
  assert.deepEqual([page.invoices[0]?.created, page.unreadable], [1_795_000_000, 0]);
});

test("the last representable Date is still accepted", () => {
  const page = read(invoice(8_640_000_000_000));
  assert.deepEqual([page.invoices[0]?.created, page.unreadable], [8_640_000_000_000, 0]);
});
