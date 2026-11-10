/**
 * "Ask us to look again": the rules of a creator's request that Marktmorgen look again at a decision that took
 * content down or switched a store off (646 [WG6], unit 1, 10 November 2026).
 *
 * The decisions are the ones lib/takedown.ts makes after a notice: a link removed, a product or the media kit
 * unpublished, a store's pages and sales switched off. Each already sends the creator a statement of reasons (EU
 * Digital Services Act Art. 17, held by tests/eu-dsa-statement.test.ts). This file holds what a request against such
 * a decision may say, how long it can be sent, which states it goes through and who may move it, and the words the
 * studio and the emails will use. The reading is in docs/wg6-dsa-appeal-reading-2026-11-10.md.
 *
 * Built the way DSA Art. 20 shapes an internal complaint-handling system, although Art. 19(1) excludes micro and
 * small enterprises from it (a courtesy until the size trigger of docs/eu-dsa-readiness-2026-11-06.md is reached):
 *   - at least six months from the day the creator was told (Art. 20(1)-(2)); here the request stays open to the end
 *     of the day six calendar months later, in every time zone, rolled forward when that day does not exist;
 *   - free and electronic (Art. 20(1)); nothing here charges or counts anything;
 *   - only a person at Marktmorgen decides it, never an automatic step (Art. 20(6)), and a decision carries its
 *     reason (Art. 20(5));
 *   - the words never promise a result.
 *
 * Browser-safe and pure: no IO, no clock (the caller passes `now`), no randomness (the caller passes the bytes).
 * Nothing here is wired to a route, a page, a store record or an email yet: VR state "testado num PR", not available.
 */

export const APPEAL_STATES = ["received", "under_review", "upheld", "reversed"] as const;
export type AppealState = (typeof APPEAL_STATES)[number];

/** The state's name, as the studio and the emails show it (646 [WG6] names these four). */
export const APPEAL_STATE_WORDS: Record<AppealState, string> = {
  received: "Received",
  under_review: "Under review",
  upheld: "Upheld",
  reversed: "Reversed",
};

/** What each state means, in plain words, next to its name: "Upheld" is not an everyday word (AX274, 3.1.3). */
export const APPEAL_STATE_MEANING: Record<AppealState, string> = {
  received: "We have your request. A person at Marktmorgen will look at it.",
  under_review: "A person at Marktmorgen is looking at your request.",
  upheld: "We looked again and kept our decision.",
  reversed: "We looked again and changed our decision.",
};

const FINAL: ReadonlySet<AppealState> = new Set(["upheld", "reversed"]);
export const isFinal = (state: AppealState) => FINAL.has(state);

/** The moves a request can make. Nothing moves back, and a final state never moves again. */
const NEXT: Record<AppealState, readonly AppealState[]> = {
  received: ["under_review", "upheld", "reversed"],
  under_review: ["upheld", "reversed"],
  upheld: [],
  reversed: [],
};

export const DECISION_KINDS = ["link", "product", "kit", "store"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** One decision a creator can ask us to look at again: one takedown of lib/takedown.ts, as the creator was told it. */
export type Decision = {
  /** The notice it answered (Report.id in lib/takedown.ts). */
  report: string;
  kind: DecisionKind;
  /** The link's or product's id; "" for the media kit and for the whole store. */
  id: string;
  /** When the creator was told, as an ISO time: the six months start that day (DSA Art. 20(2)). */
  informedAt: string;
  /** What was taken down, in the words the creator was emailed. */
  what: string;
  /** Whether an automatic step took the decision. lib/takedown.ts has none today: a person presses each button. */
  automated: boolean;
};

/** One key per decision, so each decision takes one request. */
export const decisionKey = (d: Pick<Decision, "report" | "kind" | "id">) => `${d.kind}-${d.id}@${d.report}`;

/**
 * Whether changing the decision can give back exactly what was taken down. A link and its file are deleted by
 * lib/takedown.ts (`apply`, "for good"), so there is nothing to put back; a product, the media kit and a store are only
 * switched off, so they can be. The words below say which, so a request is never answered with a promise the code
 * cannot keep.
 */
export const restorable = (kind: DecisionKind) => kind !== "link";

/** At least six months (DSA Art. 20(1)). */
export const APPEAL_WINDOW_MONTHS = 6;
/** The last time zone to end a day is UTC-12: a date shown to the creator holds wherever they are. */
const LATEST_ZONE_MS = 12 * 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The last moment a request is taken: the end of the day six calendar months after the creator was told, in every
 * time zone. A day that month does not have (31 August + 6 months) rolls to the 1st of the next month, never back,
 * so the period is never shorter than six months. Null when `informedAt` is not a time: the request is then taken
 * (never "too late" on a date nobody can read), and no end date is shown.
 */
export function appealDeadline(informedAt: string): { last: Date; shown: Date } | null {
  if (typeof informedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(informedAt)) return null;
  const from = new Date(informedAt);
  if (Number.isNaN(from.getTime())) return null;
  const month = from.getUTCMonth() + APPEAL_WINDOW_MONTHS;
  const first = new Date(Date.UTC(from.getUTCFullYear(), month, 1));
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const day = from.getUTCDate();
  const shown = day <= days
    ? new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), day))
    : new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
  return { shown, last: new Date(shown.getTime() + DAY_MS - 1 + LATEST_ZONE_MS) };
}

/** A date as the site writes it (US English, the calendar day of `shown`). */
export const appealDate = (date: Date) =>
  date.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });

export const MAX_APPEAL_TEXT = 3_000;
export const MAX_APPEAL_REASON = 1_000;
export const MAX_APPEAL_ATTACHMENTS = 3;
export const MAX_APPEAL_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_APPEAL_ATTACHMENT_NAME = 120;
export const APPEAL_ATTACHMENT_TYPES = ["application/pdf", "image/png", "image/jpeg", "text/plain"] as const;
/** Emails one request can cause: received, under review, and the final answer. */
export const APPEAL_EMAILS = 3;
/** Room for the record's own fields and its at most three moves, beyond the text and the files. */
const APPEAL_RECORD_ROOM = 4_096;

/**
 * The most one request can keep, checked before anything is written: its text at four bytes a character (the most
 * UTF-8 takes), the reason of the final answer, the files at their ceiling and the record's own room. With one
 * request per decision, the most a store can keep is this times its decisions.
 */
export const appealStoredBytesCeiling = () =>
  (MAX_APPEAL_TEXT + MAX_APPEAL_REASON) * 4 + MAX_APPEAL_ATTACHMENTS * (MAX_APPEAL_ATTACHMENT_BYTES + MAX_APPEAL_ATTACHMENT_NAME * 4) + APPEAL_RECORD_ROOM;

export type AppealAttachment = { name: string; type: (typeof APPEAL_ATTACHMENT_TYPES)[number]; bytes: number };
export type AppealDraft = { decision: string; explanation: string; attachments: AppealAttachment[]; at: string };

export type AppealProblem =
  | "decision"
  | "unknown"
  | "already"
  | "late"
  | "explanation"
  | "explanation_long"
  | "attachments"
  | "attachment_type"
  | "attachment_size";

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").trim().slice(0, max) : "";

function readDecision(raw: unknown): Decision | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const kind = DECISION_KINDS.find((k) => k === d.kind);
  if (!kind || typeof d.report !== "string" || !d.report || typeof d.id !== "string" || typeof d.what !== "string" || !d.what ||
      typeof d.informedAt !== "string" || typeof d.automated !== "boolean") return null;
  // A link or a product names itself; the media kit and the store are one per store.
  if ((kind === "link" || kind === "product") !== (d.id.length > 0)) return null;
  return { report: d.report, kind, id: d.id, informedAt: d.informedAt, what: d.what, automated: d.automated };
}

/**
 * A creator's request made safe, or why it is not taken. `earlier` is the decisions this store already asked about,
 * read exactly by the caller; null when that read is unknown, and then nothing is taken (an unknown is never "none").
 * The checks run in the order a person would want to hear them: the decision, then whether it can still be asked
 * about, then what they wrote.
 */
export function readAppeal(raw: Record<string, unknown>, decisionRaw: unknown, earlier: readonly string[] | null, now: Date):
  { ok: true; appeal: AppealDraft } | { ok: false; problem: AppealProblem; words: string } {
  const refuse = (problem: AppealProblem, words = APPEAL_PROBLEMS[problem]) => ({ ok: false as const, problem, words });
  const decision = readDecision(decisionRaw);
  if (!decision) return refuse("decision");
  if (earlier === null) return refuse("unknown");
  const key = decisionKey(decision);
  if (earlier.includes(key)) return refuse("already");
  const deadline = appealDeadline(decision.informedAt);
  if (deadline && now.getTime() > deadline.last.getTime()) {
    return refuse("late", `The time to ask us to look again at this decision ended on ${appealDate(deadline.shown)}. ${COURT}`);
  }
  if (typeof raw.explanation === "string" && raw.explanation.trim().length > MAX_APPEAL_TEXT) return refuse("explanation_long");
  const explanation = clean(raw.explanation, MAX_APPEAL_TEXT);
  if (!explanation) return refuse("explanation");
  const files = raw.attachments === undefined ? [] : raw.attachments;
  if (!Array.isArray(files) || files.length > MAX_APPEAL_ATTACHMENTS) return refuse("attachments");
  const attachments: AppealAttachment[] = [];
  for (const file of files) {
    const f = file && typeof file === "object" && !Array.isArray(file) ? (file as Record<string, unknown>) : null;
    const type = APPEAL_ATTACHMENT_TYPES.find((t) => t === f?.type);
    if (!f || !type) return refuse("attachment_type");
    if (typeof f.bytes !== "number" || !Number.isSafeInteger(f.bytes) || f.bytes < 1 || f.bytes > MAX_APPEAL_ATTACHMENT_BYTES) return refuse("attachment_size");
    attachments.push({ name: clean(f.name, MAX_APPEAL_ATTACHMENT_NAME) || "file", type, bytes: f.bytes });
  }
  return { ok: true, appeal: { decision: key, explanation, attachments, at: now.toISOString() } };
}

const COURT = "You can still take our decision to a court: section 16 of our Terms, \"Governing law\", says which law and courts apply.";

/** What a request that is not taken says, with what to do next. */
export const APPEAL_PROBLEMS: Record<AppealProblem, string> = {
  decision: "We could not find this decision. Open it again from the notice in your studio.",
  unknown: "We could not check your earlier requests just now, so nothing was sent. Try again in a moment.",
  already: "You already asked us to look again at this decision. You can follow it in your studio.",
  late: `The time to ask us to look again at this decision has ended. ${COURT}`,
  explanation: "Tell us in a sentence or more why you think the decision is wrong.",
  explanation_long: `Make your explanation shorter: at most ${MAX_APPEAL_TEXT.toLocaleString("en-US")} characters.`,
  attachments: `Attach at most ${MAX_APPEAL_ATTACHMENTS} files.`,
  attachment_type: "Attach a PDF, a PNG or JPEG picture, or a plain text file.",
  attachment_size: `Each file can be at most ${MAX_APPEAL_ATTACHMENT_BYTES / (1024 * 1024)} MB.`,
};

/** Crockford's base 32: no I, L, O or U, so a number read aloud or typed again is not mistaken. */
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const APPEAL_NUMBER = /^LA-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/**
 * A request's number from ten random bytes the caller draws (40 bits used: about a trillion numbers). The store
 * that keeps it must refuse a number already taken (a write that only sets a missing key); this only gives its shape.
 */
export function appealNumber(bytes: Uint8Array): string {
  if (bytes.length < 5) throw new Error("an appeal number needs at least 5 random bytes");
  let bits = 0n;
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(bytes[i]);
  let out = "";
  for (let i = 0; i < 8; i++) out = BASE32[Number((bits >> BigInt(5 * i)) & 31n)] + out;
  return `LA-${out.slice(0, 4)}-${out.slice(4)}`;
}

export type AppealMove = { state: AppealState; at: string; by: "creator" | "operator"; reason?: string };
export type Appeal = AppealDraft & { number: string; store: string; state: AppealState; moves: AppealMove[] };

/** A new request, Received, on the store that sent it. */
export function openAppeal(draft: AppealDraft, number: string, store: string): Appeal {
  if (!APPEAL_NUMBER.test(number)) throw new Error("not an appeal number");
  if (!store) throw new Error("an appeal belongs to a store");
  return { ...draft, number, store, state: "received", moves: [{ state: "received", at: draft.at, by: "creator" }] };
}

export type MoveProblem = "who" | "final" | "order" | "reason";

/**
 * Moves a request on. Only a person at Marktmorgen ("operator") moves it, never the creator and never an automatic
 * step (DSA Art. 20(6)); a final answer carries its reason, which the creator is told (Art. 20(5)). A final state
 * never moves again, and nothing moves back.
 */
export function moveAppeal(appeal: Appeal, to: AppealState, by: { role: "creator" | "operator" | "automatic" }, at: Date, reason?: string):
  { ok: true; appeal: Appeal } | { ok: false; problem: MoveProblem } {
  if (by.role !== "operator") return { ok: false, problem: "who" };
  if (isFinal(appeal.state)) return { ok: false, problem: "final" };
  if (!NEXT[appeal.state].includes(to)) return { ok: false, problem: "order" };
  const why = clean(reason, MAX_APPEAL_REASON);
  if (isFinal(to) && !why) return { ok: false, problem: "reason" };
  const move: AppealMove = isFinal(to) ? { state: to, at: at.toISOString(), by: "operator", reason: why } : { state: to, at: at.toISOString(), by: "operator" };
  return { ok: true, appeal: { ...appeal, state: to, moves: [...appeal.moves, move] } };
}

/** A request is seen only from the store that sent it. */
export const appealVisibleTo = (appeal: Pick<Appeal, "store">, store: string) => Boolean(store) && appeal.store === store;

/** What a store under a decision can still do, as the caller has read it: only what is true is said. */
export type StillPossible = { exportData: boolean; refundBuyers: boolean; closeStore: boolean };

/**
 * The studio's notice of a decision, in lines: what we decided and when, whether a person decided it, what the
 * creator can still do, until when they can ask us to look again, and that asking changes nothing while we look and
 * promises no result.
 */
export function decisionNotice(decision: Decision, now: Date, can: StillPossible): string[] {
  const told = appealDeadline(decision.informedAt);
  const lines = [
    `What we decided: ${decision.what}.`,
    told ? `When we told you: ${appealDate(new Date(decision.informedAt))}.` : "",
    decision.automated ? "An automatic check took this decision." : "A person at Marktmorgen read the notice and took this decision. No automatic check was used.",
  ];
  const still = [
    can.exportData ? "download your store's data" : "",
    can.refundBuyers ? "refund your buyers" : "",
    can.closeStore ? "close your store" : "",
  ].filter(Boolean);
  if (still.length) lines.push(`You can still ${still.length === 1 ? still[0] : `${still.slice(0, -1).join(", ")} and ${still[still.length - 1]}`}.`);
  if (told && now.getTime() > told.last.getTime()) {
    lines.push(`The time to ask us to look again ended on ${appealDate(told.shown)}.`);
  } else {
    lines.push(told ? `You can ask us to look again until ${appealDate(told.shown)}. It is free.` : "You can ask us to look again. It is free.");
    lines.push("The decision stays in place while we look, and we cannot tell you in advance what we will decide.");
    if (!restorable(decision.kind)) lines.push("The link and its file were deleted, so they cannot be put back. If we change our decision, you can add the link again.");
  }
  lines.push(COURT);
  return lines.filter(Boolean);
}

/** The words of a request's state for the creator, with its number, and the reason of a final answer. */
export function appealStateWords(appeal: Pick<Appeal, "number" | "state" | "moves" | "decision">): string[] {
  const kind = DECISION_KINDS.find((k) => appeal.decision.startsWith(`${k}-`));
  const last = appeal.moves[appeal.moves.length - 1];
  const lines = [`Request ${appeal.number}: ${APPEAL_STATE_WORDS[appeal.state]}.`, APPEAL_STATE_MEANING[appeal.state]];
  if (isFinal(appeal.state) && last?.reason) lines.push(`Why: ${last.reason}`);
  if (appeal.state === "reversed") {
    lines.push(kind && restorable(kind) ? "What was taken down is back as it was." : "The link and its file were deleted, so they cannot be put back. You can add the link again.");
  }
  if (appeal.state === "upheld") lines.push(COURT);
  return lines;
}
