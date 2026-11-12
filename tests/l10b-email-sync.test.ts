/**
 * CX-123 rule 24, lot L10b: a buyer or a sign-up is handed to the creator's own email platform once
 * (lib/email-sync.ts queuePerson), under a thirty-day mark taken with SET NX. A reply to it in any shape but "OK" or
 * nil is read back: our own value means this run writes the job once; another value is a person already handed over;
 * nothing readable writes no job and says so (UnknownReplyError), so the person is never handed over twice.
 * Only people who did not agree are used, so nothing is sent anywhere: their job is logged, never sent.
 */
import { queuePerson } from "@/lib/email-sync";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ODD, THROWS, UNREADABLE, answer, clearAnswers, getOf, setNx } from "./l10b-replies";

const STATS = "l10besyncstats0001";
const SEEN = "nl:esync:seen:";
const store = { statsId: STATS } as Store;
const jobs = () => Number(redis.run(["LLEN", `nl:esync:log:${STATS}`]));

let n = 0;
const person = () => ({ source: "purchase" as const, email: "buyer@example.com", name: "Dana Reyes", products: [], consent: false, seed: `cs_test_lsync${(n += 1)}`, at: Date.now() });

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  redis.run(["SET", `nl:esync:cfg:${STATS}`, JSON.stringify({ handle: "lsync", provider: "kit", key: "sealed-stand-in", last4: "0000", target: { id: "t1", name: "Synthetic list" }, free: true, buyers: "all", products: [], tags: {}, since: now - 60_000, connectedAt: now - 60_000 })]);

  part("The plain case: one job, then seen");
  const plain = person();
  is("a person who did not agree is logged once, never sent; the same one again is seen", [await queuePerson(store, plain), await queuePerson(store, plain), jobs()], ["skipped", "seen", 1]);

  part("A person already handed over is never taken for a new one");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    const p = person();
    await queuePerson(store, p);
    const before = jobs();
    answer(setNx(SEEN), reply);
    is(`the same person again, the mark answered with ${shape}: seen, no second job`, [await queuePerson(store, p), jobs() - before], ["seen", 0]);
  }

  part("The mark written and its answer lost: our own value read back, one job");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    const p = person();
    const before = jobs();
    answer(setNx(SEEN), reply);
    is(`answered with ${shape}, the write landed: one job, then seen`, [await queuePerson(store, p), await queuePerson(store, p), jobs() - before], ["skipped", "seen", 1]);
  }

  part("Nothing readable: no job, and said as not done");
  for (const [shape, reply] of [...UNREADABLE, ["the write failing too", THROWS] as const]) {
    clearAnswers();
    const before = jobs();
    answer(setNx(SEEN), shape === "the write failing too" ? THROWS : () => ["QUEUED"], { run: false });
    answer(getOf(SEEN), reply);
    const got = await queuePerson(store, person()).catch((error: unknown) => (error instanceof UnknownReplyError ? "unknown" : "threw"));
    is(`the mark unknown and its read-back ${shape}: no job, said as unknown`, [got, jobs() - before], ["unknown", 0]);
  }

  part("Claude 3 on #2723: a mark of this run's that could not be read back is let go, so the person is handed over on the next try");
  for (const [shape, reply] of UNREADABLE) {
    clearAnswers();
    const p = person();
    const before = jobs();
    answer(setNx(SEEN), () => ["QUEUED"], { run: true });
    answer(getOf(SEEN), reply);
    const first = await queuePerson(store, p).catch((error: unknown) => (error instanceof UnknownReplyError ? "unknown" : "threw"));
    clearAnswers();
    is(`the mark written, its answer lost and its read-back ${shape}: unknown now, one job on the next try`, [first, await queuePerson(store, p), jobs() - before], ["unknown", "skipped", 1]);
  }
  clearAnswers();
  done();
}

void main();
