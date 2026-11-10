import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
const doc=readFileSync("docs/gd1-payment-monitoring-sources-2026-11-10.md","utf8");
part("The cited provider pages disagree about the ECP rate; retain that concrete gap before implementation");
// docs.stripe.com/disputes/monitoring-programs, ECM table: 1.5–2.99%.
// support.stripe.com/questions/monitoring-program-faq, ECP calculation: 1%.
// This checks the missing fact, not a preferred wording or a runtime threshold.
is("the study records the FAQ's one-percent ECP rate as well as the guide's ECM rate", /(?:^|[^0-9.,])1(?:[.,]0+)?\s*%/m.test(doc), true);
done();
