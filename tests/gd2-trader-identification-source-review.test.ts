/** Internal study boundaries: a source review never turns into permission to collect identity documents. */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

let study = "";
try { study = readFileSync("docs/gd2-trader-identification-source-review-2026-11-10.md", "utf8"); } catch { /* An absent review fails each requirement. */ }
part("Official rules, scope and implementation gaps stay separate");
for (const [name, text] of [
  ["dated review", "Conferência: 10/11/2026"],
  ["statute", "https://uscode.house.gov/us/usc/119-120/t15/s45f/"],
  ["FTC", "https://www.ftc.gov/business-guidance/resources/INFORMAct"],
  ["EU regulation", "https://eur-lex.europa.eu/eli/reg/2022/2065/oj/eng"],
  ["physical scope", "bens tangíveis"],
  ["combined thresholds", "200 transações E US$ 5.000"],
  ["rolling window", "12 meses contínuos nos 24 meses anteriores"],
  ["distinct disclosure", "US$ 20.000"],
  ["microenterprise scope", "art. 29"],
  ["traceability", "art. 30"],
  ["size not assumed", "porte real não foi comprovado"],
  ["no blanket Stripe verification", "ativação da Stripe não comprova"],
  ["pending provider access", "acesso aos campos exigidos não foi comprovado"],
  ["no live collection", "Nenhuma coleta ou divulgação foi implementada"],
  ["owner dependencies", "Depende do dono"],
  ["no legal advice request", "Nenhuma consulta será feita ou preparada para envio"],
  ["unknown cost", "custo desconhecido nunca é zero"],
  ["no opening change", "PLANS_ON_SALE e OPENING_REQUESTED permanecem false"],
  ["no law certification from test", "O teste conserva estas ressalvas; não certifica a lei"],
]) is(name, study.includes(text), true);
done();
