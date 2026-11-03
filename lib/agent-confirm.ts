/**
 * The creator's side of the agent's proposals (631 [AA1] (c)): confirm,
 * decline and undo, each carried out by the proposal's kind
 * (lib/agent-kinds.ts) under the book's lock (lib/agent-book.ts). Kept out of
 * the route so the studio and the tests use the same steps.
 */
import type { Json } from "@/lib/agent-proposal-rules";
import { AGENT_KINDS } from "@/lib/agent-kinds";
import { type Confirmed, confirmProposals, declineProposal, readBook, undoDone } from "@/lib/agent-book";
import type { Store } from "@/lib/store";

/** What the store holds now for each proposal or done change, read before the lock (the rules compare it with "before"/"after"). */
async function currentOf(store: Store, items: { id: string; kind: string; target: string }[]): Promise<Map<string, Json>> {
  const out = new Map<string, Json>();
  for (const item of items) {
    const kind = AGENT_KINDS.get(item.kind);
    if (kind) out.set(item.id, await kind.current(store, item.target));
  }
  return out;
}

/** Confirms these proposals for the creator `who` (their address); `ref` is the store as studio writes name it. */
export async function confirmFor(store: Store & { statsId: string }, ref: string, ids: string[], who: string): Promise<Confirmed> {
  const book = await readBook(store.statsId);
  const asked = book.waiting.filter((p) => ids.includes(p.id));
  const now = await currentOf(store, asked);
  return confirmProposals(
    store,
    ids,
    AGENT_KINDS,
    (p) => (now.has(p.id) ? (now.get(p.id) as Json) : null),
    async (p) => (await AGENT_KINDS.get(p.kind)?.write(store, ref, p.target, p.after)) === true,
    who,
  );
}

export function declineFor(store: Store & { statsId: string }, id: string): Promise<boolean> {
  return declineProposal(store, id);
}

/** Puts back a confirmed change, when its kind allows and nothing changed it since. */
export async function undoFor(store: Store & { statsId: string }, ref: string, id: string, who: string) {
  const book = await readBook(store.statsId);
  const done = book.history.filter((d) => d.id === id);
  const now = await currentOf(store, done);
  return undoDone(
    store,
    id,
    (d) => (now.has(d.id) ? (now.get(d.id) as Json) : null),
    async (d, value) => (await AGENT_KINDS.get(d.kind)?.write(store, ref, d.target, value)) === true,
    who,
  );
}
