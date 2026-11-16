/**
 * Rule 24 in the contact imports (CX-123; the coordinator's sweep of `Number(x) || 0`, 16 November 2026).
 *
 * importContacts, importContactRows and previewContactRows read three replies before they decide anything: the
 * list's size (HLEN), the rows already kept for the addresses (HMGET) and the store's deleted people (the suppression
 * prints). Each was read loosely:
 *   - an unknown size was 0, so the room was the whole MAX_LEADS and an import could pass the cap;
 *   - unknown rows were "not on the list", so importContacts (a plain HSET) wrote a contact who had unsubscribed
 *     back as agreeing;
 *   - unknown prints were "not deleted", so a person erased from the store was imported again.
 * Now each is read exactly, and anything else throws UnknownReplyError with nothing written.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts).
 */
import { store as redis } from "./redis-stub";
import { importContactRows, importContacts, previewContactRows } from "@/lib/contacts";
import { leadsKey } from "@/lib/contact-rules";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { done, is, part } from "./check";

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
let bend: ((commands: Cmd[], real: unknown[]) => unknown[]) | null = null;
const writes: Cmd[] = [];
redis.pipeline = (async (commands: Cmd[]) => {
  for (const c of commands) if (["HSET", "EVAL", "EVALSHA", "INCRBY"].includes(String(c[0]))) writes.push(c);
  const real = await original(commands);
  return bend ? bend(commands, real as unknown[]) : real;
}) as typeof redis.pipeline;

/** Bends the reply of the first command named `word` in a pipeline that holds it. */
const bendReply = (word: string, value: unknown) => (commands: Cmd[], real: unknown[]) =>
  commands.some((c) => c[0] === word) ? real.map((r, i) => (commands[i][0] === word ? value : r)) : real;

const outcome = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "answered";
  } catch {
    return "unknown";
  }
};

async function main(): Promise<void> {
  const OWNER = "r24-contacts@example.com";
  await claimHandle(OWNER, "r24contacts", "R24 Contacts", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await ensureStoreId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const list = store.listId!;
  const rows = [{ email: "new@example.com", name: "", tags: [] }];

  const cases: [string, string, unknown][] = [
    ["the list's size", "HLEN", "QUEUED"],
    ["the rows already kept", "HMGET", "QUEUED"],
  ];
  for (const [what, word, value] of cases) {
    for (const [name, run] of [
      ["importContacts", () => importContacts(list, ["new@example.com"], store)],
      ["importContactRows", () => importContactRows(list, rows, store)],
      ["previewContactRows", () => previewContactRows(list, rows)],
    ] as [string, () => Promise<unknown>][]) {
      part(`${name}: ${what} that does not read`);
      writes.length = 0;
      bend = bendReply(word, value);
      is("unknown, never a decision", await outcome(run), "unknown");
      bend = null;
      is("nothing written", writes.filter((c) => String(c[1]).startsWith(leadsKey(list)) || String(c[0]) === "INCRBY").length, 0);
    }
  }

  part("The deleted people's prints that do not read: unknown, never 'not deleted'");
  for (const [name, run] of [
    ["importContacts", () => importContacts(list, ["new@example.com"], store)],
    ["importContactRows", () => importContactRows(list, rows, store)],
    ["previewContactRows", () => previewContactRows(list, rows)],
  ] as [string, () => Promise<unknown>][]) {
    writes.length = 0;
    // The suppression read is the HMGET of the store's prints: the second HMGET of the pipeline.
    bend = (commands, real) => {
      const at = commands.map((c, i) => [c, i] as const).filter(([c]) => c[0] === "HMGET" && String(c[1]).startsWith("nl:erased:"));
      if (!at.length) return real;
      return real.map((r, i) => (at.some(([, j]) => j === i) ? "QUEUED" : r));
    };
    is(`${name}: unknown`, await outcome(run), "unknown");
    bend = null;
    is(`${name}: nothing written`, writes.filter((c) => String(c[1]).startsWith(leadsKey(list))).length, 0);
  }

  part("Control: real replies still import");
  writes.length = 0;
  is("importContacts answers", await outcome(() => importContacts(list, ["one@example.com"], store)), "answered");
  is("importContactRows answers", await outcome(() => importContactRows(list, [{ email: "two@example.com", name: "", tags: [] }], store)), "answered");
  is("previewContactRows answers", await outcome(() => previewContactRows(list, rows)), "answered");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
