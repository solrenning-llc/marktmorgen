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
import { type Held, LockBusyError, releaseLock, takeLock } from "@/lib/redis-lock";
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
  sameValue,
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

/** A change to the book whose write Redis did not confirm: it may or may not be kept. */
export class BookWriteUnconfirmed extends Error {
  constructor() {
    super("the agent book's write could not be confirmed");
    this.name = "BookWriteUnconfirmed";
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
  // Exactly one answer, a text or null (no book yet): [] or [undefined] is not "no book", and a waiting proposal is
  // never dropped by writing over a book that could not be read (Codex G on #1929).
  const reply: unknown = await redisPipeline([["GET", bookKey(statsId)]]);
  if (!Array.isArray(reply) || reply.length !== 1 || (reply[0] !== null && typeof reply[0] !== "string")) throw new Error("the agent book could not be read");
  const book = parseBook(reply[0]);
  if (!book) throw new Error("the agent book could not be read");
  return tidy(book, now);
}

/**
 * The book written only while this change still holds the store's lock, in
 * one step (Codex G on #1856): a change whose lock ran out and was taken by
 * another never writes over that one's book. 1 written, 0 not ours.
 */
export const AGENT_BOOK_WRITE = `-- marktmorgen:agent-book-write:v1
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2])
return 1`;

/** Waited for the lock when an applied change is written into the book again (recordAgain). */
const RECORD_WAIT_MS = 2_000;
/** Tries at writing an applied change into the book before it is said as not kept. */
const RECORD_TRIES = 3;

/** The store's lock, only on Redis's exact "OK" (lib/redis-lock.ts takeLock): an unknown answer is never ours. */
async function holdBook(statsId: string, waitMs = 0): Promise<Held> {
  try {
    return await takeLock(lockKey(statsId), LOCK_SECONDS, waitMs);
  } catch (error) {
    if (error instanceof LockBusyError) throw new BookBusy();
    throw error;
  }
}

/** Writes `next` while `held` is still ours: "written", "lost" (not ours any more), or "unknown" (the answer was not exact). */
async function writeBook(store: DataStore & { statsId: string }, held: Held, next: Book, now: number): Promise<"written" | "lost" | "unknown"> {
  const json = JSON.stringify(next);
  await needData(store, [{ slot: SLOT, bytes: dataBytes([json], 1), set: true }], now);
  let reply: unknown;
  try {
    reply = await redisPipeline([["EVAL", AGENT_BOOK_WRITE, 2, held.key, bookKey(store.statsId), held.token, json]]);
  } catch {
    return "unknown";
  }
  if (!Array.isArray(reply) || reply.length !== 1) return "unknown";
  if (reply[0] === 1) return "written";
  if (reply[0] === 0) return "lost";
  return "unknown";
}

/** The book's read was not admitted: the caller's requests did not cover what it weighs, or it could not be measured. Nothing of it was read. */
export class BookReadRefused extends Error {
  constructor() {
    super("the agent book's read was not admitted");
    this.name = "BookReadRefused";
  }
}

/** Decides, once the book is measured under its lock, whether a read of that many bytes may be made (an agent's requests pay for it first). */
export type AdmitBook = (bytes: number) => Promise<boolean>;

/**
 * Changes the book under the store's lock: `change` gets the book as it is
 * and answers the new one (or null to keep it) and a result. The new book
 * takes its room first; one that does not fit is refused (DataRoomError).
 * Nothing outside the book is changed here, so a write that is not
 * confirmed is said as such (BookWriteUnconfirmed) and nothing else is done.
 */
export async function changeBook<T>(store: DataStore & { statsId: string }, change: (book: Book) => Promise<{ book: Book | null; result: T }> | { book: Book | null; result: T }, now = Date.now(), admit?: AdmitBook): Promise<T> {
  const held = await holdBook(store.statsId);
  try {
    // Measured under the lock, where no other change can make it grow, and admitted before it is read (an agent pays first).
    if (admit) {
      const reply: unknown = await redisPipeline([["STRLEN", bookKey(store.statsId)]]);
      const size = Array.isArray(reply) && reply.length === 1 ? reply[0] : null;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || !(await admit(size))) throw new BookReadRefused();
    }
    const book = await readBook(store.statsId, now);
    const { book: next, result } = await change(book);
    if (next && (await writeBook(store, held, next, now)) !== "written") throw new BookWriteUnconfirmed();
    return result;
  } finally {
    // Only our own hold is let go: one that ran out and was taken by another change is left to it.
    await releaseLock(held);
  }
}

/**
 * A change already carried out on the store (a confirmation or an undo) whose
 * book was not written as ours: it is written again, on the book as it is now,
 * under a new hold of the lock (Codex G on #1856). `record` answers the book
 * with the change in it, or the same book when it is there already (a write
 * that landed though its answer was lost, or another change recorded it).
 * Throws BookWriteUnconfirmed when it still cannot be written.
 */
async function recordAgain(store: DataStore & { statsId: string }, record: (book: Book) => Book, now: number): Promise<void> {
  for (let attempt = 0; attempt < RECORD_TRIES; attempt += 1) {
    let held: Held;
    try {
      held = await holdBook(store.statsId, RECORD_WAIT_MS);
    } catch (error) {
      if (error instanceof BookBusy) continue;
      throw error;
    }
    try {
      const book = await readBook(store.statsId, now);
      const next = record(book);
      if (next === book) return;
      if ((await writeBook(store, held, next, now)) === "written") return;
    } finally {
      await releaseLock(held);
    }
  }
  throw new BookWriteUnconfirmed();
}

/** A new proposal's id: 16 random hex characters. */
export const newProposalId = () => randomBytes(8).toString("hex");

/** Puts a proposal in the book (one waiting per kind and target: a newer one replaces it). */
export function addProposal(
  store: DataStore & { statsId: string },
  kind: ProposalKind,
  input: { target: string; before: Json; after: Json; asked: Asked },
  now = Date.now(),
  admit?: AdmitBook,
): Promise<{ ok: true; proposal: Proposal; replaced: string | null } | { ok: false; error: ProposeError }> {
  type Made = { ok: true; proposal: Proposal; replaced: string | null } | { ok: false; error: ProposeError };
  return changeBook<Made>(
    store,
    (book) => {
      const made = propose(book, kind, { ...input, id: newProposalId() }, now);
      return made.ok ? { book: made.book, result: { ok: true as const, proposal: made.proposal, replaced: made.replaced } } : { book: null, result: made };
    },
    now,
    admit,
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
export async function confirmProposals(
  store: DataStore & { statsId: string },
  ids: string[],
  kinds: ReadonlyMap<string, ProposalKind>,
  current: (proposal: Proposal) => Json,
  apply: (proposal: Proposal) => Promise<boolean | "terms" | "changed">,
  who: string,
  now = Date.now(),
): Promise<Confirmed> {
  const held = await holdBook(store.statsId);
  const applied: Proposal[] = [];
  let result: Confirmed;
  try {
    const book = await readBook(store.statsId, now);
    const plan = planConfirm(book, ids, kinds, current, now);
    let next = book;
    result = { done: [], refused: [] };
    for (const refusal of plan.refused) {
      // Already carried out by an earlier confirmation whose history could not be written (Codex G on #1856): the store
      // holds exactly what the proposal asked for, so it is recorded as done, never carried out again. Not for a kind
      // that acts outside the store (scope "execute"), whose effect the store does not hold.
      const proposal = refusal.why === "changed_since" ? tidy(book, now).waiting.find((p) => p.id === refusal.id) : undefined;
      const kind = proposal ? kinds.get(proposal.kind) : undefined;
      if (proposal && kind && kind.scope !== "execute" && sameValue(current(proposal), proposal.after)) {
        next = recordDone(next, proposal, kind, who, now);
        result.done.push(proposal.id);
        applied.push(proposal);
      } else result.refused.push(refusal);
    }
    for (const proposal of plan.apply) {
      const done = await apply(proposal);
      if (done === true) {
        next = recordDone(next, proposal, kinds.get(proposal.kind)!, who, now);
        result.done.push(proposal.id);
        applied.push(proposal);
      } else result.refused.push({ id: proposal.id, why: done === "terms" ? "terms" : done === "changed" ? "changed_since" : "failed" });
    }
    if (!applied.length || (await writeBook(store, held, next, now).catch(() => "unknown" as const)) === "written") return result;
  } finally {
    await releaseLock(held);
  }
  // Carried out, but the book was not written as ours: each applied proposal still waiting on the book as it is now is
  // recorded as done there, so the change and its history agree, and another change's history is kept.
  await recordAgain(
    store,
    (book) => applied.reduce((b, p) => (b.waiting.some((w) => w.id === p.id) ? recordDone(b, p, kinds.get(p.kind)!, who, now) : b), book),
    now,
  );
  return result;
}

/**
 * Puts back a confirmed change, through `restore`, when the rules allow it.
 * The history says undone first (Codex G on #1856): the change is put back
 * only once that is written as ours, so a book that cannot be written never
 * hides a restore. A restore that did not happen takes the mark back, on the
 * book as it is now; where even that cannot be written, the history says
 * undone though nothing was put back (BookWriteUnconfirmed), never the
 * other way round. A restore whose outcome is unknown (`restore` answering
 * "unknown" or throwing) keeps the mark and is said as not confirmed.
 */
export async function undoDone(
  store: DataStore & { statsId: string },
  id: string,
  current: (done: Done) => Json,
  restore: (done: Done, value: Json) => Promise<boolean | "changed" | "unknown">,
  who: string,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; error: UndoRefusal | "failed" }> {
  const held = await holdBook(store.statsId);
  let answer: { ok: true } | { ok: false; error: UndoRefusal | "failed" };
  try {
    const book = await readBook(store.statsId, now);
    const plan = planUndo(book, id, current, now);
    if (!plan.ok) return plan;
    const marked = await writeBook(store, held, recordUndone(book, id, who, now), now).catch(() => "unknown" as const);
    if (marked === "lost") return { ok: false, error: "failed" };
    if (marked === "written") {
      // A restore whose answer was lost may have been made (Codex G on #1856): unknown, never taken for "not made".
      const restored = await restore(plan.done, plan.restore).catch(() => "unknown" as const);
      if (restored === true) return { ok: true };
      // The mark stays, so a restore that was made is never left out of the history; said as not confirmed.
      if (restored === "unknown") throw new BookWriteUnconfirmed();
      // Changed again between the check and the write: refused as the rules refuse it, nothing put back.
      answer = { ok: false, error: restored === "changed" ? "changed_since" : "failed" };
    } else answer = { ok: false, error: "failed" };
  } finally {
    await releaseLock(held);
  }
  // Nothing was put back: this undo's own mark is taken back where the book holds it (a mark that was never written
  // is read as absent, and nothing is written).
  await recordAgain(store, (book) => withoutUndone(book, id, who, now), now);
  return answer;
}

/** The book without this undo's own mark on `id` (the same book when it does not hold it). */
function withoutUndone(book: Book, id: string, who: string, at: number): Book {
  const entry = book.history.find((d) => d.id === id);
  if (!entry?.undone || entry.undone.who !== who || entry.undone.at !== at) return book;
  return {
    ...book,
    history: book.history.map((d) => {
      if (d.id !== id) return d;
      const kept: Done = { ...d };
      delete kept.undone;
      return kept;
    }),
  };
}
