import { existsSync, readFileSync } from "node:fs";
import { done, is, part } from "./check";

const path = "docs/gd1-payment-monitoring-sources-2026-11-10.md";
const text = existsSync(path) ? readFileSync(path, "utf8") : "";
part("GD1(b): retain the source limitations before any monitoring automation");
for (const required of [
  "10/11/2026", "https://docs.stripe.com/disputes/monitoring-programs",
  "https://support.stripe.com/questions/monitoring-program-faq",
  "mês anterior", "30/90 dias", "TC40", "TC15", "disputas ocultas",
  "1.500", "1,5%", "CEMEA", "100–299", "300+", "exceeds",
  "não certifica", "custo desconhecido", "sem contato externo",
  "fontes das próprias bandeiras", "Nenhuma pausa ou liberação",
]) is(`source review preserves ${required}`, text.includes(required), true);
done();
