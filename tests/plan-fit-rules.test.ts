import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanFitCalculator } from "@/components/plan-fit-calculator";
import { findPlanFit } from "@/lib/plan-fit-rules";
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
is("the published allowance comparison remains linked", /href="#selling-and-delivery"/.test(html), true);

part("A custom domain is offered only where this deployment can connect one");
const withoutDomains = renderToStaticMarkup(createElement(PlanFitCalculator, { domains: false }));
const withDomains = renderToStaticMarkup(createElement(PlanFitCalculator, { domains: true }));
is("without domain support the calculator never offers a custom domain", withoutDomains.includes("Use a custom domain"), false);
is("by default (unknown) the custom domain is not offered", html.includes("Use a custom domain"), false);
is("with domain support the custom domain choice is shown", withDomains.includes("Use a custom domain"), true);
is("the other two tools stay offered without domain support", withoutDomains.includes("Send email to a list") && withoutDomains.includes("Remove Marktmorgen branding"), true);
const page = readFileSync("app/pricing/page.tsx", "utf8");
is("the pricing page passes its real domain availability", /<PlanFitCalculator\s+domains=\{DOMAINS\}\s*\/>/.test(page), true);

done();
