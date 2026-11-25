/**
 * A payment request's change leaves its open and reminder indexes alone when nothing they are read from changed (row
 * 141 of #5010, coordinator ca12). Every change ran two index writes inside SAVE (a ZADD or ZREM on the store's open
 * requests, and one on the reminders due), even when the change only recorded a checkout session or a failed email. Now a change whose state, expiry, reminders asked for and send times are as they were passes "-" for both,
 * and SAVE touches neither: two commands fewer. A change that moves any of them still writes both, and the reminder
 * job's write-back, whose whole purpose is to fix the indexes, always writes them. Synthetic only: the Redis
 * stand-in and a fetch stub.
 */
import { readDraft } from "@/lib/payment-request-rules";
import { changeRequest, createRequest } from "@/lib/payment-request-store";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

const OWNER = "payreq-index@example.com";
const DUE = "nl:payreq:due";

type Run = (command: (string | number)[]) => unknown;
const memory = redis as unknown as { run: Run; data: Map<string, unknown> };
const realRun: Run = memory.run.bind(memory);
let seen: string[] = [];
memory.run = (command) => {
  seen.push(String(command[0]));
  return realRun(command);
};
/** The index writes run while `work` runs: every ZADD and ZREM, inside a script or not. */
async function indexWrites(work: () => Promise<unknown>): Promise<number> {
  seen = [];
  await work();
  return seen.filter((name) => name === "ZADD" || name === "ZREM").length;
}

async function freshStore(): Promise<Store> {
  redis.clear();
  await claimHandle(OWNER, "payreqindex", "Index Coaching", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1PayReqIndexXx", true);
  await setSubscription(OWNER, { customerId: "cus_payreqindex", subscriptionId: "sub_payreqindex", active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(OWNER))!;
}

const draftOf = (now: number) => {
  const read = readDraft({ email: "client-index@example.com", name: "Dana", lines: [{ text: "Coaching", quantity: 1, amount: "480" }], note: "", dueDate: "", autoReminders: 2, consent: true }, "usd", now);
  if (!read.ok) throw new Error("synthetic draft refused");
  return read.draft;
};

const dueScore = (member: string) => realRun(["ZSCORE", DUE, member]);

async function main(): Promise<void> {
  console.error = () => {};
  const now = Date.now();
  const store = await freshStore();
  const made = await createRequest(store, draftOf(now), now);
  if (!made.ok) throw new Error("synthetic request refused");
  const id = made.request.id;
  const member = `${made.request.sid}|${id}`;

  part("A change that moves what the indexes are read from writes both");
  const sent = await indexWrites(() => changeRequest(store, id, (current) => ({ next: { ...current, sent: [...current.sent, now] }, answer: null }), now));
  is("its first email recorded: the open entry and the reminder written (2)", sent, 2);
  const firstDue = dueScore(member);
  is("the reminder now waits on its day", typeof firstDue === "string" || typeof firstDue === "number", true);

  part("A change that moves none of them leaves both alone");
  const opened = await indexWrites(() => changeRequest(store, id, (current) => ({ next: { ...current, session: "cs_test_indexwrites", sessionAt: now }, answer: null }), now));
  is("a checkout session recorded: no index write", opened, 0);
  is("the reminder is where it was", dueScore(member), firstDue);
  const same = await indexWrites(() => changeRequest(store, id, (current) => ({ next: { ...current }, answer: null }), now));
  is("a copy written back unchanged: no index write", same, 0);

  part("The reminder job's write-back always rewrites them");
  realRun(["ZADD", DUE, "1", member]);
  const fixed = await indexWrites(() => changeRequest(store, id, (current) => ({ next: current, answer: null }), now, { reindex: true }));
  is("asked to reindex: both written (2)", fixed, 2);
  is("the stale reminder put back on its day", dueScore(member), firstDue);

  part("A change of state writes them, and takes the request off both lists");
  const closed = await indexWrites(() => changeRequest(store, id, (current) => ({ next: { ...current, state: "canceled" as const }, answer: null }), now));
  is("canceled: both written (2)", closed, 2);
  is("no reminder left for it", dueScore(member), null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
