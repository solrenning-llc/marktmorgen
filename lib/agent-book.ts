/**
 * The store's book of the AI agent's proposals, kept (631 [AA1], step (c),
 * the storage unit): what is waiting for the creator's confirmation and the
 * history "What the AI did". The rules are lib/agent-proposal-rules.ts; this
 * only keeps the book, one record per store, changed under a lock so two
 * confirmations at once never both carry out the same proposal.
 *
 *   nl:agent:book:<statsId>        the book, as JSON, counted in the store's data room ("agent:book")
 *   nl:agent:book:lock:<statsId>   held while the book is changed, 60 seconds at most
 *
 * The book's size is bounded by the rules (WAITING_MAX proposals waiting,
 * HISTORY_MAX entries, each within its kind's maxBytes) and, before that, by
 * the store's data room: a change that does not fit is refused
 * (DataRoomError), never kept past it. A book that cannot be read is an
 * error, never an empty book, so history is never lost by being overwritten.
 *
 * Nothing here carries a change out: confirm and undo take the function that
 * does it, from the caller that knows the kind (the tools that make proposals
 * come with each kind).
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import {
  type Asked,
  type Book,
  type ConfirmRefusal,
  type Done,
  type Json,
  type Proposal,
  type ProposalKind,
  type ProposeError,
  type UndoRefusal,
  decline,
  emptyBook,
  planConfirm,
  planUndo,
  propose,
  recordDone,
  recordUndone,
  tidy,
} from "@/lib/agent-proposal-rules";

const STATS_ID = /^[0-9a-f]{32}$/;
const LOCK_SECONDS = 60;
const SLOT = "agent:book";
const bookKey = (statsId: string) => `nl:agent:book:${statsId}`;
const lockKey = (statsId: string) => `nl:agent:book:lock:${statsId}`;

/** Another change of the same book is under way: try again in a moment. */
export class BookBusy extends Error {
  constructor() {
    super("the store's agent book is being changed");
    this.name = "BookBusy";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function readProposal(v: unknown): Proposal | null {
  if (!isObject(v) || typeof v.id !== "string" || typeof v.kind !== "string" || typeof v.target !== "string" || typeof v.at !== "number") return null;
  const asked = isObject(v.asked) && (v.asked.by === "assistant" || v.asked.by === "mcp" || v.asked.by === "cli") && typeof v.asked.who === "string" ? (v.asked as Asked) : null;
  if (!asked || !("before" in v) || !("after" in v)) return null;
  return { id: v.id, kind: v.kind, target: v.target, before: v.before as Json, after: v.after as Json, asked, at: v.at };
}

/** The book as kept, or null when what is kept is not a book (never taken for an empty one). */
export function parseBook(raw: unknown): Book | null {
  if (raw === null || raw === undefined) return emptyBook();
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || !Array.isArray(value.waiting) || !Array.isArray(value.history)) return null;
  const waiting = value.waiting.map(readProposal);
  const history = value.history.map((d) => {
    const p = readProposal(d);
    if (!p || !isObject(d) || !isObject(d.confirmed) || typeof d.confirmed.who !== "string" || typeof d.confirmed.at !== "number" || typeof d.undo !== "boolean") return null;
    const undone = isObject(d.undone) && typeof d.undone.who === "string" && typeof d.undone.at === "number" ? { who: d.undone.who, at: d.undone.at } : undefined;
    return { ...p, confirmed: { who: d.confirmed.who, at: d.confirmed.at }, undo: d.undo, ...(undone ? { undone } : {}) } as Done;
  });
  if (waiting.some((p) => !p) || history.some((d) => !d)) return null;
  return { waiting: waiting as Proposal[], history: history as Done[] };
}

/** The store's book now, tidied (expired proposals and old history gone). Throws when it cannot be read. */
export async function readBook(statsId: string, now = Date.now()): Promise<Book> {
  if (!STATS_ID.test(statsId) || !isRedisConfigured()) throw new Error("the agent book is not available");
  const [raw] = await redisPipeline([["GET", bookKey(statsId)]]);
  const book = parseBook(raw);
  if (!book) throw new Error("the agent book could not be read");
  return tidy(book, now);
}

/**
 * Changes the book under the store's lock: `change` gets the book as it is
 * and answers the new one (or null to keep it) and a result. The new book
 * takes its room first; one that does not fit is refused (DataRoomError).
 */
export async function changeBook<T>(store: DataStore & { statsId: string }, change: (book: Book) => Promise<{ book: Book | null; result: T }> | { book: Book | null; result: T }, now = Date.now()): Promise<T> {
  const statsId = store.statsId;
  const owner = randomBytes(8).toString("hex");
  const [held] = await redisPipeline([["SET", lockKey(statsId), owner, "NX", "EX", LOCK_SECONDS]]);
  if (held === null) throw new BookBusy();
  try {
    const book = await readBook(statsId, now);
    const { book: next, result } = await change(book);
    if (next) {
      const json = JSON.stringify(next);
      await needData(store, [{ slot: SLOT, bytes: dataBytes([json], 1), set: true }], now);
      await redisPipeline([["SET", bookKey(statsId), json]]);
    }
    return result;
  } finally {
    // Only our own hold is let go: one that ran out and was taken by another change is left to it.
    const [mine] = await redisPipeline([["GET", lockKey(statsId)]]);
    if (mine === owner) await redisPipeline([["DEL", lockKey(statsId)]]);
  }
}

/** A new proposal's id: 16 random hex characters. */
export const newProposalId = () => randomBytes(8).toString("hex");

/** Puts a proposal in the book (one waiting per kind and target: a newer one replaces it). */
export function addProposal(
  store: DataStore & { statsId: string },
  kind: ProposalKind,
  input: { target: string; before: Json; after: Json; asked: Asked },
  now = Date.now(),
): Promise<{ ok: true; proposal: Proposal; replaced: string | null } | { ok: false; error: ProposeError }> {
  type Made = { ok: true; proposal: Proposal; replaced: string | null } | { ok: false; error: ProposeError };
  return changeBook<Made>(
    store,
    (book) => {
      const made = propose(book, kind, { ...input, id: newProposalId() }, now);
      return made.ok ? { book: made.book, result: { ok: true as const, proposal: made.proposal, replaced: made.replaced } } : { book: null, result: made };
    },
    now,
  );
}

/** Takes a waiting proposal off the book without carrying it out. */
export function declineProposal(store: DataStore & { statsId: string }, id: string, now = Date.now()): Promise<boolean> {
  return changeBook(
    store,
    (book) => {
      const done = decline(book, id, now);
      return done.ok ? { book: done.book, result: true } : { book: null, result: false };
    },
    now,
  );
}

export type Confirmed = { done: string[]; refused: { id: string; why: ConfirmRefusal | "failed" | "terms" }[] };

/**
 * The creator's confirmation: each proposal the rules let through is carried
 * out by `apply`, in order, and written into the history only when it was
 * (apply answers false when it could not be: it stays waiting, said as
 * "failed"; "terms" when its words are not allowed there now, also left
 * waiting, for the creator to decline). All under the lock, so the same proposal is never carried out
 * twice.
 */
export function confirmProposals(
  store: DataStore & { statsId: string },
  ids: string[],
  kinds: ReadonlyMap<string, ProposalKind>,
  current: (proposal: Proposal) => Json,
  apply: (proposal: Proposal) => Promise<boolean | "terms">,
  who: string,
  now = Date.now(),
): Promise<Confirmed> {
  return changeBook(
    store,
    async (book) => {
      const plan = planConfirm(book, ids, kinds, current, now);
      let next = book;
      const result: Confirmed = { done: [], refused: [...plan.refused] };
      for (const proposal of plan.apply) {
        const applied = await apply(proposal);
        if (applied === true) {
          next = recordDone(next, proposal, kinds.get(proposal.kind)!, who, now);
          result.done.push(proposal.id);
        } else result.refused.push({ id: proposal.id, why: applied === "terms" ? "terms" : "failed" });
      }
      return { book: result.done.length ? next : null, result };
    },
    now,
  );
}

/** Puts back a confirmed change, through `restore`, when the rules allow it. */
export function undoDone(
  store: DataStore & { statsId: string },
  id: string,
  current: (done: Done) => Json,
  restore: (done: Done, value: Json) => Promise<boolean>,
  who: string,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; error: UndoRefusal | "failed" }> {
  return changeBook<{ ok: true } | { ok: false; error: UndoRefusal | "failed" }>(
    store,
    async (book) => {
      const plan = planUndo(book, id, current, now);
      if (!plan.ok) return { book: null, result: plan };
      if (!(await restore(plan.done, plan.restore))) return { book: null, result: { ok: false as const, error: "failed" as const } };
      return { book: recordUndone(book, id, who, now), result: { ok: true as const } };
    },
    now,
  );
}
