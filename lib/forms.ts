/**
 * Forms, surveys and quizzes (added 13 October 2026): questions a creator
 * asks on one of their own pages, and the answers kept for them.
 *
 * ClickFunnels sells a form or a survey as a step of a funnel, and an
 * application before a call is one of its funnel types. Here a form is made
 * once in the studio (/studio/forms) and placed on any of the store's own
 * pages with a "Form" block, so a page that is a step of a funnel asks its
 * questions there and, once they are answered, leads on to the next step.
 *
 * A quiz is a form with results: each answer to a choice may point at one of
 * the results, and the result the most answers point at is shown, with a
 * product of the creator's when they chose one for it. That is a sum anyone
 * could check by hand, written down here; nothing scores a person in secret.
 *
 * A scored quiz (added 17 October 2026) adds points instead: each option
 * of a choice carries 0 to MAX_POINTS points, optionally counted in one of
 * up to MAX_CATEGORIES categories too; a person's total is the sum of the
 * points of the options they chose, and their result is the one whose score
 * range holds that total. The ranges must cover every score from 0 to the
 * highest possible with no gap and no overlap (tierIssues), and the studio
 * will not save a scored quiz until they do. The result page says the score
 * and the range it fell in, so a person can see why they got their result.
 * Points are never negative: a total runs from 0 up, and a range is easy to
 * read.
 *
 * Branching (added 13 October 2026, as ClickFunnels' survey workflows do):
 * an answer to a one-choice question may lead on to a later question,
 * skipping those between, or end the form there. Only forward, so nobody is
 * ever sent round in a circle. Questions a person's answers skip are not
 * asked of them, need no answer and keep none; and an answer that ends a
 * quiz decides its result when it points at one, since nothing after it was
 * asked. With JavaScript off every question shows, and the same rules are
 * applied when the answers arrive (pathOf).
 *
 * What it never does:
 *
 *   - Put anybody on the creator's list for answering. A form may offer a box
 *     to hear from the creator, empty until it is checked, and checking it
 *     sends the same email the store's sign-up box sends (lib/store-join.ts):
 *     the address joins only once its owner presses the button in it.
 *   - Ask for a card number, a password or anything of the kind: there is no
 *     field for it, and the help says not to ask.
 *   - Keep more than it has to: the answers, when, and which page they came
 *     from. Not the connection they came from.
 *
 * Pure and browser-safe: the studio's editor, the block that draws a form and
 * the route that takes the answers all read these rules.
 */

export const MAX_FORMS = 20;
export const MAX_FIELDS = 12;
export const MAX_OPTIONS = 8;
export const MAX_OUTCOMES = 6;
export const MAX_FORM_NAME = 60;
export const MAX_LABEL = 160;
export const MAX_OPTION = 80;
export const MAX_BUTTON = 40;
export const MAX_DONE_HEADING = 90;
export const MAX_DONE_BODY = 600;
export const MAX_OUTCOME_TITLE = 90;
export const MAX_OUTCOME_BODY = 600;
/** In a scored quiz: the most points one option carries, and the categories a quiz may count. */
export const MAX_POINTS = 100;
export const MAX_CATEGORIES = 4;
export const MAX_CATEGORY_NAME = 40;
/** The highest total any scored quiz can reach: every option of every question, at the most points. */
export const MAX_SCORE = MAX_FIELDS * MAX_OPTIONS * MAX_POINTS;
/** The most a person may type into one answer. */
export const MAX_SHORT_ANSWER = 200;
export const MAX_LONG_ANSWER = 2_000;
/** The answers kept for each form: the newest, as many as fill a spreadsheet a person reads. */
export const KEPT_RESPONSES = 2_000;

export const FORM_ID = /^[a-z0-9]{10}$/;
const PIECE_ID = /^[a-z0-9]{6}$/;
const PRODUCT_ID = /^[a-z0-9]{6,40}$/;

export type FieldType = "short" | "long" | "email" | "choice" | "choices" | "scale";

export const FIELD_TYPES: { type: FieldType; label: string; hint: string }[] = [
  { type: "short", label: "Short answer", hint: "One line: a name, a website, a number." },
  { type: "long", label: "Long answer", hint: "A few paragraphs: what they want, where they are stuck." },
  { type: "email", label: "Email address", hint: "Checked as an address. Needed to offer them your list." },
  { type: "choice", label: "One choice", hint: `Up to ${MAX_OPTIONS} options; they pick one. Each option can lead to a later question or end the form, and in a quiz point at a result.` },
  { type: "choices", label: "Several choices", hint: `Up to ${MAX_OPTIONS} options; they pick any.` },
  { type: "scale", label: "Scale of 1 to 10", hint: "A number from 1 to 10." },
];

export type FormOption = {
  id: string;
  label: string;
  /** In a quiz: the result this answer points at, or "". */
  outcome: string;
  /** Where this answer leads, on a one-choice question: "" for the next question, a later question's id, or END. */
  next?: string;
  /** In a scored quiz: the points this answer adds, 0 to MAX_POINTS. Absent outside one. */
  points?: number;
  /** In a scored quiz: the category these points also count in, when it has one. */
  category?: string;
};

/** An answer that ends the form there. */
export const END = "end";

export type FormField = { id: string; type: FieldType; label: string; required: boolean; options: FormOption[] };

export type FormOutcome = {
  id: string;
  title: string;
  body: string;
  /** A product of the store's to suggest, or "". */
  product: string;
  /** In a scored quiz: the lowest and highest total this result is for, both included. Absent outside one. */
  min?: number;
  max?: number;
};

/** In a scored quiz: a group of answers whose points are also added up apart, as "Mindset" or "Marketing". */
export type FormCategory = { id: string; name: string };

export type FormDef = {
  id: string;
  /** What the creator calls it in the studio. Never shown to a visitor. */
  name: string;
  fields: FormField[];
  /** The button's words; empty for the store's language's own. */
  button: string;
  /** What a person reads once they have sent it, when there is no result to show and no next step. */
  doneHeading: string;
  doneBody: string;
  /** Results, for a quiz. Empty for a form or a survey. */
  outcomes: FormOutcome[];
  /** Whether it offers a box to hear from the creator by email: needs an email field. */
  offerList: boolean;
  /** "points" for a scored quiz: results by score range, not by the answers pointing at them. Absent otherwise. */
  scoring?: "points";
  /** A scored quiz's categories, in the creator's order. Absent outside one. */
  categories?: FormCategory[];
  /** When it was last changed, in seconds. */
  updatedAt: number;
  /**
   * When it starts and stops taking answers, in seconds (639 [GL7](26)):
   * before the first and after the second the page says so instead of
   * asking, and the answers route refuses. Absent: always open.
   */
  opensAt?: number;
  closesAt?: number;
};

/** The latest moment a form may be set to open or close: the end of 2100, in seconds. */
export const LATEST_SCHEDULE = Date.UTC(2100, 11, 31, 23, 59) / 1000;

/** Whether a form is long enough to offer keeping its answers on the visitor's device (639 [GL7](26)): four questions or more, or one to write at length. */
export function offersKeep(form: Pick<FormDef, "fields">): boolean {
  return form.fields.length >= 4 || form.fields.some((f) => f.type === "long");
}

/** When a form opens, as a visitor reads it: the date and time in UTC, said so, in the store's language. */
export function scheduleWhen(seconds: number, lang: string): string {
  return new Intl.DateTimeFormat(lang, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(seconds * 1000));
}

/** Whether a form takes answers now: "open", "not_yet" (before it opens) or "ended" (after it closes). */
export function formOpen(form: Pick<FormDef, "opensAt" | "closesAt">, nowSeconds: number): "open" | "not_yet" | "ended" {
  if (form.opensAt && nowSeconds < form.opensAt) return "not_yet";
  if (form.closesAt && nowSeconds >= form.closesAt) return "ended";
  return "open";
}

const oneLine = (value: unknown, max: number) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

/** Paragraphs: line breaks kept, nothing else that is not text. */
const paragraphs = (value: unknown, max: number) =>
  typeof value === "string"
    ? value
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, max)
    : "";

/** A new id for a form (ten letters and digits) or one of its pieces (six). */
export function newFormId(length = 10, random: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length }, () => letters[random(letters.length)]).join("");
}

/** A whole number from 0 to `max`, or null. */
const whole = (value: unknown, max: number): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null);

const isType = (value: unknown): value is FieldType => FIELD_TYPES.some((t) => t.type === value);
const hasOptions = (type: FieldType) => type === "choice" || type === "choices";

/**
 * A form as stored or as the studio sends it, made safe: known field types,
 * each piece with an id of its own, options only where they mean something,
 * results pointed at only when they exist, a product only by its id (the
 * route checks it is the store's). Null when nothing usable is left.
 */
export function parseForm(raw: unknown): FormDef | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" && FORM_ID.test(value.id) ? value.id : "";
  const name = oneLine(value.name, MAX_FORM_NAME);
  if (!id || !name) return null;
  const scored = value.scoring === "points";

  const categories: FormCategory[] = [];
  for (const entry of scored && Array.isArray(value.categories) ? value.categories : []) {
    if (categories.length >= MAX_CATEGORIES || !entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const cid = typeof row.id === "string" && PIECE_ID.test(row.id) ? row.id : "";
    const label = oneLine(row.name, MAX_CATEGORY_NAME);
    if (!cid || !label || categories.some((c) => c.id === cid)) continue;
    categories.push({ id: cid, name: label });
  }
  const groups = new Set(categories.map((c) => c.id));

  const outcomes: FormOutcome[] = [];
  for (const entry of Array.isArray(value.outcomes) ? value.outcomes : []) {
    if (outcomes.length >= MAX_OUTCOMES || !entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const oid = typeof row.id === "string" && PIECE_ID.test(row.id) ? row.id : "";
    const title = oneLine(row.title, MAX_OUTCOME_TITLE);
    if (!oid || !title || outcomes.some((o) => o.id === oid)) continue;
    outcomes.push({
      id: oid,
      title,
      body: paragraphs(row.body, MAX_OUTCOME_BODY),
      product: typeof row.product === "string" && PRODUCT_ID.test(row.product) ? row.product : "",
      // A range that cannot be read is 0 to 0 here, and tierIssues says so before anything is saved.
      ...(scored ? { min: whole(row.min, MAX_SCORE) ?? 0, max: whole(row.max, MAX_SCORE) ?? 0 } : {}),
    });
  }
  const results = new Set(outcomes.map((o) => o.id));

  const fields: FormField[] = [];
  const ids = new Set<string>();
  for (const entry of Array.isArray(value.fields) ? value.fields : []) {
    if (fields.length >= MAX_FIELDS || !entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const fid = typeof row.id === "string" && PIECE_ID.test(row.id) ? row.id : "";
    const label = oneLine(row.label, MAX_LABEL);
    if (!fid || !label || !isType(row.type) || ids.has(fid)) continue;
    const options: FormOption[] = [];
    if (hasOptions(row.type)) {
      for (const item of Array.isArray(row.options) ? row.options : []) {
        if (options.length >= MAX_OPTIONS || !item || typeof item !== "object") continue;
        const opt = item as Record<string, unknown>;
        const pid = typeof opt.id === "string" && PIECE_ID.test(opt.id) ? opt.id : "";
        const text = oneLine(opt.label, MAX_OPTION);
        if (!pid || !text || options.some((o) => o.id === pid) || ids.has(pid)) continue;
        const next = row.type === "choice" && typeof opt.next === "string" && (opt.next === END || PIECE_ID.test(opt.next)) ? opt.next : "";
        // In a scored quiz the points decide the result, so an answer points at none.
        const outcome = !scored && typeof opt.outcome === "string" && results.has(opt.outcome) ? opt.outcome : "";
        const category = scored && typeof opt.category === "string" && groups.has(opt.category) ? opt.category : "";
        options.push({ id: pid, label: text, outcome, ...(next ? { next } : {}), ...(scored ? { points: whole(opt.points, MAX_POINTS) ?? 0, ...(category ? { category } : {}) } : {}) });
      }
      // A choice with fewer than two options is not a choice.
      if (options.length < 2) continue;
    }
    ids.add(fid);
    for (const o of options) ids.add(o.id);
    fields.push({ id: fid, type: row.type, label, required: row.required === true, options });
  }
  if (!fields.length) return null;
  // An answer leads only forward, to a question that is still there: anything else goes on to the next one.
  fields.forEach((field, at) => {
    for (const option of field.options) {
      if (!option.next || option.next === END) continue;
      const to = fields.findIndex((f) => f.id === option.next);
      if (to <= at) delete option.next;
    }
  });

  const offerList = value.offerList === true && fields.some((f) => f.type === "email");
  const updatedAt = typeof value.updatedAt === "number" && Number.isInteger(value.updatedAt) && value.updatedAt > 0 ? value.updatedAt : 0;
  return {
    id,
    name,
    fields,
    button: oneLine(value.button, MAX_BUTTON),
    doneHeading: oneLine(value.doneHeading, MAX_DONE_HEADING),
    doneBody: paragraphs(value.doneBody, MAX_DONE_BODY),
    outcomes,
    offerList,
    updatedAt,
    ...(scored ? { scoring: "points" as const, categories } : {}),
    ...schedule(value.opensAt, value.closesAt),
  };
}

/** A schedule as sent: whole seconds up to LATEST_SCHEDULE; a close not after the opening is let go. */
function schedule(rawOpens: unknown, rawCloses: unknown): { opensAt?: number; closesAt?: number } {
  const at = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= LATEST_SCHEDULE ? v : 0);
  const opensAt = at(rawOpens);
  const closesAt = at(rawCloses);
  return { ...(opensAt ? { opensAt } : {}), ...(closesAt && (!opensAt || closesAt > opensAt) ? { closesAt } : {}) };
}

/**
 * Whether a form as the studio sends it gives any option points that are not
 * a whole number from 0 to MAX_POINTS. parseForm would read those as 0; the
 * route refuses them instead, so a creator's typo never changes a score
 * without their seeing it. Negative points are refused: a total starts at 0.
 */
export function badPoints(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).scoring !== "points") return false;
  const fields = (raw as Record<string, unknown>).fields;
  return (Array.isArray(fields) ? fields : []).some((field) => {
    const options = field && typeof field === "object" ? (field as Record<string, unknown>).options : null;
    return (Array.isArray(options) ? options : []).some((option) => {
      const points = option && typeof option === "object" ? (option as Record<string, unknown>).points : undefined;
      return points !== undefined && whole(points, MAX_POINTS) === null;
    });
  });
}

/** One person's answers: by field id, a line of text, the chosen options' ids, or a number. */
export type Answers = Record<string, string | string[] | number>;

export type ReadAnswers =
  | { ok: true; answers: Answers; email: string }
  | { ok: false; error: "required" | "email" | "invalid"; field: string };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/**
 * What a person sent, read against the form as it is now: an answer for a
 * field the form does not have is left out, an option it does not offer is
 * refused, and every required field has to have something in it. `get`
 * returns every value sent under a name (a form's own way of sending several
 * choices).
 */
/**
 * The questions a person is asked, in order, given the answers to the
 * one-choice questions so far: each answer that leads somewhere is followed,
 * forward only, and one that ends the form stops it. Pure, and the same in
 * the browser and on the server.
 */
export function pathOf(form: FormDef, choiceOf: (fieldId: string) => string | undefined): FormField[] {
  const path: FormField[] = [];
  let at = 0;
  while (at < form.fields.length) {
    const field = form.fields[at];
    path.push(field);
    const picked = field.type === "choice" ? field.options.find((o) => o.id === choiceOf(field.id)) : undefined;
    if (picked?.next === END) break;
    const to = picked?.next ? form.fields.findIndex((f) => f.id === picked.next) : -1;
    at = to > at ? to : at + 1;
  }
  return path;
}

/** Whether any answer of a form leads somewhere other than the next question. */
export function branches(form: FormDef): boolean {
  return form.fields.some((f) => f.options.some((o) => Boolean(o.next)));
}

export function readAnswers(form: FormDef, get: (name: string) => string[]): ReadAnswers {
  const answers: Answers = {};
  let email = "";
  // Only the questions this person's own answers lead through: the others were not asked.
  const asked = pathOf(form, (id) => get(`q_${id}`).map((v) => v.trim()).find(Boolean));
  for (const field of asked) {
    const sent = get(`q_${field.id}`).map((v) => v.trim()).filter(Boolean);
    if (!sent.length) {
      if (field.required) return { ok: false, error: "required", field: field.id };
      continue;
    }
    switch (field.type) {
      case "short":
      case "long": {
        const text = field.type === "short" ? oneLine(sent[0], MAX_SHORT_ANSWER) : paragraphs(sent[0], MAX_LONG_ANSWER);
        if (text) answers[field.id] = text;
        else if (field.required) return { ok: false, error: "required", field: field.id };
        break;
      }
      case "email": {
        const text = sent[0].toLowerCase().slice(0, 254);
        if (!EMAIL.test(text)) return { ok: false, error: "email", field: field.id };
        answers[field.id] = text;
        if (!email) email = text;
        break;
      }
      case "choice": {
        if (!field.options.some((o) => o.id === sent[0])) return { ok: false, error: "invalid", field: field.id };
        answers[field.id] = sent[0];
        break;
      }
      case "choices": {
        const picked = [...new Set(sent)];
        if (picked.some((id) => !field.options.some((o) => o.id === id))) return { ok: false, error: "invalid", field: field.id };
        answers[field.id] = field.options.filter((o) => picked.includes(o.id)).map((o) => o.id);
        break;
      }
      case "scale": {
        const n = Number(sent[0]);
        if (!Number.isInteger(n) || n < 1 || n > 10) return { ok: false, error: "invalid", field: field.id };
        answers[field.id] = n;
        break;
      }
    }
  }
  return { ok: true, answers, email };
}

/**
 * A quiz's result. In a scored quiz, the one whose range holds the total,
 * or none when no scored question was answered: nothing was measured, so
 * the form's own thank-you shows instead of a result for a score of 0.
 * Otherwise, the one an answer that ended the quiz points at, or else
 * the one the most chosen answers point at, the first of them in the
 * creator's order on a tie. Null for a form with no results, or when no
 * answer pointed anywhere.
 */
export function outcomeOf(form: FormDef, answers: Answers): FormOutcome | null {
  if (!form.outcomes.length) return null;
  // A scored quiz: the result whose range holds the total, once at least one scored question was answered.
  if (isScored(form)) {
    const score = scoreOf(form, answers);
    return score && score.answered > 0 ? tierFor(form, score.total) : null;
  }
  // An answer that ended the quiz decides it, when it points at a result: nothing after it was asked.
  const path = pathOf(form, (id) => (typeof answers[id] === "string" ? (answers[id] as string) : undefined));
  const last = path[path.length - 1];
  const ending = last?.type === "choice" ? last.options.find((o) => o.id === answers[last.id] && o.next === END && o.outcome) : undefined;
  if (ending) return form.outcomes.find((o) => o.id === ending.outcome) ?? null;
  const votes = new Map<string, number>();
  for (const field of form.fields) {
    const given = answers[field.id];
    const picked = typeof given === "string" ? [given] : Array.isArray(given) ? given : [];
    for (const id of picked) {
      const outcome = field.options.find((o) => o.id === id)?.outcome;
      if (outcome) votes.set(outcome, (votes.get(outcome) ?? 0) + 1);
    }
  }
  let best: FormOutcome | null = null;
  let most = 0;
  for (const outcome of form.outcomes) {
    const n = votes.get(outcome.id) ?? 0;
    if (n > most) {
      best = outcome;
      most = n;
    }
  }
  return best;
}

/** Whether a form is a scored quiz. */
export const isScored = (form: Pick<FormDef, "scoring">): boolean => form.scoring === "points";

/** A person's score in a scored quiz: the total, each category's part of it, and how many scored questions they answered. */
export type QuizScore = { total: number; categories: Record<string, number>; answered: number };

/**
 * The highest total, and each category's highest, any answers to this quiz
 * can reach: a one-choice question's best option, every option of a
 * several-choices question. Questions an answer may skip are counted, so this
 * is the most anybody could score, never less.
 */
export function maxScore(form: FormDef): { total: number; categories: Record<string, number> } {
  const categories: Record<string, number> = Object.fromEntries((form.categories ?? []).map((c) => [c.id, 0]));
  let total = 0;
  for (const field of form.fields) {
    if (!hasOptions(field.type)) continue;
    const points = (o: FormOption) => o.points ?? 0;
    if (field.type === "choice") {
      total += Math.max(0, ...field.options.map(points));
      for (const id of Object.keys(categories)) categories[id] += Math.max(0, ...field.options.filter((o) => o.category === id).map(points));
    } else {
      for (const o of field.options) {
        total += points(o);
        if (o.category && o.category in categories) categories[o.category] += points(o);
      }
    }
  }
  return { total, categories };
}

/**
 * What a person scored: the points of every option they chose, on the
 * questions their answers led them through, added up, and the same apart for
 * each category. Null for a form that is not a scored quiz.
 */
export function scoreOf(form: FormDef, answers: Answers): QuizScore | null {
  if (!isScored(form)) return null;
  const categories: Record<string, number> = Object.fromEntries((form.categories ?? []).map((c) => [c.id, 0]));
  let total = 0;
  let answered = 0;
  const path = pathOf(form, (id) => (typeof answers[id] === "string" ? (answers[id] as string) : undefined));
  for (const field of path) {
    if (!hasOptions(field.type)) continue;
    const given = answers[field.id];
    const picked = typeof given === "string" ? [given] : Array.isArray(given) ? given : [];
    const chosen = field.options.filter((o) => picked.includes(o.id));
    if (!chosen.length) continue;
    answered += 1;
    for (const o of chosen) {
      total += o.points ?? 0;
      if (o.category && o.category in categories) categories[o.category] += o.points ?? 0;
    }
  }
  return { total, categories, answered };
}

/** The result whose range holds this total, the first in the creator's order; null when none does. */
export function tierFor(form: FormDef, total: number): FormOutcome | null {
  return form.outcomes.find((o) => typeof o.min === "number" && typeof o.max === "number" && o.min <= total && total <= o.max) ?? null;
}

/** Ranges of equal width from 0 to the highest possible total, one per result, in the creator's order. */
export function evenRanges(top: number, count: number): { min: number; max: number }[] {
  if (count <= 0) return [];
  const span = top + 1;
  return Array.from({ length: count }, (_, i) => {
    const min = Math.floor((span * i) / count);
    const max = Math.max(min, Math.floor((span * (i + 1)) / count) - 1);
    return { min, max };
  });
}

/** What is wrong with a scored quiz's ranges; each one keeps it from being saved. */
export type TierIssue =
  | { kind: "none" }
  | { kind: "unscored" }
  | { kind: "inverted"; outcome: string }
  | { kind: "gap"; from: number; to: number }
  | { kind: "overlap"; from: number; to: number; outcomes: [string, string] }
  | { kind: "unreachable"; outcome: string };

/**
 * Checks that a scored quiz's results cover every total from 0 to the
 * highest possible (maxScore), each exactly once: no score without a result,
 * no score with two, no result nobody can reach, and some answer that
 * carries points. Empty when all is well, and always for a form that is not
 * a scored quiz.
 */
export function tierIssues(form: FormDef): TierIssue[] {
  if (!isScored(form)) return [];
  const issues: TierIssue[] = [];
  const top = maxScore(form).total;
  if (top === 0) issues.push({ kind: "unscored" });
  if (!form.outcomes.length) return [...issues, { kind: "none" }];
  const ranged: (FormOutcome & { min: number; max: number })[] = [];
  for (const o of form.outcomes) {
    const min = o.min ?? 0;
    const max = o.max ?? 0;
    if (min > max) issues.push({ kind: "inverted", outcome: o.id });
    else if (min > top) issues.push({ kind: "unreachable", outcome: o.id });
    else ranged.push({ ...o, min, max });
  }
  ranged.sort((a, b) => a.min - b.min || a.max - b.max);
  // `next` is the lowest total not yet covered; `widest` the result covering up to just below it.
  let next = 0;
  let widest: (typeof ranged)[number] | null = null;
  for (const tier of ranged) {
    if (tier.min > next) issues.push({ kind: "gap", from: next, to: tier.min - 1 });
    else if (tier.min < next && widest) issues.push({ kind: "overlap", from: tier.min, to: Math.min(tier.max, next - 1), outcomes: [widest.id, tier.id] });
    if (tier.max + 1 > next) {
      next = tier.max + 1;
      widest = tier;
    }
  }
  if (next <= top) issues.push({ kind: "gap", from: next, to: top });
  return issues;
}

/** One issue in words, for the studio, with the results' own titles. */
export function tierIssueText(form: FormDef, issue: TierIssue): string {
  const title = (id: string) => {
    const at = form.outcomes.findIndex((o) => o.id === id);
    return `“${form.outcomes[at]?.title || `Result ${at + 1}`}”`;
  };
  const scores = (from: number, to: number) => (from === to ? `a score of ${from}` : `scores ${from} to ${to}`);
  switch (issue.kind) {
    case "none":
      return "A scored quiz needs at least one result with a score range.";
    case "unscored":
      return "No answer carries points yet, so everyone would score 0. Give some options points.";
    case "inverted":
      return `${title(issue.outcome)} ends below where it starts. Make its lowest score no higher than its highest.`;
    case "gap":
      return `No result covers ${scores(issue.from, issue.to)}. Widen a range so every score has a result.`;
    case "overlap":
      return `${title(issue.outcomes[0])} and ${title(issue.outcomes[1])} both cover ${scores(issue.from, issue.to)}. Each score needs exactly one result.`;
    case "unreachable":
      return `${title(issue.outcome)} starts above ${maxScore(form).total}, the highest score possible, so nobody would get it.`;
  }
}

/** A score in the result page's address: `&s=<total>` and, with categories, `&c=<id>-<points>.<id>-<points>`. */
export function scoreQuery(score: QuizScore): string {
  const parts = Object.entries(score.categories).map(([id, n]) => `${id}-${n}`);
  return `&s=${score.total}${parts.length ? `&c=${parts.join(".")}` : ""}`;
}

/** A score as the result page shows it: the total, the highest possible, and each category's. */
export type ShownScore = { total: number; top: number; categories: { id: string; name: string; points: number; top: number }[] };

/**
 * Reads a score back from the result page's address, for this result. Only
 * numbers that could be true are shown: whole, within what the quiz can
 * reach, and a total that this result's range holds; anything else shows the
 * result without a score. Nothing here is anybody's answers.
 */
export function readScoreQuery(form: FormDef, outcome: FormOutcome | null, s: string, c: string): ShownScore | null {
  if (!isScored(form) || !outcome || !/^\d{1,5}$/.test(s)) return null;
  const total = Number(s);
  const top = maxScore(form);
  if (total > top.total || tierFor(form, total)?.id !== outcome.id) return null;
  const sent = new Map<string, number>();
  for (const part of c.slice(0, 200).split(".")) {
    const m = /^([a-z0-9]{6})-(\d{1,5})$/.exec(part);
    if (m) sent.set(m[1], Number(m[2]));
  }
  const categories = (form.categories ?? []).flatMap((cat) => {
    const points = sent.get(cat.id);
    const most = top.categories[cat.id] ?? 0;
    return typeof points === "number" && points <= most && points <= total ? [{ id: cat.id, name: cat.name, points, top: most }] : [];
  });
  return { total, top: top.total, categories };
}

/** An answer as a person reads it in the studio or a spreadsheet: the options' words, not their ids. */
export function answerText(field: FormField, given: Answers[string] | undefined): string {
  if (given === undefined) return "";
  if (typeof given === "number") return String(given);
  if (Array.isArray(given)) return given.map((id) => field.options.find((o) => o.id === id)?.label ?? "").filter(Boolean).join("; ");
  if (hasOptions(field.type)) return field.options.find((o) => o.id === given)?.label ?? "";
  return given;
}

/** A spreadsheet cell that cannot be read as a formula. */
export function safeCell(text: string): string {
  const cell = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** One kept response. */
export const FORM_RESPONSE_ID = /^[a-f0-9]{32}$/;
export type FormResponse = {
  /** Server-generated identity; absent on legacy records. */ id?: string;
  at: number;
  page: string;
  answers: Answers;
  outcome: string;
  joined: boolean;
  /** In a scored quiz: the total, and each category's part, by category id. Absent otherwise. */
  score?: number;
  scores?: Record<string, number>;
};

/** The responses as a spreadsheet: when, each question, the result, and whether they asked to hear from the creator. */
export function responsesCsv(form: FormDef, responses: FormResponse[]): string {
  const scored = isScored(form);
  const groups = form.categories ?? [];
  const head = [
    "Sent",
    ...form.fields.map((f) => f.label),
    ...(scored ? ["Score", ...groups.map((c) => `Score: ${c.name}`)] : []),
    ...(form.outcomes.length ? ["Result"] : []),
    ...(form.offerList ? ["Asked to hear from you"] : []),
  ];
  const rows = responses.map((r) => [
    new Date(r.at * 1000).toISOString(),
    ...form.fields.map((f) => answerText(f, r.answers[f.id])),
    ...(scored ? [typeof r.score === "number" ? String(r.score) : "", ...groups.map((c) => (typeof r.scores?.[c.id] === "number" ? String(r.scores[c.id]) : ""))] : []),
    ...(form.outcomes.length ? [form.outcomes.find((o) => o.id === r.outcome)?.title ?? ""] : []),
    ...(form.offerList ? [r.joined ? "Yes, once they confirm by email" : "No"] : []),
  ]);
  return [head, ...rows].map((row) => row.map(safeCell).join(",")).join("\r\n") + "\r\n";
}
