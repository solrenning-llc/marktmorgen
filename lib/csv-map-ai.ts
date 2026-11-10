/**
 * An AI suggestion of which column is which, for one file a creator is
 * bringing in (unit 2; the rules are lib/csv-map-ai-rules.ts). Server only.
 *
 * The browser reads the file (lib/csv.ts) and sends only its first row's
 * names and the guess it made from them (guessColumn); no cell of any row is
 * ever sent here. When the guess left a field open:
 *
 *   - the store must have the writing help on (aiAvailableFor: a paid Studio
 *     or Scale plan whose AI budget is funded), else nothing is asked;
 *   - the file's first row must be clearly a header (clearHeader): a file
 *     with none has a person in that row, and then nothing is sent;
 *   - the request is the rules' own (mapRequest), and askModel (lib/ai.ts)
 *     reserves its most possible cost in the store's monthly AI budget
 *     (reserveAiSpend, from lib/spend-cost-table.ts) before the provider is
 *     asked; a budget that refuses, a cost that cannot be bounded, or a call
 *     that fails, and nothing is suggested;
 *   - the answer is read in its exact shape (readMapAnswer) or set aside.
 *
 * Whatever happens, the guess from the names stands, and nothing is applied:
 * the creator confirms each suggested column on the import screen
 * (components/import-column-suggest.tsx). Nothing is kept: neither the names
 * nor the answer.
 */
import { MAX_COLUMNS, type Guess, type MapKind, MAP_FIELDS, mapHoldMicroUsd, mapRequest, needsModel, readMapAnswer, suggestedMapping } from "@/lib/csv-map-ai-rules";
import { aiAvailableFor, askModel } from "@/lib/ai";
import type { Store } from "@/lib/store";

export type SuggestOutcome =
  | { ok: true; columns: ReturnType<typeof suggestedMapping>["columns"] }
  | { ok: false; why: "off" | "not_needed" | "no_header" | "cost_unknown" | "failed" | "unreadable" };

/** The kinds a suggestion is for. */
export const isMapKind = (value: unknown): value is MapKind => typeof value === "string" && Object.hasOwn(MAP_FIELDS, value);

/** The model call, as askModel makes it: reserved first, the answer's text or null. Replaced in tests. */
export type Ask = (store: Store, system: string, prompt: string, maxTokens: number, model: string) => Promise<string | null>;

/** What a suggestion needs from the rest of the app: the model call (askModel, which reserves first) and whether the writing help is on. Replaced in tests. */
export type SuggestDeps = { ask: Ask; available: (store: Store, now: number) => boolean };
const LIVE: SuggestDeps = { ask: askModel, available: aiAvailableFor };

/** Suggests columns for the fields the guess left open; never applies one. */
export async function suggestColumns(store: Store, kind: MapKind, header: readonly string[], guess: Guess, deps: SuggestDeps = LIVE, now = Date.now()): Promise<SuggestOutcome> {
  const columns = Math.min(header.length, MAX_COLUMNS);
  if (!needsModel(kind, guess, columns)) return { ok: false, why: "not_needed" };
  if (!deps.available(store, now)) return { ok: false, why: "off" };
  if (mapHoldMicroUsd() === null) return { ok: false, why: "cost_unknown" };
  // A first row that is not clearly a header may be a person: nothing of it is sent (review of #3555).
  const request = mapRequest(kind, header);
  if (!request) return { ok: false, why: "no_header" };
  let text: string | null;
  try {
    text = await deps.ask(store, request.system, request.prompt, request.maxTokens, request.model);
  } catch (error) {
    console.error("suggesting import columns failed", error);
    return { ok: false, why: "failed" };
  }
  if (!text) return { ok: false, why: "failed" };
  const answer = readMapAnswer(kind, columns, text);
  if (!answer) return { ok: false, why: "unreadable" };
  return { ok: true, columns: suggestedMapping(kind, guess, answer).columns };
}

/** The guess the browser sent, read in its exact shape: each of the kind's fields a column number, -1 for none. Null otherwise. */
export function readGuess(kind: MapKind, raw: unknown, columns: number): Guess | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const fields = Object.keys(MAP_FIELDS[kind]);
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length !== fields.length || !entries.every(([k]) => fields.includes(k))) return null;
  const out: Guess = {};
  for (const [field, value] of entries) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -1 || value >= columns) return null;
    out[field] = value;
  }
  return out;
}

/** The header the browser sent: a list of names, each text. Null otherwise. Longer lists are cut by the rules. */
export function readHeader(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 500) return null;
  if (!raw.every((name) => typeof name === "string" && name.length <= 1_000)) return null;
  return raw as string[];
}
