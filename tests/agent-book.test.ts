/**
 * 631 [AA1], step (c), the storage unit: the store's book of the agent's
 * proposals (lib/agent-book.ts), on the Redis stub with a synthetic store.
 * A proposal is kept and read back; a confirmation carries out each one the
 * rules let through, once, and keeps it in the history; one that fails stays
 * waiting; a decline takes it off; an undo puts back the "before" through
 * the caller and only once; a book that cannot be read is an error, never
 * an empty book; a second change while one is under way is refused.
 */
import { claimHandle, ensureStatsId } from "@/lib/store";
import { BookBusy, addProposal, changeBook, confirmProposals, declineProposal, parseBook, readBook, undoDone } from "@/lib/agent-book";
import type { Json, ProposalKind } from "@/lib/agent-proposal-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const FAQ: ProposalKind = { name: "page.faq", scope: "draft", undo: true, maxBytes: 10_000 };
const EMAIL: ProposalKind = { name: "email.send", scope: "execute", undo: false, maxBytes: 10_000 };
const KINDS = new Map([FAQ, EMAIL].map((k) => [k.name, k]));
const NOW = 1_800_000_000_000;
const asked = { by: "mcp" as const, who: "key_1" };

async function main(): Promise<void> {
  redis.clear();
  const owner = "agent-book@example.com";
  await claimHandle(owner, "agentbook", "Agent Book", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  const store = { ...ROOM, statsId };
  // What the store holds now, as the tools would read it.
  const live: Record<string, Json> = { prod000001: ["Old question"] };

  part("Kept and read back");
  is("an empty book to start", await readBook(statsId, NOW), { waiting: [], history: [] });
  const made = await addProposal(store, FAQ, { target: "prod000001", before: live.prod000001, after: ["New question"], asked }, NOW);
  is("a proposal is kept", made.ok ? (await readBook(statsId, NOW)).waiting.map((p) => [p.kind, p.target]) : made.error, [["page.faq", "prod000001"]]);
  is("no change is refused by the rules", (await addProposal(store, FAQ, { target: "prod000002", before: 1, after: 1, asked }, NOW)).ok, false);
  const id = made.ok ? made.proposal.id : "";

  part("Confirmed: carried out once, kept in the history");
  const applied: string[] = [];
  const apply = async (p: { id: string; target: string; after: Json }) => {
    applied.push(p.id);
    live[p.target] = p.after;
    return true;
  };
  const first = await confirmProposals(store, [id], KINDS, (p) => live[p.target] ?? null, apply, owner, NOW + 1);
  is("carried out", [first.done, applied], [[id], [id]]);
  const book = await readBook(statsId, NOW + 2);
  is("in the history, nothing waiting", [book.waiting.length, book.history.map((d) => [d.id, d.confirmed.who])], [0, [[id, owner]]]);
  const again = await confirmProposals(store, [id], KINDS, (p) => live[p.target] ?? null, apply, owner, NOW + 3);
  is("confirmed again: unknown, never carried out twice", [again.done, again.refused.map((r) => r.why), applied.length], [[], ["unknown"], 1]);

  part("A failure stays waiting; a decline takes it off");
  const second = await addProposal(store, FAQ, { target: "prod000003", before: null, after: ["Q"], asked }, NOW + 4);
  const sid = second.ok ? second.proposal.id : "";
  const failed = await confirmProposals(store, [sid], KINDS, () => null, async () => false, owner, NOW + 5);
  is("could not be carried out: failed, still waiting", [failed.refused, (await readBook(statsId, NOW + 6)).waiting.map((p) => p.id)], [[{ id: sid, why: "failed" }], [sid]]);
  is("declined", [await declineProposal(store, sid, NOW + 7), (await readBook(statsId, NOW + 8)).waiting.length], [true, 0]);

  part("Undo, through the caller, once");
  const restored: Json[] = [];
  const undo = await undoDone(store, id, (d) => live[d.target] ?? null, async (d, value) => {
    restored.push(value);
    live[d.target] = value;
    return true;
  }, owner, NOW + 9);
  is("the before is put back", [undo, restored], [{ ok: true }, [["Old question"]]]);
  is("a second undo is refused", (await undoDone(store, id, (d) => live[d.target] ?? null, async () => true, owner, NOW + 10)).ok, false);

  part("Never an empty book by mistake; one change at a time");
  is("a book that does not read is not taken for an empty one", [parseBook("{"), parseBook(JSON.stringify({ waiting: [{ id: 1 }], history: [] }))], [null, null]);
  await redis.pipeline([["SET", `nl:agent:book:${statsId}`, "{broken"]]);
  let threw = false;
  await readBook(statsId, NOW).catch(() => {
    threw = true;
  });
  is("reading a broken book is an error", threw, true);
  const store2 = { ...ROOM, statsId: "a".repeat(32) };
  let busy = false;
  await changeBook(store2, async () => {
    await changeBook(store2, () => ({ book: null, result: 0 }), NOW).catch((e) => {
      busy = e instanceof BookBusy;
    });
    return { book: null, result: 0 };
  }, NOW);
  is("a second change while one is under way is refused", busy, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
