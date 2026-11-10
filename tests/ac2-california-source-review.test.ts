/** AC2(a): the dated source review must keep its legal and implementation limits explicit. */
import { existsSync, readFileSync } from "node:fs";
import { done, is, part } from "./check";

const path = "docs/ac2-california-digital-products-2026-11-10.md";
const text = existsSync(path) ? readFileSync(path, "utf8") : "";
part("A source observation cannot become an approved tax parameter");
for (const required of [
  "Conferido em 10/11/2026",
  "Vigência indicada: 01/01/2027",
  "Inteiro teor da SB 122: não lido",
  "Alíquota combinada máxima de 2027: desconhecida",
  "Enquadramento real do Marktmorgen: não confirmado",
  "Código, perfis e travas: inalterados",
  "US$ 500.000",
  "US$ 5.000.000",
  "https://cdtfa.ca.gov/formspubs/L1036.pdf",
  "https://cdtfa.ca.gov/industry/retailers-and-purchasers-of-digital-products/definitions.htm",
  "https://cdtfa.ca.gov/industry/retailers-and-purchasers-of-digital-products/retailers.htm",
  "https://cdtfa.ca.gov/lawguides/vol1/sutl/6203.html",
  "não conclui o item 437",
]) is(`review preserves: ${required}`, text.includes(required), true);
done();
