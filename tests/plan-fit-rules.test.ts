import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanFitCalculator } from "@/components/plan-fit-calculator";
import { PLAN_FIT_ALLOWANCES_GROUP, findPlanFit } from "@/lib/plan-fit-rules";
import { PLAN_TITLES } from "@/lib/plan";
import { PRICING_GROUPS } from "@/lib/pricing-page-data";
import { done, is, part } from "./check";

const empty = {
  monthlyListEmails: "",
  needsListEmail: false,
  needsCustomDomain: false,
  needsBrandingRemoval: false,
};

part("The input must be known before a recommendation");
is("blank input does not become zero", findPlanFit(empty).kind, "incomplete");
is("a decimal is rejected", findPlanFit({ ...empty, monthlyListEmails: "2.5" }).kind, "invalid");
is("scientific notation is rejected", findPlanFit({ ...empty, monthlyListEmails: "1e3" }).kind, "invalid");
is("negative input is rejected", findPlanFit({ ...empty, monthlyListEmails: "-1" }).kind, "invalid");
is("an unsafe integer is rejected", findPlanFit({ ...empty, monthlyListEmails: "9007199254740992" }).kind, "invalid");
is("an unknown feature answer fails closed", findPlanFit({ ...empty, monthlyListEmails: "0", needsCustomDomain: undefined as unknown as boolean }).kind, "invalid");

part("Recommend the lowest plan that meets the selected needs");
is("zero emails with no Pro tool fits Store", findPlanFit({ ...empty, monthlyListEmails: "0" }), { kind: "fit", tier: "creator", monthlyListEmails: 0 });
is("any positive list email volume requires email", findPlanFit({ ...empty, monthlyListEmails: "1" }), { kind: "fit", tier: "pro", monthlyListEmails: 1 });
is("the Studio email boundary fits exactly", findPlanFit({ ...empty, monthlyListEmails: "7000" }), { kind: "fit", tier: "pro", monthlyListEmails: 7000 });
is("one above the Studio boundary fits Scale", findPlanFit({ ...empty, monthlyListEmails: "7001" }), { kind: "fit", tier: "scale", monthlyListEmails: 7001 });
is("the Scale email boundary fits exactly", findPlanFit({ ...empty, monthlyListEmails: "10000" }), { kind: "fit", tier: "scale", monthlyListEmails: 10000 });
is("above the Scale boundary has no recommendation", findPlanFit({ ...empty, monthlyListEmails: "10001" }), { kind: "no-fit", monthlyListEmails: 10001, maximumMonthlyListEmails: 10000 });
is("a custom domain requires the first Pro plan", findPlanFit({ ...empty, monthlyListEmails: "0", needsCustomDomain: true }), { kind: "fit", tier: "pro", monthlyListEmails: 0 });
is("branding removal requires the first Pro plan", findPlanFit({ ...empty, monthlyListEmails: "0", needsBrandingRemoval: true }), { kind: "fit", tier: "pro", monthlyListEmails: 0 });
is("the explicit email tool requires a Pro plan at zero volume", findPlanFit({ ...empty, monthlyListEmails: "0", needsListEmail: true }), { kind: "fit", tier: "pro", monthlyListEmails: 0 });

part("The interactive page names its controls and announces results");
const html = renderToStaticMarkup(createElement(PlanFitCalculator));
is("the number input has an associated label", /<label[^>]*for="plan-fit-list-emails"[^>]*>List emails/.test(html) && /<input[^>]*id="plan-fit-list-emails"/.test(html), true);
is("the tools are grouped under a legend", /<fieldset[^>]*>[\s\S]*<legend[^>]*>Built-in tools you need<\/legend>/.test(html), true);
is("changes are announced through a status region", /<div[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/.test(html), true);
// Codex X6's LOW on #3662 (6990726181): the link went to "Selling and delivery", while the list-email allowance it measures
// is listed under "Email, AI and workflows". Held to the pricing table itself, so a regrouping fails here.
const listEmailGroup = PRICING_GROUPS.find((group) => group.rows.some((row) => row.key === "list-email"))?.id;
is("the list-email allowance is in one published pricing group", typeof listEmailGroup, "string");
is("the calculator's allowance link names that group", PLAN_FIT_ALLOWANCES_GROUP, listEmailGroup);
is("the published allowance comparison links to that group", html.includes(`href="#${listEmailGroup}"`), true);

part("A custom domain is offered only where this deployment can connect one");
const withoutDomains = renderToStaticMarkup(createElement(PlanFitCalculator, { domains: false }));
const withDomains = renderToStaticMarkup(createElement(PlanFitCalculator, { domains: true }));
is("without domain support the calculator never offers a custom domain", withoutDomains.includes("Use a custom domain"), false);
is("by default (unknown) the custom domain is not offered", html.includes("Use a custom domain"), false);
is("with domain support the custom domain choice is shown", withDomains.includes("Use a custom domain"), true);
is("the other two tools stay offered without domain support", withoutDomains.includes("Send email to a list") && withoutDomains.includes("Remove Marktmorgen branding"), true);
// Codex X6's LOW on #3662 (6990726181): "Scale" and "Store" were literals in the calculator's copy. Every plan name it
// shows comes from PLAN_TITLES, so a renamed plan cannot leave the calculator saying the old name.
const calculatorSource = readFileSync("components/plan-fit-calculator.tsx", "utf8");
is("the calculator writes no plan title by hand", Object.values(PLAN_TITLES).filter((title) => new RegExp(`\\b${title}\\b`).test(calculatorSource)), []);

const page = readFileSync("app/pricing/page.tsx", "utf8");
is("the pricing page passes its real domain availability", /<PlanFitCalculator\s+domains=\{DOMAINS\}\s*\/>/.test(page), true);

done();
