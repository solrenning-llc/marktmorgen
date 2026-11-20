/**
 * AC (ii), the owner's decision DONO-20261120-0253-C4-5BC-MINUTOS (20/11/2026, 02h53 Fortaleza): no session waits
 * without a send minute. The rule sits in the AC section of AGENTS.md, keeps its four points, and leaves every check
 * of a push in force. Reads the file as it is; no network.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const agents = readFileSync("AGENTS.md", "utf8");
const start = agents.indexOf("\n## AC — ");
const end = start < 0 ? -1 : agents.indexOf("\n## ", start + 1);
const ac = start < 0 ? "" : agents.slice(start, end < 0 ? undefined : end);
const at = ac.indexOf("\n(ii) **Minutos de envio");
const rule = at < 0 ? "" : ac.slice(at, ac.indexOf("\n**Depende do dono**", at));

part("AC (ii): every session has a send minute");
is("the rule sits in the AC section, once", [at >= 0, (ac.match(/\n\(ii\) \*\*/g) ?? []).length], [true, 1]);
is("it names the owner's decision", rule.includes("DONO-20261120-0253-C4-5BC-MINUTOS"), true);
is("1: a fixed table in the queue panel, repeated in each new channel", rule.includes("PAINEL DA FILA") && rule.includes("primeiro comentário de cada canal novo"), true);
is("2: the family coordinator answers within 30 minutes", rule.includes("em até 30 minutos"), true);
is("3: silence never stops a session", rule.includes("Sem resposta em 30 minutos") && rule.includes("últimas 2 horas do canal"), true);
is("4: no session is left without a slot", rule.includes("nunca deixa uma sessão sem vaga"), true);
is("every push keeps its checks", rule.includes("(m)") && rule.includes("MV (a)") && rule.includes("CV"), true);

done();
