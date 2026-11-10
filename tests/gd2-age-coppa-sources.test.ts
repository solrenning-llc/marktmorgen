/** GD2(i): documentary scope must preserve the current eligibility policy and must not claim an age checkbox certifies COPPA. */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
let study = "";
try { study = readFileSync("docs/gd2-age-coppa-sources-2026-11-10.md", "utf8"); } catch { /* A missing study cannot pass. */ }
const terms = readFileSync("app/terms/page.tsx", "utf8");
const privacy = readFileSync("app/privacy/page.tsx", "utf8");
part("Existing eligibility is a repository fact, not a worldwide legal conclusion");
is("current terms still require eighteen or higher local majority", terms.includes("You must be at least 18 years old, or the age of majority in your") && terms.includes("jurisdiction if that is higher"), true);
is("privacy still states the existing under-eighteen policy", privacy.includes("The Services are not directed to children under 18."), true);
for (const [label, required] of [
  ["dated review", "Conferência: 10/11/2026"],
  ["current policy preserved", "18 anos ou maioridade local mais alta"],
  ["not a universal contracting age", "não define uma idade universal de contratação"],
  ["current rule source", "https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312"],
  ["exact rule sections", "§§ 312.2–312.5"],
  ["official rule amendment", "https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule"],
  ["effective date", "23/06/2025"],
  ["compliance date", "22/04/2026"],
  ["transition exceptions", "312.11(d)(1), (d)(4) e (g)"],
  ["guidance is qualified", "orientação da equipe, não vinculante"],
  ["recent statement is qualified", "não é dispensa geral"],
  ["no self-attestation certification", "caixa de confirmação não é consentimento parental verificável"],
  ["no implemented checkbox", "Nenhuma caixa de idade foi implementada"],
  ["no new child information", "Nenhuma data de nascimento, documento, biometria ou dado de criança foi coletado"],
  ["unknown costs", "Custo futuro desconhecido nunca é zero"],
  ["funding before collection", "teto e reserva antes do gasto"],
  ["owner dependencies", "Depende do dono"],
  ["no legal gate changes", "CURRENT_COMMERCIAL_TERMS"],
  ["no opening", "PLANS_ON_SALE e OPENING_REQUESTED permanecem false"],
  ["not full age-law review", "leis de capacidade e regras de outras jurisdições continuam pendentes"],
]) is(label, study.includes(required), true);
done();
