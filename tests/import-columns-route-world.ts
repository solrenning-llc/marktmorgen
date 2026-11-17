/**
 * The world of tests/import-columns-route.test.ts: the studio guard and the suggestion are synthetic, the route's own
 * readers (isMapKind, readHeader, readGuess) are the real ones, and the rate limit and the cost pause run as written
 * on the in-memory store. Nothing reaches a model, a session or a real store.
 */
import type { SuggestOutcome } from "../lib/csv-map-ai";
export { isMapKind, readGuess, readHeader } from "../lib/csv-map-ai";

type Asked = { sid: string; kind: string; header: readonly string[]; guess: Record<string, number> };
export const state: {
  store: Record<string, unknown>;
  body: Record<string, unknown>;
  denial: Response | null;
  outcome: SuggestOutcome;
  throws: boolean;
  checks: { need: unknown; max: unknown; act: string | null }[];
  asked: Asked[];
} = { store: {}, body: {}, denial: null, outcome: { ok: false, why: "off" }, throws: false, checks: [], asked: [] };

export function reset(sid: string, body: Record<string, unknown>): void {
  state.store = { sid, statsId: sid, tier: "pro", subscriptionActive: true, renewalUnpaidSince: 0, planDisputes: [] };
  state.body = body;
  state.denial = null;
  state.outcome = { ok: false, why: "off" };
  state.throws = false;
  state.checks = [];
  state.asked = [];
}

export async function guardStoreWrite(_request: unknown, need: unknown, max: unknown, act?: (body: Record<string, unknown>) => string) {
  state.checks.push({ need, max, act: act ? act(state.body) : null });
  return state.denial ? { ok: false as const, response: state.denial } : { ok: true as const, store: state.store, body: state.body };
}

export async function suggestColumns(store: { sid: string }, kind: string, header: readonly string[], guess: Record<string, number>): Promise<SuggestOutcome> {
  state.asked.push({ sid: store.sid, kind, header, guess });
  if (state.throws) throw new Error("synthetic failure inside the suggestion");
  return state.outcome;
}
