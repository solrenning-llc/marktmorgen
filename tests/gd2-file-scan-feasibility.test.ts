/** Preserve actual upload rights and the unresolved scanner cost; a study cannot become a clean-file receipt. */
import { readFileSync } from "node:fs";
import { MAX_FILE_BYTES } from "@/lib/product-file";
import { AUTOMATIC_UPLOAD_CAPS } from "@/lib/upload-budget-policy";
import { done, is, part } from "./check";

let study = "";
try { study = readFileSync("docs/gd2-file-scan-feasibility-2026-11-10.md", "utf8"); } catch { /* An absent study cannot pass. */ }
part("The feasibility table uses existing rights at full use, never an invented smaller file limit");
for (const tier of ["creator", "pro", "scale"] as const) {
  const cap = AUTOMATIC_UPLOAD_CAPS[tier];
  is(`${tier} rights and unknown cost match the actual policy`, study.includes(`| ${tier} | ${cap.opens} | ${cap.authorizedBytes} | ${MAX_FILE_BYTES} | desconhecido | desconhecido |`), true);
}
part("Scanner documentation does not prove coverage, capacity, a clean file, or funding");
for (const [name, required] of [
  ["dated review", "Conferência: 10/11/2026"],
  ["scanner source", "https://docs.clamav.net/manual/Usage/Scanning.html"],
  ["versioned limit evidence", "a configuração de exemplo registra a limitação técnica de 2 GB"],
  ["memory source", "https://docs.clamav.net/manual/Installing/Docker.html"],
  ["historical memory date", "20/09/2020"],
  ["not a memory ceiling", "não é teto de memória"],
  ["skipped is not clean", "Arquivo pulado não é arquivo verificado"],
  ["unknown remains unknown", "Erro, timeout, limite excedido ou base vencida é desconhecido"],
  ["full file right preserved", "Nenhum limite de arquivo ou plano foi reduzido"],
  ["annual allowances preserved", "12 janelas mensais"],
  ["monthly bound not storage multiplication", "não multiplicar o armazenamento por cada início de upload"],
  ["CPU unknown", "tempo máximo de CPU ainda não medido"],
  ["no free-tier funding", "cota grátis não é custo zero"],
  ["budget comes first", "teto e reserva antes do gasto"],
  ["shared company funding", "100% dos custos fixos pertencem ao Marktmorgen"],
  ["no public unproven feature", "Nenhuma verificação de vírus foi implementada ou ativada"],
  ["no real file execution", "Nenhum arquivo de cliente ou amostra de malware foi processado"],
  ["owner dependencies", "Depende do dono"],
  ["no sale opening", "PLANS_ON_SALE e OPENING_REQUESTED permanecem false"],
]) is(name, study.includes(required), true);
done();
