import { existsSync, readFileSync } from "node:fs";
import { done, is, part } from "./check";

const path = "docs/gd1-stripe-evidence-sources-2026-11-10.md";
const text = existsSync(path) ? readFileSync(path, "utf8") : "";
part("GD1(c): evidence source review keeps submission and history boundaries");
for (const required of [
  "10/11/2026", "https://docs.stripe.com/api/disputes/update",
  "https://docs.stripe.com/disputes/api", "https://docs.stripe.com/disputes/best-practices",
  "https://docs.stripe.com/connect/authentication", "access_activity_log",
  "receipt", "refund_policy_disclosure", "service_documentation", "uncategorized_text",
  "150.000", "submit=false", "submit=true", "dispute_evidence",
  "dispute_evidence_page_limit_exceeded", "Stripe-Account",
  "não prova aceite", "desconhecido", "custo desconhecido nunca é zero",
  "lib/dispute-purchase-review.ts", "Sem envio", "revisão pelo criador",
]) is(`evidence review retains ${required}`, text.includes(required), true);
done();
