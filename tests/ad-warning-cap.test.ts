import { type AdContext, type AdText, checkAdText } from "@/lib/ad-creative-check";
import { BLOCKING_KINDS, MAX_WARNINGS, checkCreatorTerms } from "@/lib/terms-check-rules";
import { done, is, part } from "./check";

const prefix = Array.from({ length: MAX_WARNINGS + 2 }, (_, i) => `https://site${i}.com`).join(". ") + ". ";
const context: AdContext = { priceCents: 2900, currency: "usd", ownHosts: [], realDeadline: false, realStockLimit: false, verifiedReviews: [] };
const ad = (field: keyof AdText, text: string): AdText => ({ headline: "Drawing guide", text: "Practice drawing.", description: "", button: "Learn more", [field]: text });
const cases = [
  ["Earn $5,000 a month.", "earnings_claim"],
  ["Limited time offer, act now.", "false_urgency"],
  ["Only 3 spots left.", "false_urgency"],
  ["Now only $9.", "price_mismatch"],
  ["Make easy money from home.", "fast_money"],
] as const;

part("Advisory warnings cannot hide any existing ad refusal");
for (const [claim, rule] of cases) {
  for (const field of ["headline", "text", "description", "button"] as const) {
    const plain = checkAdText(ad(field, claim), context);
    const crowded = checkAdText(ad(field, prefix + claim), context);
    is(`baseline refusal in ${field}: ${claim}`, plain.refusals.some(finding => finding.field === field && finding.rule === rule), true);
    is(`crowded ${field} remains refused: ${claim}`, crowded.sendable, false);
    is(`crowded ${field} retains the reason: ${claim}`, crowded.refusals.some(finding => finding.field === field && finding.rule === rule), true);
  }
}

part("Ordinary descriptions and real urgency retain their current treatment");
for (const text of ["Practice drawing every day.", "We do not promise any income.", "Join for $29."]) {
  is(`ordinary ad stays sendable: ${text}`, checkAdText(ad("text", prefix + text), context).sendable, true);
}
is("real deadline stays sendable", checkAdText(ad("text", prefix + "Limited time offer, act now."), { ...context, realDeadline: true }).sendable, true);
is("real stock stays sendable", checkAdText(ad("text", prefix + "Only 3 spots left."), { ...context, realStockLimit: true }).sendable, true);
is("product blocking kinds stay unchanged", [...BLOCKING_KINDS], ["fast_money"]);
const warnings = checkCreatorTerms({ text: prefix + "Earn $5,000 a month.", ownHosts: [], priceCents: 2900, currency: "usd", immediateAccessConsent: true, realDeadline: false, realStockLimit: false, resaleLicense: true });
is("ordinary terms still keep the existing cap", warnings.length, MAX_WARNINGS);

done();
