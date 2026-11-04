/**
 * Saved agreement templates (634 [GL2], unit 1; added 2 November 2026): the
 * rules, browser-safe. Keeping them in the store and choosing one in the
 * studio are the next units.
 *
 * A template is what a creator would otherwise type again for each client:
 * a kind, a title, the text and the lines. It is checked by readDraft
 * (lib/agreement-rules.ts) itself when saved and again once filled, so a
 * template the rules for an agreement would refuse is never kept, and one
 * kept always makes a draft those rules take, or says why not.
 *
 *   - Two placeholders may be written in its title, text and lines, exactly
 *     so: TEMPLATE_FIELDS. Anything else that looks like one, and a brace
 *     stuck to one ("{{client_name}"), is refused when it is saved, saying
 *     which and where, so a client never reads braces. The words are read as
 *     an agreement keeps them (spaces made one, controls taken out,
 *     full-width braces made plain) before they are checked or filled.
 *   - Filled when an agreement is made from it, in one pass: {client_name}
 *     from the name the creator types for this agreement, which is also the
 *     name the agreement records and its text shows after "To:", and
 *     {store_name} from the store's own name, the one shown after "From:".
 *   - Filling makes a draft only: the creator sees it, may change it, and it
 *     goes through readDraft with the email address and the consent box like
 *     any other. A template never sends, signs or charges anything, and
 *     editing one changes no agreement already made from it.
 */
import { type AgreementKind, type DraftProblem, DRAFT_PROBLEMS, MAX_NAME, clean, plainText, readDraft } from "@/lib/agreement-rules";
import type { Currency } from "@/lib/money";

/** The placeholders a template may hold. */
export const TEMPLATE_FIELDS = ["{client_name}", "{store_name}"] as const;
export type TemplateField = (typeof TEMPLATE_FIELDS)[number];

/** The most templates one store keeps, and the longest name of one. */
export const MAX_TEMPLATES = 20;
export const MAX_TEMPLATE_NAME = 60;

export type TemplateLine = { text: string; quantity: number | string; amount: string };

export type AgreementTemplate = {
  /** 32 hex characters. */
  id: string;
  /** What the creator calls it in the studio, never shown to a client. */
  name: string;
  kind: AgreementKind;
  title: string;
  body: string;
  /** Amounts as typed ("120.50"), read by readDraft each time. */
  lines: TemplateLine[];
  updatedAt: number;
};

/** Where a placeholder problem is: the title, the text, or a line (from 1). */
export type Where = { part: "title" | "text" } | { part: "line"; line: number };

export type TemplateProblem =
  | { why: "name" | "too_many" | "client_name" | "store_name" | "client_name_long" }
  | { why: "unknown_field"; found: string; where: Where }
  | { why: "draft"; problem: DraftProblem; line?: number };

const whereWords = (w: Where) => (w.part === "line" ? `line ${w.line}` : `the ${w.part}`);

/** What the studio says, in plain words, with how to fix it. */
export function templateProblemWords(p: TemplateProblem): string {
  switch (p.why) {
    case "name":
      return `Give the template a name of up to ${MAX_TEMPLATE_NAME} characters, so you can find it later.`;
    case "too_many":
      return `Your store can keep up to ${MAX_TEMPLATES} templates. Delete one you no longer use to save this one.`;
    case "client_name":
      return "This template puts the client's name in. Type the client's name first.";
    case "store_name":
      return "This template puts your store's name in. Give your store a name in its settings first.";
    case "client_name_long":
      return `Keep the client's name within ${MAX_NAME} characters.`;
    case "unknown_field":
      return `Only {client_name} and {store_name} are replaced with real names. Check the spelling of “${p.found}” in ${whereWords(p.where)}, or take it out.`;
    case "draft":
      return p.line === undefined ? DRAFT_PROBLEMS[p.problem] : `Line ${p.line + 1}: ${DRAFT_PROBLEMS[p.problem]}`;
  }
}

// Words as the template keeps them before any check: full-width braces and spaces made plain, then as an agreement keeps them.
const plainBraces = (text: string) => text.normalize("NFKC");
const oneLine = (text: string, max: number) => clean(plainBraces(text), max + 1);
const block = (text: string, max: number) => plainText(plainBraces(text), max + 1);

// One word in curly braces, double braces, or a brace stuck to a kept placeholder. Bounded and on one line.
const FIELD_LIKE = /\{\{[^{}\n]{1,80}\}\}|\{[ \t]*[\p{L}_][\p{L}\p{N}_. -]{0,40}[ \t]*\}|\{(?=\{(?:client_name|store_name)\})|(?<=\{(?:client_name|store_name)\})\}/gu;

/** Placeholders in the words that are not the two kept ones, and stray braces stuck to them; empty when there are none. */
export function unknownFields(text: string): string[] {
  return [...plainBraces(text).matchAll(FIELD_LIKE)].map((m) => m[0]).filter((found) => !(TEMPLATE_FIELDS as readonly string[]).includes(found));
}

function firstUnknown(t: { title: string; body: string; lines: TemplateLine[] }): { found: string; where: Where } | null {
  const parts: [string, Where][] = [[t.title, { part: "title" }], [t.body, { part: "text" }], ...t.lines.map((l, i): [string, Where] => [l.text, { part: "line", line: i + 1 }])];
  for (const [text, where] of parts) {
    const found = unknownFields(text)[0];
    if (found) return { found, where };
  }
  return null;
}

// readDraft needs an address and the consent box; neither is the template's, so a stand-in checks only what is.
const PROBE = { email: "template@example.com", consent: true };

const asDraftBody = (t: { kind: AgreementKind; title: string; body: string; lines: TemplateLine[] }) => ({ ...PROBE, kind: t.kind, title: t.title, body: t.body, lines: t.lines });

/**
 * Whether a template may be saved, or the first problem: its name, how many
 * the store keeps besides it (`kept`), its placeholders, and everything an
 * agreement in the store's currency would refuse.
 */
export function templateProblem(t: Pick<AgreementTemplate, "name" | "kind" | "title" | "body" | "lines">, kept: number, currency: Currency): TemplateProblem | null {
  const name = t.name.replace(/\s+/g, " ").trim();
  if (!name || name.length > MAX_TEMPLATE_NAME) return { why: "name" };
  if (kept >= MAX_TEMPLATES) return { why: "too_many" };
  const unknown = firstUnknown(t);
  if (unknown) return { why: "unknown_field", ...unknown };
  const read = readDraft(asDraftBody(t), currency);
  return read.ok ? null : { why: "draft", problem: read.problem, ...(read.line !== undefined ? { line: read.line } : {}) };
}

// One pass over both placeholders: what is put in is never read again, so a name holding a placeholder stays words.
const fill = (text: string, values: Record<TemplateField, string>) => text.replace(/\{client_name\}|\{store_name\}/g, (field) => values[field as TemplateField]);

/**
 * The draft an agreement starts from, with the client's name and the store's
 * name put in, held to readDraft once filled; or why not. The client's name
 * comes back as `name`, so the agreement records and shows the same one.
 */
export function draftFrom(
  t: Pick<AgreementTemplate, "kind" | "title" | "body" | "lines">,
  store: { name: string },
  clientName: string,
  currency: Currency,
): { ok: true; draft: { kind: AgreementKind; name: string; title: string; body: string; lines: TemplateLine[] } } | { ok: false; problem: TemplateProblem } {
  if (typeof clientName === "string" && clientName.trim().length > MAX_NAME) return { ok: false, problem: { why: "client_name_long" } };
  const v: Record<TemplateField, string> = { "{client_name}": clean(clientName, MAX_NAME), "{store_name}": clean(store.name, 200) };
  const title = oneLine(t.title, 200);
  const body = block(t.body, 20_000);
  const lines = t.lines.map((l) => ({ ...l, text: oneLine(l.text, 200) }));
  const uses = (field: TemplateField) => [title, body, ...lines.map((l) => l.text)].some((text) => text.includes(field));
  if (uses("{client_name}") && !v["{client_name}"]) return { ok: false, problem: { why: "client_name" } };
  if (uses("{store_name}") && !v["{store_name}"]) return { ok: false, problem: { why: "store_name" } };
  const filled = { kind: t.kind, title: fill(title, v), body: fill(body, v), lines: lines.map((l) => ({ ...l, text: fill(l.text, v) })) };
  const read = readDraft(asDraftBody(filled), currency);
  if (!read.ok) return { ok: false, problem: { why: "draft", problem: read.problem, ...(read.line !== undefined ? { line: read.line } : {}) } };
  return { ok: true, draft: { ...filled, name: v["{client_name}"] } };
}
