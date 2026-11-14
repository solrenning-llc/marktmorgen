/** FR1(a): source mapping cannot be mistaken for a complete return or an empty ledger. */
import { existsSync, readFileSync } from "node:fs";
import { done, is, part } from "./check";

const path = "docs/fr1-5472-record-sources-2026-11-10.md";
const text = existsSync(path) ? readFileSync(path, "utf8") : "";
part("The source map preserves the missing-record and filing boundaries");
for (const required of [
  "Conferido em 10/11/2026",
  "https://www.irs.gov/instructions/i5472",
  "12/2024",
  "transações reportáveis",
  "Part V",
  "pro forma",
  "não significa ausência de transações",
  "não produz nem transmite uma declaração",
  "Prazo concreto: pendente",
  "Dados reais da LLC: não lidos",
  "lib/tax-summary.ts",
  "lib/company-owner-report.ts",
  "lib/llc-fixed-costs.ts",
]) is(`mapping preserves: ${required}`, text.includes(required), true);
done();
