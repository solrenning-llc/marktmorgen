/**
 * The studio check-up is navigable by named regions. Each region's accessible
 * name includes both the part and its current state, so region navigation
 * does not hide whether it is a problem, fine, or could not be checked.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CheckupList } from "@/components/checkup-list";
import type { Check } from "@/lib/checkup-rules";
import { done, is, part } from "./check";

const checks: Check[] = [
  { id: "checkout", title: "Checkout", state: "problem", found: "Payments are refused." },
  { id: "email", title: "List email", state: "not-checked", found: "Email could not be checked." },
  { id: "stripe", title: "Stripe connection", state: "ok", found: "The connection is ready." },
];

part("Each check-up region is named by its title and written state");
const html = renderToStaticMarkup(
  createElement(CheckupList, { checks, checkedAt: Date.UTC(2026, 10, 6, 12), hrefOf: (href: string) => href }),
);
for (const check of checks) {
  is(
    `${check.title}: the section references title and state`,
    html.includes(`aria-labelledby="check-${check.id} check-${check.id}-state"`),
    true,
  );
  is(
    `${check.title}: the written state has the referenced id`,
    html.includes(`id="check-${check.id}-state"`),
    true,
  );
}
done();
