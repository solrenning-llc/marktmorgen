/**
 * Codex G on #1929 (inherited from #1856): a GET of the book answered [] or
 * [undefined] read as an empty book, and a SET of the book that was not
 * applied still answered the proposal as kept. Only an exact [null] is no
 * book, and only an exact ["OK"] is a book written; anything else throws,
 * and a waiting proposal is never dropped by an unknown read.
 */
import { claimHandle, ensureStatsId } from "@/lib/store";
import { addProposal, readBook } from "@/lib/agent-book";
import type { ProposalKind } from "@/lib/agent-proposal-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const FAQ: ProposalKind = { name: "page.faq", scope: "draft", undo: true, maxBytes: 10_000 };
const NOW = 1_800_000_000_000;
const asked = { by: "mcp" as const, who: "key_1" };

async function main(): Promise<void> {
  redis.clear();
  const owner = "agent-book-envelope@example.com";
  await claimHandle(owner, "agentbookenv", "Agent Book Envelope", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  const store = { ...ROOM, statsId };
  const bookKey = (raw: unknown) => Array.isArray(raw) && raw[0] === "GET" && String(raw[1]).includes(statsId) && !String(raw[1]).includes("lock");
  const base = redis.pipeline.bind(redis);
  const kept = await addProposal(store, FAQ, { target: "prod000001", before: ["Old"], after: ["First"], asked }, NOW);
  is("a first proposal is kept", kept.ok, true);

  part("An unknown read of the book is not an empty book");
  for (const [name, reply] of [["[]", []], ["[undefined]", [undefined]], ["[true]", [true]], ["two answers", [null, null]]] as [string, unknown[]][]) {
    redis.pipeline = async (batch) => (batch.length === 1 && bookKey(batch[0]) ? (reply as unknown[]) : base(batch));
    let read: string;
    try {
      read = JSON.stringify(await readBook(statsId, NOW));
    } catch {
      read = "unreadable";
    }
    const added = await addProposal(store, FAQ, { target: "prod000002", before: ["Old"], after: [`Second ${name}`], asked }, NOW).then((r) => (r.ok ? "kept" : "refused"), () => "refused");
    redis.pipeline = base;
    is(`GET answering ${name}: the book is unreadable, and nothing is written over it`, [read, added, (await readBook(statsId, NOW)).waiting.map((p) => p.target)], ["unreadable", "refused", ["prod000001"]]);
  }

  part("A write of the book that is not confirmed is not a proposal kept");
  for (const [name, reply] of [["[]", []], ["[null]", [null]], ["[0]", [0]]] as [string, unknown[]][]) {
    redis.pipeline = async (batch) => (batch.length === 1 && Array.isArray(batch[0]) && batch[0][0] === "SET" && String(batch[0][1]).includes(statsId) && !String(batch[0][1]).includes("lock") ? (reply as unknown[]) : base(batch));
    const added = await addProposal(store, FAQ, { target: "prod000003", before: ["Old"], after: [`Third ${name}`], asked }, NOW).then((r) => (r.ok ? "kept" : "refused"), () => "unconfirmed");
    redis.pipeline = base;
    is(`SET answering ${name} (not applied): never answered as kept`, [added, (await readBook(statsId, NOW)).waiting.map((p) => p.target)], ["unconfirmed", ["prod000001"]]);
  }
  is("and a confirmed write still keeps it", (await addProposal(store, FAQ, { target: "prod000003", before: ["Old"], after: ["Third"], asked }, NOW)).ok, true);
  done();
}

void main();
