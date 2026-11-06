/** TX selector metadata only. Historical consultations never authorize a
 * reading or a sale. Actual approval requires explicit scoped annual books,
 * exchanges, FX and component evidence; absence is unknown, never zero.
 * Flags, reviews, reserves, rights and other opening gates remain unchanged.
 */
import { MOST_CORRECT_READING, type Reading } from "@/lib/receiving-costs";

/** Historical fact/configuration retained; EU hosting is not an opening condition. */
export const EU_HOSTING_CONFIRMED = false;
export type GateReadingId = "most-correct";
/** This selects metadata only. Complete scoped tax/FX evidence remains
 * mandatory in the customer assessor, contract and reviewed receiving model. */
export const GATE_READING_ID: GateReadingId = "most-correct";
export function gateProblems(id: GateReadingId, _historicalEuHostingConfirmed?: boolean): string[] {
  void _historicalEuHostingConfirmed;
  return id === "most-correct" ? [] : [`unknown gate reading ${String(id)}`];
}
export function gateReading(): Reading { return MOST_CORRECT_READING; }

/** The authorities whose answer can close a doubt (docs/tax-consultations.md). */
export const CONSULTATION_AUTHORITIES = ["Receita Federal", "Prefeitura de Fortaleza"] as const;
/** The highest question number in docs/tax-uncertainty.md. */
export const TAX_QUESTIONS = 27;

/**
 * A doubt closed by an answer to a consultation, recorded with its date and
 * source. Recording one means changing the reading it closes, then
 * recomputing; none is recorded yet. The same answer goes into Hazelsong's
 * CONSULTATION_ANSWERS: the consultations are the LLC's and the owner's.
 */
export type ConsultationAnswer = {
  /** The question of docs/tax-uncertainty.md it closes, 1 to TAX_QUESTIONS. */
  question: number;
  authority: (typeof CONSULTATION_AUTHORITIES)[number];
  /** The day of the answer, YYYY-MM-DD. */
  date: string;
  /** Its number or protocol and where it can be read. */
  source: string;
  /** The reading it closes, in words. */
  reading: string;
};
export const CONSULTATION_ANSWERS: readonly ConsultationAnswer[] = [];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
function calendarDay(value: unknown): boolean {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** What is wrong with the recorded answers: empty when every one is complete. */
export function consultationProblems(answers: readonly ConsultationAnswer[] = CONSULTATION_ANSWERS): string[] {
  const out: string[] = [];
  answers.forEach((answer, i) => {
    const at = `consultation answer ${i + 1}`;
    if (!Number.isInteger(answer?.question) || answer.question < 1 || answer.question > TAX_QUESTIONS) out.push(`${at}: question`);
    if (!(CONSULTATION_AUTHORITIES as readonly string[]).includes(answer?.authority)) out.push(`${at}: authority`);
    if (!calendarDay(answer?.date)) out.push(`${at}: date`);
    for (const key of ["source", "reading"] as const) if (typeof answer?.[key] !== "string" || !answer[key].trim()) out.push(`${at}: ${key}`);
  });
  return out;
}

/** Whether the gate's own setting is one sales may be judged on. Not permission to sell. */
export function taxGateValid(): boolean {
  return gateProblems(GATE_READING_ID).length === 0;
}
