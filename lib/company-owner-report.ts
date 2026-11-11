/** Pure, private MR2 presentation boundary. This module never collects a source. */
export const OWNER_REPORT_MAX_CHARACTERS = 65_536;
/** A cache observation is not a live provider check. Older snapshots are unknown. */
export const OWNER_REPORT_FRESH_MS = 3_600_000;

const IDS = ["closedData", "storeForget", "keptStar", "settlementEvidence", "sesPause", "manualLook"] as const;
type SectionId = typeof IDS[number];
export type OwnerReportSection = Readonly<{
  id: SectionId;
  title: string;
  status: "observed" | "unknown";
  observedAtMs: number | null;
  counts: Readonly<Record<string, number>>;
  feeIds: Readonly<Record<string, readonly string[]>>;
  lines: readonly string[];
}>;
export type CompanyOwnerReport = Readonly<{
  schema: 1;
  month: string | null;
  sections: readonly OwnerReportSection[];
}>;

const TITLES: Record<SectionId, string> = {
  closedData: "Dados de lojas fechadas",
  storeForget: "Apagamento de webhooks e chaves",
  keptStar: "Sessões travadas mantidas",
  settlementEvidence: "Evidência da devolução de comissões",
  sesPause: "Estado observado da Amazon SES",
  manualLook: "Lojas que precisam de revisão manual",
};
type Data = Record<string, unknown>;
const object = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const clock = (value: unknown): value is number => count(value) && value <= 8_640_000_000_000_000;
function hasDuplicateObjectMembers(serialized: string): boolean {
  const stack: Array<Set<string> | null> = [];
  for (let index = 0; index < serialized.length; index += 1) {
    const character = serialized[index];
    if (character === "{") { stack.push(new Set()); continue; }
    if (character === "[") { stack.push(null); continue; }
    if (character === "}" || character === "]") {
      const context = stack.pop();
      if (context === undefined || (character === "}" ? context === null : context !== null)) return true;
      continue;
    }
    if (character !== '"') continue;
    const start = index;
    let escaped = false;
    for (index += 1; index < serialized.length; index += 1) {
      const current = serialized[index];
      if (escaped) { escaped = false; continue; }
      if (current === "\\") { escaped = true; continue; }
      if (current === '"') break;
    }
    if (index >= serialized.length) return true;
    let after = index + 1;
    while (/\s/.test(serialized[after] ?? "")) after += 1;
    const context = stack.at(-1);
    if (serialized[after] !== ":" || !(context instanceof Set)) continue;
    let key: unknown;
    try { key = JSON.parse(serialized.slice(start, index + 1)); } catch { return true; }
    if (typeof key !== "string" || context.has(key)) return true;
    context.add(key);
  }
  return stack.length !== 0;
}
function exact(row: Data, fields: readonly string[]): boolean {
  return Object.keys(row).length === fields.length && fields.every(key => Object.hasOwn(row, key));
}
function fresh(row: Data, now: number): boolean {
  return Object.hasOwn(row, "observedAtMs") && clock(row.observedAtMs) && row.observedAtMs <= now && now - row.observedAtMs <= OWNER_REPORT_FRESH_MS;
}
function numbers(row: Data, fields: readonly string[]): Record<string, number> | null {
  const result: Record<string, number> = {};
  for (const key of fields) {
    if (!Object.hasOwn(row, key) || !count(row[key])) return null;
    result[key] = row[key];
  }
  return result;
}
function unknown(id: SectionId): OwnerReportSection {
  return Object.freeze({ id, title: TITLES[id], status: "unknown", observedAtMs: null,
    counts: Object.freeze({}), feeIds: Object.freeze({}),
    lines: Object.freeze([`${TITLES[id]}: estado desconhecido; não significa zero.`]),
  });
}
function observed(id: SectionId, at: number, counts: Record<string, number>, lines: string[], feeIds: Record<string, readonly string[]> = {}): OwnerReportSection {
  return Object.freeze({ id, title: TITLES[id], status: "observed", observedAtMs: at,
    counts: Object.freeze(counts), feeIds: Object.freeze(feeIds), lines: Object.freeze(lines),
  });
}
function feeList(value: unknown, failures: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 1_000 || value.length > failures) return null;
  if ((failures === 0) !== (value.length === 0)) return null;
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || !/^fee_[A-Za-z0-9]{1,96}$/.test(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return Object.freeze([...seen]);
}

function section(id: SectionId, value: unknown, month: string, now: number): OwnerReportSection {
  if (!object(value) || !fresh(value, now)) return unknown(id);
  const at = value.observedAtMs as number;
  if (id === "closedData") {
    const fields = ["parked", "stopped", "left", "stuck", "unread", "unreadKept", "owedKept", "scansStuck"];
    const n = numbers(value, fields);
    if (!exact(value, ["observedAtMs", ...fields]) || !n || n.stuck > n.left || n.unreadKept > n.unread) return unknown(id);
    return observed(id, at, n, [
      `Agora: ${n.parked} lojas em nova tentativa; ${n.stopped} sem novas tentativas; ${n.left} com caminhada incompleta; ${n.stuck} delas travadas.`,
      `Listas ilegíveis: ${n.unread}; sem novas tentativas: ${n.unreadKept}; membros ainda devidos nessas listas: ${n.owedKept}.`,
      `Leituras de assinaturas travadas: ${n.scansStuck}. Estes grupos são contados separadamente.`,
    ]);
  }
  if (id === "storeForget") {
    const fields = ["queued", "done", "gaveUp", "waitingNow", "keptNow"];
    const n = numbers(value, fields);
    if (!exact(value, ["observedAtMs", "month", ...fields]) || value.month !== month || !n) return unknown(id);
    return observed(id, at, n, [
      `Em ${month}: ${n.queued} entradas para nova tentativa; ${n.done} concluídas; ${n.gaveUp} com tentativas esgotadas.`,
      `Agora: ${n.waitingNow} aguardando; ${n.keptNow} com dados ainda guardados. A fila cobre webhooks e revogação de chaves; não mede cada serviço separadamente.`,
    ]);
  }
  if (id === "keptStar") {
    const n = numbers(value, ["times"]);
    if (!exact(value, ["observedAtMs", "month", "times"]) || value.month !== month || !n) return unknown(id);
    return observed(id, at, n, [`Em ${month}: ${n.times} observações de lista de sessões travadas acima do teto. Não é uma contagem de contas nem de incidentes únicos.`]);
  }
  if (id === "settlementEvidence") {
    const fields = ["unknownDisputes", "unknownAmounts", "listUnknown"];
    const n = numbers(value, fields);
    if (!exact(value, ["observedAtMs", "scope", "complete", ...fields, "unknownDisputeFees", "unknownAmountFees"]) || value.scope !== "run" || typeof value.complete !== "boolean" || !n) return unknown(id);
    const disputes = feeList(value.unknownDisputeFees, n.unknownDisputes);
    const amounts = feeList(value.unknownAmountFees, n.unknownAmounts);
    if (!disputes || !amounts) return unknown(id);
    return observed(id, at, n, [
      `Nesta execução: ${n.unknownDisputes} contestações desconhecidas; ${n.unknownAmounts} valores desconhecidos; ${n.listUnknown} leituras de lista desconhecidas.`,
      `Taxas com contestação desconhecida: ${disputes.join(", ") || "nenhuma observada nesta execução"}.`,
      `Taxas com valor desconhecido: ${amounts.join(", ") || "nenhuma observada nesta execução"}.`,
      `Execução ${value.complete ? "com leitura declarada completa" : "incompleta"}; total mensal desconhecido. Os números não autorizam uma devolução.`,
    ], { unknownDisputeFees: disputes, unknownAmountFees: amounts });
  }
  if (id === "sesPause") {
    if (!exact(value, ["status", "observedAtMs", "holdUntilMs"]) || !["ready", "paused"].includes(value.status as string)) return unknown(id);
    if (value.holdUntilMs !== null && !clock(value.holdUntilMs)) return unknown(id);
    if (value.status === "ready" && value.holdUntilMs !== null && value.holdUntilMs > now) return unknown(id);
    return observed(id, at, {}, [
      value.status === "paused" ? "Estado observado: em pausa." : "Estado observado: pronta no snapshot; não é uma consulta atual ao provedor.",
      value.holdUntilMs === null ? "Prazo da pausa desconhecido." : `Prazo registrado: ${new Date(value.holdUntilMs).toISOString()}. A data não confirma retomada.`,
      "Quantidade de mensagens pendentes e de incidentes: desconhecido.",
    ]);
  }
  const n = numbers(value, ["stopped", "stuck"]);
  if (!exact(value, ["observedAtMs", "minimumWeeks", "stopped", "stuck"]) || value.minimumWeeks !== 12 || !n) return unknown(id);
  return observed(id, at, n, [`Com pelo menos 12 semanas: ${n.stopped} lojas sem novas tentativas (stopped); ${n.stuck} lojas travadas (stuck). Precisam de revisão manual; os grupos não são somados.`]);
}

/**
 * Only serialized source snapshots enter this boundary: no supplied object,
 * getter, Proxy, serializer or provider callback is inspected or executed.
 * A valid shape proves only presentation consistency, not source authenticity.
 */
export function companyOwnerReport(serialized: string | null, requestedMonth: string, now = Date.now()): CompanyOwnerReport {
  const month = typeof requestedMonth === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth) ? requestedMonth : null;
  let root: Data = {};
  if (clock(now) && month !== null && typeof serialized === "string" && serialized.length <= OWNER_REPORT_MAX_CHARACTERS) {
    try {
      if (hasDuplicateObjectMembers(serialized)) throw new Error("Ambiguous owner-report snapshot");
      const parsed: unknown = JSON.parse(serialized);
      if (object(parsed) && Object.keys(parsed).every(key => IDS.includes(key as SectionId))) root = parsed;
    } catch { /* An absent or malformed snapshot remains unknown. */ }
  }
  return Object.freeze({ schema: 1, month,
    sections: Object.freeze(IDS.map(id => month === null || !Object.hasOwn(root, id) ? unknown(id) : section(id, root[id], month, now))),
  });
}
