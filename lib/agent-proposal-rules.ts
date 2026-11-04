/**
 * The rules of what an AI agent may change in a store: 631 [AA1], step (c),
 * unit 2 (owner, 2 November 2026, 02h15 Fortaleza).
 *
 * The agent never changes a store by itself. It prepares a change as a
 * proposal holding what is there now ("before") and what it would become
 * ("after"), the creator sees both side by side, and only the creator's
 * confirmation carries it out. Every confirmed change goes into a history,
 * "What the AI did", with who asked, when, who confirmed and what changed,
 * and with an undo wherever the kind of change allows one.
 *
 * Only rules live here, as pure functions of a store's book of proposals and
 * the time: no storage, no route, no screen. Keeping the book is the next
 * unit (it needs its key family registered in tests/store-data-registry.ts);
 * the tools that make proposals come after (docs/ai-agent-store.md). So the
 * same rules hold whoever asks: the assistant in the studio, the creator's
 * Claude or ChatGPT over MCP, or the command line.
 *
 * What the rules guarantee:
 *
 *   - Nothing is carried out without a confirmation, and a confirmation is
 *     only for proposals that are waiting and not past WAITING_DAYS.
 *   - A change the store no longer matches is not carried out: if what is
 *     there now differs from the proposal's "before" (the creator, a teammate
 *     or another proposal changed it meanwhile), it is refused as
 *     "changed_since", so a confirmation never lands on a state its preview
 *     did not show.
 *   - "execute" changes (they reach people outside the studio or cannot be
 *     taken back: an email, an answer to a buyer, an erasure) are confirmed
 *     one at a time, never in a batch; "draft" changes may be confirmed
 *     together, up to BATCH_MAX at once.
 *   - Undo puts back exactly the "before", only for a kind that allows it,
 *     only once, only within UNDO_DAYS, and only while the store still holds
 *     exactly the "after": an undo never erases a later change.
 *   - The book is bounded: WAITING_MAX proposals waiting, each at most its
 *     kind's maxBytes (never past PROPOSAL_MAX_BYTES), HISTORY_MAX entries
 *     kept at most HISTORY_DAYS.
 *
 * The agent never moves money (631 (c)); which studio actions may have a kind
 * at all is lib/agent-coverage.ts (a "never" action has none).
 */

export const WAITING_MAX = 50;
export const WAITING_DAYS = 7;
export const BATCH_MAX = 20;
export const HISTORY_MAX = 200;
export const HISTORY_DAYS = 90;
export const UNDO_DAYS = 30;
/** No kind may hold a proposal larger than this, "before" and "after" together. */
export const PROPOSAL_MAX_BYTES = 120_000;

const DAY_MS = 86_400_000;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One kind of change, e.g. the store page's questions and answers. */
export type ProposalKind = {
  /** Stable name, e.g. "page.faq". */
  name: string;
  /** "draft": may be confirmed in a batch; "execute": one at a time. */
  scope: "draft" | "execute";
  /** Whether a confirmed change of this kind can be put back. */
  undo: boolean;
  /** "before" and "after" together, as JSON, at most this many bytes. */
  maxBytes: number;
};

/** Who asked the agent: the way in and who it was (an API key's id, or the person signed in to the studio). */
export type Asked = { by: "assistant" | "mcp" | "cli"; who: string };

export type Proposal = {
  id: string;
  kind: string;
  /** What in the store it changes, e.g. a product's id; "" for the store itself. */
  target: string;
  before: Json;
  after: Json;
  asked: Asked;
  at: number;
};

export type Done = Proposal & {
  confirmed: { who: string; at: number };
  undo: boolean;
  undone?: { who: string; at: number };
};

export type Book = { waiting: Proposal[]; history: Done[] };

export const emptyBook = (): Book => ({ waiting: [], history: [] });

/** JSON with its keys in order, so two equal values always read the same. */
export function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sameValue = (a: Json, b: Json): boolean => canonical(a) === canonical(b);

// TextEncoder rather than Buffer, so a screen in the browser can read these rules too.
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** Waiting proposals still inside WAITING_DAYS, and history inside HISTORY_DAYS and HISTORY_MAX, newest first. */
export function tidy(book: Book, now: number): Book {
  return {
    waiting: book.waiting.filter((p) => now - p.at < WAITING_DAYS * DAY_MS),
    history: book.history
      .filter((d) => now - d.confirmed.at < HISTORY_DAYS * DAY_MS)
      .sort((a, b) => b.confirmed.at - a.confirmed.at)
      .slice(0, HISTORY_MAX),
  };
}

export type ProposeError = "bad_kind" | "no_change" | "too_big" | "too_many";

/**
 * Adds a proposal. A waiting proposal of the same kind for the same target is
 * replaced (the newer preparation is the one the creator sees), and its id is
 * returned as `replaced`.
 */
export function propose(
  book: Book,
  kind: ProposalKind,
  input: { id: string; target: string; before: Json; after: Json; asked: Asked },
  now: number,
): { ok: true; book: Book; proposal: Proposal; replaced: string | null } | { ok: false; error: ProposeError } {
  if (!kind.name || kind.maxBytes <= 0 || kind.maxBytes > PROPOSAL_MAX_BYTES) return { ok: false, error: "bad_kind" };
  if (sameValue(input.before, input.after)) return { ok: false, error: "no_change" };
  if (bytes(canonical(input.before)) + bytes(canonical(input.after)) > kind.maxBytes) return { ok: false, error: "too_big" };
  const tidied = tidy(book, now);
  const old = tidied.waiting.find((p) => p.kind === kind.name && p.target === input.target) ?? null;
  const others = tidied.waiting.filter((p) => p !== old);
  if (others.length >= WAITING_MAX) return { ok: false, error: "too_many" };
  const proposal: Proposal = { id: input.id, kind: kind.name, target: input.target, before: input.before, after: input.after, asked: input.asked, at: now };
  return { ok: true, book: { ...tidied, waiting: [...others, proposal] }, proposal, replaced: old?.id ?? null };
}

export type ConfirmRefusal = "unknown" | "unknown_kind" | "changed_since" | "one_at_a_time" | "batch_too_large";

export type ConfirmPlan = { apply: Proposal[]; refused: { id: string; why: ConfirmRefusal }[] };

/**
 * Which of `ids` may be carried out now. `current` reads what the store holds
 * now for a proposal's kind and target; `kinds` names the kinds by name.
 * Nothing is carried out here: the caller applies `apply`, then records each
 * with `recordDone`.
 */
export function planConfirm(
  book: Book,
  ids: string[],
  kinds: ReadonlyMap<string, ProposalKind>,
  current: (proposal: Proposal) => Json,
  now: number,
): ConfirmPlan {
  const unique = [...new Set(ids)];
  const waiting = tidy(book, now).waiting;
  if (unique.length > BATCH_MAX) return { apply: [], refused: unique.map((id) => ({ id, why: "batch_too_large" })) };
  const plan: ConfirmPlan = { apply: [], refused: [] };
  for (const id of unique) {
    const proposal = waiting.find((p) => p.id === id);
    if (!proposal) {
      plan.refused.push({ id, why: "unknown" });
      continue;
    }
    const kind = kinds.get(proposal.kind);
    if (!kind) plan.refused.push({ id, why: "unknown_kind" });
    else if (kind.scope === "execute" && unique.length > 1) plan.refused.push({ id, why: "one_at_a_time" });
    else if (!sameValue(current(proposal), proposal.before)) plan.refused.push({ id, why: "changed_since" });
    else plan.apply.push(proposal);
  }
  return plan;
}

/** After a proposal was carried out: off the waiting list, into the history. */
export function recordDone(book: Book, proposal: Proposal, kind: ProposalKind, who: string, now: number): Book {
  const done: Done = { ...proposal, confirmed: { who, at: now }, undo: kind.undo };
  const tidied = tidy(book, now);
  return tidy({ waiting: tidied.waiting.filter((p) => p.id !== proposal.id), history: [done, ...tidied.history] }, now);
}

/** The creator said no: the proposal is gone, nothing changed. */
export function decline(book: Book, id: string, now: number): { ok: true; book: Book } | { ok: false; error: "unknown" } {
  const tidied = tidy(book, now);
  if (!tidied.waiting.some((p) => p.id === id)) return { ok: false, error: "unknown" };
  return { ok: true, book: { ...tidied, waiting: tidied.waiting.filter((p) => p.id !== id) } };
}

export type UndoRefusal = "unknown" | "cannot_undo" | "already_undone" | "too_old" | "changed_since";

/** Whether a confirmed change may be put back now, and what to put back. */
export function planUndo(book: Book, id: string, current: (done: Done) => Json, now: number): { ok: true; done: Done; restore: Json } | { ok: false; error: UndoRefusal } {
  const done = tidy(book, now).history.find((d) => d.id === id);
  if (!done) return { ok: false, error: "unknown" };
  if (!done.undo) return { ok: false, error: "cannot_undo" };
  if (done.undone) return { ok: false, error: "already_undone" };
  if (now - done.confirmed.at >= UNDO_DAYS * DAY_MS) return { ok: false, error: "too_old" };
  if (!sameValue(current(done), done.after)) return { ok: false, error: "changed_since" };
  return { ok: true, done, restore: done.before };
}

/** After an undo was carried out: the history says so, and it cannot be undone twice. */
export function recordUndone(book: Book, id: string, who: string, now: number): Book {
  const tidied = tidy(book, now);
  return { ...tidied, history: tidied.history.map((d) => (d.id === id ? { ...d, undone: { who, at: now } } : d)) };
}
