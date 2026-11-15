/** A public feed is not permission, a funded integration, or proof that an unlisted URL is safe. */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

let study = "";
try { study = readFileSync("docs/gd2-malicious-url-lists-2026-11-10.md", "utf8"); } catch { /* Missing study must fail. */ }
part("The requested source study preserves commercial, privacy and admission limits");
for (const [name, text] of [
  ["dated evidence", "Conferência: 10/11/2026"],
  ["Google primary source", "https://developers.google.com/safe-browsing/reference/Appropriate.Usage"],
  ["noncommercial scope", "Safe Browsing não é opção gratuita para uso comercial"],
  ["URLhaus primary source", "https://urlhaus.abuse.ch/api/"],
  ["fair use source", "https://abuse.ch/terms-of-use/"],
  ["authentication not optional", "Auth-Key obrigatório"],
  ["commercial cost unresolved", "gratuidade comercial do URLhaus não comprovada"],
  ["PhishTank primary source", "https://phishtank.org/developer_info.php"],
  ["current terms distinct from archive", "termos antigos estão identificados como arquivados"],
  ["current terms pointer", "https://phishtank.org/terms.php"],
  ["Cisco scope unresolved", "enquadramento nos termos atuais da Cisco não concluído"],
  ["no provider dispatch", "Nenhuma URL de cliente foi enviada"],
  ["no threat-list download", "Nenhum feed ou arquivo de ameaças foi baixado"],
  ["negative result is limited", "Ausência na lista não prova segurança"],
  ["unknown remains unknown", "Falha de consulta ou lista vencida é desconhecido"],
  ["cost bound precedes expense", "teto e reserva antes do gasto"],
  ["free allowance is not a cost proof", "cota grátis não entra como custo zero"],
  ["owner dependencies", "Depende do dono"],
  ["feature not implemented", "Nenhuma integração foi implementada ou ativada"],
  ["no opening", "PLANS_ON_SALE e OPENING_REQUESTED permanecem false"],
]) is(name, study.includes(text), true);
done();
