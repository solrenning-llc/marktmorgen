/**
 * An email draft for one "Do this next" action, written with AI only when the creator asks (484 [IT1] complement
 * WG, unit 3; lib/next-action-draft.ts writes it, lib/next-actions-rules.ts chooses the actions). Pure and
 * browser-safe: the call's bounds, what it costs in the month's AI uses, the instructions, and the check every
 * draft passes before anyone sees it.
 *
 *   - Only for an action whose email the creator writes to people they already serve: the members whose latest
 *     payment failed (a note about their own membership). The members who left are not written to here: the
 *     come-back email, with its consent rules (lib/winback.ts), is what that action sets up.
 *   - Cost: one request of NEXT_DRAFT_CALL's bounds, weighed in the month's AI uses before it runs (jobsForCall, at
 *     the writing model's list price in lib/spend-cost-table.ts, read on the date that table names), and its dollar
 *     ceiling reserved before the fetch by lib/ai.ts (askModel, lib/ai-spend.ts). A request longer than its bound is
 *     refused before anything is counted; a price not known refuses (never zero).
 *   - Honest: the model gets the store's name and the creator's name, never a count, an amount or a person. The
 *     draft is refused when it holds a number that is not in those names, a percentage, a price, a link, "free",
 *     an offer, a promise of a result, or pressure.
 *   - Nothing is saved and nothing is sent: the draft comes back to the screen for the creator to change and send.
 */
import { type AiCallBound, jobsForCall } from "@/lib/funnel-ai-rules";
import type { NextActionId } from "@/lib/next-actions-rules";

/** The actions a draft can be written for. */
export const DRAFTABLE: readonly NextActionId[] = ["failed_payments"];

export function isDraftable(id: unknown): id is NextActionId {
  return typeof id === "string" && (DRAFTABLE as readonly string[]).includes(id);
}

/** The one request a draft makes, at the most. */
export const NEXT_DRAFT_CALL = { outputTokens: 700, inputBytes: 4_096 } as const satisfies AiCallBound;

/** How many of the month's AI uses one draft takes, said before it runs. */
export const NEXT_DRAFT_JOBS = jobsForCall(NEXT_DRAFT_CALL);

export const MAX_DRAFT_SUBJECT = 80;
export const MAX_DRAFT_BODY = 1_200;

/** What each draft is for, in the instructions. */
const PURPOSE: Record<string, string> = {
  failed_payments:
    "a short, kind note from the creator to one of their members whose latest membership payment did not go through. Say that the payment did not go through, that the card on file may need a look, and that they can reply to this email with any question. Do not blame the member. Do not threaten to end the membership and do not set a deadline.",
};

/** The instructions and the facts for one draft, or null when the action has none. */
export function draftRequest(id: NextActionId, facts: { storeName: string; creatorName: string; rules: string }): { system: string; prompt: string } | null {
  const purpose = PURPOSE[id];
  if (!purpose) return null;
  const system = [
    `You write ${purpose}`,
    facts.rules,
    "Write as the creator, in the first person, to one person.",
    "Use only the facts given. Do not write any number, amount, price, percentage, date, discount, offer, gift, link, web address, or promise of a result. Do not use the word free. No urgency and no pressure.",
    `Return only a JSON object: {"subject": string, "body": string}. The subject at most ${MAX_DRAFT_SUBJECT} characters. The body plain text, at most ${MAX_DRAFT_BODY} characters, paragraphs separated by one blank line, signed with the creator's name.`,
  ].join("\n\n");
  const prompt = [`Store: ${oneLine(facts.storeName, 80)}`, `Creator: ${oneLine(facts.creatorName, 80)}`].join("\n");
  return { system, prompt };
}

/** Whether instructions and facts fit the request's bound, counted in bytes before anything is counted. */
export function fitsDraftCall(request: { system: string; prompt: string }): boolean {
  const bytes = new TextEncoder();
  return bytes.encode(request.system).length + bytes.encode(request.prompt).length <= NEXT_DRAFT_CALL.inputBytes;
}

function oneLine(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** What a draft may not say. */
const REFUSED: readonly [RegExp, string][] = [
  [/%|\bper ?cent\b/i, "percentage"],
  [/[$€£¥₹]|\b(usd|eur|gbp|dollars?|euros?)\b/i, "price"],
  [/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co)\b/i, "link"],
  [/\bfree\b/i, "free"],
  [/\b(discount|coupon|deal|offer|sale|bonus|gift)\b/i, "offer"],
  [/\b(guarantee[sd]?|results?|earn|profit|double|triple)\b/i, "promise"],
  [/\b(urgent|hurry|act now|last chance|deadline|today only|right away|immediately|before it'?s too late|expires?)\b/i, "pressure"],
];

/**
 * The draft as it may be shown, or why not: its subject and body trimmed to their bounds, every number in it found
 * in the names it was given (so none is made up), and none of REFUSED.
 */
export function readDraft(raw: unknown, names: { storeName: string; creatorName: string }): { ok: true; subject: string; body: string } | { ok: false; why: string } {
  if (!raw || typeof raw !== "object") return { ok: false, why: "shape" };
  const { subject: s, body: b } = raw as Record<string, unknown>;
  const subject = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  const body = typeof b === "string" ? b.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
  if (!subject || !body || subject.length > MAX_DRAFT_SUBJECT || body.length > MAX_DRAFT_BODY) return { ok: false, why: "shape" };
  const text = `${subject}\n${body}`;
  const allowed = new Set((`${names.storeName} ${names.creatorName}`.match(/\d+/g) ?? []));
  if ((text.match(/\d+/g) ?? []).some((n) => !allowed.has(n))) return { ok: false, why: "number" };
  // A name may hold a refused word ("Free Spirit Yoga"): it is taken out before the words are checked.
  let words = text;
  for (const name of [names.storeName, names.creatorName]) if (name.trim()) words = words.split(name.trim()).join(" ");
  for (const [pattern, why] of REFUSED) if (pattern.test(words)) return { ok: false, why };
  return { ok: true, subject, body };
}
