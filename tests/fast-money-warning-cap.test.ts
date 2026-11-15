import { checkCreatorTerms, fastMoneyOnPage, fastMoneyRefusal, MAX_WARNINGS } from "@/lib/terms-check-rules";
import { done, is, part } from "./check";

const prefix = Array.from({ length: MAX_WARNINGS + 5 }, (_, i) => `https://outside${i}.com`).join(". ") + ". ";
const base = { ownHosts: [], priceCents: null, currency: "usd", immediateAccessConsent: true, realDeadline: true, realStockLimit: true, resaleLicense: true };
const claims = ["Make easy money from home.", "Earn quick cash today.", "Make money while you sleep.", "Income with little effort.", "Effortless income from day one."];

part("Advisory warnings cannot fill the publication decision's capacity");
for (const claim of claims) {
  const text = prefix + claim;
  const warnings = checkCreatorTerms({ ...base, text });
  is(`the output remains capped: ${claim}`, warnings.length, MAX_WARNINGS);
  const blocked = warnings.find(warning => warning.kind === "fast_money");
  is(`the blocking passage is retained: ${claim}`, Boolean(blocked), true);
  is(`the retained passage still points to the original text: ${claim}`, blocked ? text.slice(blocked.at, blocked.at + blocked.length) : null, claim.slice(0, -1).replace(/ from home$| today$| from day one$/, ""));
  for (const field of ["title", "summary", "about"] as const) {
    const product = { title: "Guide", summary: "", about: "", [field]: text };
    is(`a crowded ${field} cannot publish: ${claim}`, fastMoneyRefusal(product)?.field, field);
  }
  is(`the sales-page guard also refuses: ${claim}`, fastMoneyOnPage(["Ordinary words", text])?.field, "page");
}

part("A full warning list still distinguishes an ordinary topic from a promise");
for (const ending of ["No easy money here, just practice.", "Avoid get-rich-quick schemes.", "Easy money management for couples.", "Make money with your photos by learning to price them."]) {
  const text = prefix + ending;
  is(`no new block: ${ending}`, fastMoneyRefusal({ title: "Guide", summary: text, about: "" }), null);
  is(`the existing output bound is preserved: ${ending}`, checkCreatorTerms({ ...base, text }).length, MAX_WARNINGS);
}
done();
