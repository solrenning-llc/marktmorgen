/**
 * Sweep A3 proof (CX-123 rules 24, 28 and 30), synthetic only: the in-memory Redis double. lib/inbox.ts:
 *
 * 1. readInbox, lines 350-353: the MGET of the conversations answering in an unknown shape is read as "every
 *    record has gone" (`values = []`, so every id is `gone`) and each id is ZREMoved from the store's index. One
 *    bad reply empties the studio's inbox for good: the records stay until they expire, but nothing lists them,
 *    and forgetInboxPerson (which walks the same index) can no longer find them to erase a person.
 * 2. forgetInboxPerson, lines 541-552: the index read (ZREVRANGE) or the MGET in an unknown shape is "this person
 *    wrote nothing": it answers 0 and never throws, so lib/person-erasure.ts counts the inbox as erased while
 *    the person's messages are kept. lib/learn.ts forgetLearnerPerson (lines 949-964) and lib/erasure-index.ts
 *    forgetNoted already throw UnknownReplyError for this (rule 30).
 */
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { fileContact, forgetInboxPerson, readInbox } from "@/lib/inbox";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const malform = (verb: string) => {
  redis.pipeline = (async (commands: Command[]) => (commands.length === 1 && commands[0][0] === verb ? [{ unexpected: true }] : real(commands))) as typeof redis.pipeline;
};
const restore = () => {
  redis.pipeline = real;
};
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "sweepa3inbox@example.com";
  await claimHandle(OWNER, "sweepinbox", "Sweep Inbox", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_SweepInbox001", subscriptionId: "sub_SweepInbox001", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  for (const who of ["ana@example.com", "ben@example.com"]) {
    if (!(await fileContact({ store, email: who, name: who.slice(0, 3), text: "Hello, is the guide a PDF?" }))) throw new Error("not filed");
  }
  const statsId = store.statsId!;
  const index = async () => (await real([["ZCARD", `nl:inbox:${statsId}:all`]]))[0];

  part("1. readInbox: healthy control");
  is("two conversations listed, index intact", [(await readInbox(statsId)).length, await index()], [2, 2]);

  part("1. DEFECT: the MGET of the conversations answers in an unknown shape");
  const ids = (await real([["ZREVRANGE", `nl:inbox:${statsId}:all`, 0, -1]]))[0] as string[];
  malform("MGET");
  const shown = await readInbox(statsId);
  restore();
  is("DEFECT: none shown, and every id was ZREMoved from the index", [shown.length, await index()], [0, 0]);
  const records = await real(ids.map((id) => ["EXISTS", `nl:inbox:${statsId}:c:${id}`]));
  is("DEFECT: both records still exist, but nothing lists them now", [records, (await readInbox(statsId)).length], [[1, 1], 0]);

  part("2. forgetInboxPerson: healthy control");
  redis.clear();
  await claimHandle(OWNER, "sweepinbox", "Sweep Inbox", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_SweepInbox001", subscriptionId: "sub_SweepInbox001", active: true, period: paidPeriod() });
  const again = (await storeForEmail(OWNER))!;
  for (const who of ["ana@example.com", "ben@example.com"]) await fileContact({ store: again, email: who, name: "x", text: "Hello, is the guide a PDF?" });
  const sid = again.statsId!;
  is("Ana's one conversation is deleted", await forgetInboxPerson(sid, "ana@example.com"), 1);

  part("2. DEFECT: the index read answers in an unknown shape");
  malform("ZREVRANGE");
  let outcome: unknown;
  try {
    outcome = await forgetInboxPerson(sid, "ben@example.com");
  } catch (error) {
    outcome = (error as Error).name;
  }
  restore();
  is("DEFECT: answers 0, no error, so the erasure is said done", outcome, 0);
  const left = (await readInbox(sid)).filter((c) => c.email === "ben@example.com").length;
  is("DEFECT: Ben's conversation is still kept", left, 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
