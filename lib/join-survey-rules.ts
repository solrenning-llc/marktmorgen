/**
 * 421 [PT1](a): one optional question right after a membership is paid for,
 * "What do you most hope to get from it?", so the creator learns what new
 * members came for and can make that first. The exit question, (b), already
 * exists (lib/leave-rules.ts, app/[handle]/manage/leave) and is not touched.
 *
 * - Off for every store until its creator turns it on.
 * - Ready choices in plain words, up to three of the creator's own, and
 *   "Something else" always, with a short comment.
 * - Every change to the choices (one dropped, one added, one renamed) starts
 *   a new version. An answer keeps the version and the words it was given
 *   under, so results stay comparable and renaming a choice never rewrites
 *   what anybody answered. An answer from a page opened before a change is
 *   refused, never filed under the new words.
 * - Asked only after a CONFIRMED payment for a membership, once, and never
 *   as a step: access, delivery and the receipt never wait on it. Anything
 *   that cannot be read (the payment, whether it was answered) means it is
 *   not asked.
 * - An answer carries no name, address or order: only the version, the
 *   choice, its words and the comment, with links and email addresses
 *   taken out so it does not become a way to reach anybody.
 *
 * Browser-safe: no storage, no network.
 */

export const JOIN_HOPES = ["learn", "results", "community", "access", "support", "other"] as const;
export type JoinHope = (typeof JOIN_HOPES)[number];
export const JOIN_NAMES: Record<JoinHope, string> = {
  learn: "Learn something new",
  results: "Reach a goal I have",
  community: "Meet people like me",
  access: "Get every new post or lesson",
  support: "Ask questions and get answers",
  other: "Something else",
};
const isJoinHope = (value: unknown): value is JoinHope => typeof value === "string" && (JOIN_HOPES as readonly string[]).includes(value);

/** A choice the creator wrote, with an id that never changes. */
export type OwnHope = { id: string; text: string };
export const MAX_OWN_HOPES = 3;
export const MAX_OWN_HOPE_LENGTH = 80;
const OWN_ID = /^own_[0-9a-f]{6}$/;

export const MAX_JOIN_COMMENT = 280;

export type JoinSurveySetting = { on: boolean; version: number; hopes: JoinHope[]; own: OwnHope[] };
export const NO_JOIN_SURVEY: JoinSurveySetting = { on: false, version: 1, hopes: [...JOIN_HOPES], own: [] };

const words = (text: unknown, max: number) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, max) : "");

function readHopes(raw: unknown): JoinHope[] {
  const picked = Array.isArray(raw) ? raw.filter(isJoinHope) : [...JOIN_HOPES];
  // In the list's own order, each once; "Something else" always, so nobody is left without an answer that fits.
  return JOIN_HOPES.filter((h) => picked.includes(h) || h === "other");
}

function readOwn(raw: unknown): OwnHope[] {
  const own: OwnHope[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== "object") continue;
    const { id, text } = item as { id?: unknown; text?: unknown };
    const clean = words(text, MAX_OWN_HOPE_LENGTH);
    if (typeof id === "string" && OWN_ID.test(id) && clean && !own.some((o) => o.id === id) && own.length < MAX_OWN_HOPES) own.push({ id, text: clean });
  }
  return own;
}

export function parseJoinSurvey(raw: unknown): JoinSurveySetting {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const version = typeof value.version === "number" && Number.isInteger(value.version) && value.version >= 1 ? value.version : 1;
  return { on: value.on === true, version, hopes: readHopes(value.hopes), own: readOwn(value.own) };
}

const sameChoices = (a: JoinSurveySetting, b: JoinSurveySetting) =>
  JSON.stringify([a.hopes, a.own]) === JSON.stringify([b.hopes, b.own]);

/** The creator's change: turning it on or off keeps the version; any change to the choices starts the next one. */
export function editJoinSurvey(old: JoinSurveySetting, change: { on?: boolean; hopes?: unknown; own?: unknown }): JoinSurveySetting {
  const next: JoinSurveySetting = {
    on: typeof change.on === "boolean" ? change.on : old.on,
    version: old.version,
    hopes: change.hopes === undefined ? old.hopes : readHopes(change.hopes),
    own: change.own === undefined ? old.own : readOwn(change.own),
  };
  return sameChoices(old, next) ? next : { ...next, version: old.version + 1 };
}

/** The choices as the page shows them: the ready ones, the creator's own, "Something else" last. */
export function joinChoices(setting: JoinSurveySetting): { id: string; label: string }[] {
  return [
    ...setting.hopes.filter((h) => h !== "other").map((h) => ({ id: h, label: JOIN_NAMES[h] })),
    ...setting.own.map((o) => ({ id: o.id, label: o.text })),
    { id: "other", label: JOIN_NAMES.other },
  ];
}

/**
 * Whether the page after a payment asks the question. Only "ask" or "skip":
 * nothing waits on it, and anything that cannot be read is "skip".
 */
export function joinSurveyStep(input: {
  setting: JoinSurveySetting;
  kind: "subscription" | "one-time";
  paid: "confirmed" | "pending" | "unknown";
  /** Null when it could not be read. */
  answered: boolean | null;
}): "ask" | "skip" {
  return input.setting.on && input.kind === "subscription" && input.paid === "confirmed" && input.answered === false ? "ask" : "skip";
}

export type JoinAnswer = { v: number; choice: string; label: string; comment: string };

const LINK = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

/** What is kept of an answer, or why nothing is. */
export function cleanJoinAnswer(
  setting: JoinSurveySetting,
  raw: { v: unknown; choice: unknown; comment: unknown },
): { ok: true; answer: JoinAnswer } | { ok: false; problem: "off" | "version" | "choice" } {
  if (!setting.on) return { ok: false, problem: "off" };
  if (raw.v !== setting.version) return { ok: false, problem: "version" };
  const choice = joinChoices(setting).find((c) => c.id === raw.choice);
  if (!choice) return { ok: false, problem: "choice" };
  const comment = typeof raw.comment === "string" ? words(raw.comment.replace(LINK, " ").replace(EMAIL, " "), MAX_JOIN_COMMENT) : "";
  return { ok: true, answer: { v: setting.version, choice: choice.id, label: choice.label, comment } };
}
