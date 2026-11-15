/**
 * A person's payment requests are erased exactly (rule 24; lib/payment-request-store.ts,
 * forgetRequestsPerson, run by lib/person-erasure.ts).
 *
 * The person's set (nl:payreq:p:<sid>:<person>) is the only way to find their
 * requests (address, name, amount, note). The erasure used to read that set
 * loosely: a reply of another shape, or a member that is not a request id,
 * read as "no requests", the set was deleted and the erasure answered 0, done,
 * while the requests stayed in Redis with nothing left to find them by. It also
 * read at most MAX_PER_PERSON * 2 ids and then deleted the whole set, so any
 * request past that cut was orphaned the same way, and it never checked what
 * its deletes answered. Now:
 *
 *   - the set is read exactly, and a member that is not a request id is
 *     unknown too: the erasure throws before deleting anything (the erasure is
 *     then not finished, and pressing again retries);
 *   - every request in the set is erased, in batches, however many there are;
 *   - each request's record goes first, and its id leaves the set only with
 *     it, every count checked: a reply of another shape throws and the id stays
 *     in the set, so a retry still finds it;
 *   - a change in progress on a request (its write lock) is waited for, so it
 *     cannot write the record back after the erasure deleted it;
 *   - only an exact empty set is "nothing to erase".
 *
 * Synthetic only: the Redis stand-in, with one reply at a time made malformed,
 * and a fetch stub.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { MAX_PER_PERSON, readDraft } from "@/lib/payment-request-rules";
import { createRequest, forgetRequestsPerson, readRequest } from "@/lib/payment-request-store";
import { ERASERS, erasureScope } from "@/lib/person-erasure";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

type Commands = (string | number)[][];
type Pipeline = (commands: Commands) => Promise<unknown[]>;
const realPipeline: Pipeline = redis.pipeline.bind(redis);
const setPipeline = (next: Pipeline) => {
  (redis as unknown as { pipeline: Pipeline }).pipeline = next;
};

const CLIENT = "client@example.com";
const OTHER = "other@example.com";
const LINE = { text: "Coaching, October (4 sessions)", quantity: 1, amount: "480" };

async function freshStore(): Promise<Store> {
  redis.clear();
  const owner = "payreq-erase@example.com";
  await claimHandle(owner, "payreqerase", "Erase Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1PayEraseXxxx", true);
  await setSubscription(owner, { customerId: "cus_payreqerase", subscriptionId: "sub_payreqerase", active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function make(store: Store, email: string, now: number): Promise<string> {
  const read = readDraft({ email, name: "Dana", lines: [LINE], note: "Thank you.", dueDate: "", autoReminders: 2, consent: true }, "usd", now);
  if (!read.ok) throw new Error("synthetic draft refused");
  const made = await createRequest(store, read.draft, now);
  if (!made.ok) throw new Error(made.message);
  return made.request.id;
}

const PERSON_PREFIX = "nl:payreq:p:";
/** A person's set that still holds something (an empty set is no key in Redis). */
const personSets = async () => {
  const out: string[] = [];
  for (const key of redis.keys().filter((k) => k.startsWith(PERSON_PREFIX))) {
    const [n] = await realPipeline([["SCARD", key]]);
    if (n !== 0) out.push(key);
  }
  return out.sort();
};
const records = () => redis.keys().filter((k) => k.startsWith("nl:payreq:r:"));

async function outcome(run: () => Promise<number>): Promise<string> {
  try {
    return `answered ${await run()}`;
  } catch {
    return "threw";
  }
}

/** Answers the first SMEMBERS of a person's set with `reply`, without running anything. */
function oddMembers(reply: unknown[]): void {
  let odd = true;
  setPipeline(async (commands) => {
    if (odd && commands.length === 1 && commands[0][0] === "SMEMBERS" && String(commands[0][1]).startsWith(PERSON_PREFIX)) {
      odd = false;
      return reply;
    }
    return realPipeline(commands);
  });
}

const deletesARecord = (commands: Commands) => commands.some((c) => (c[0] === "DEL" || c[0] === "EVAL") && c.some((x) => String(x).startsWith("nl:payreq:r:")));

async function main(): Promise<void> {
  const now = Date.now();

  for (const [label, reply] of [
    ["undefined", [undefined]],
    ["a string", ["0123456789abcdef0123456789abcdef"]],
    ["a list holding a number", [[42]]],
    ["an object", [{ length: 1, 0: "0123456789abcdef0123456789abcdef" }]],
    ["no reply at all", []],
  ] as const) {
    part(`The person's set answers in another shape (${label})`);
    const store = await freshStore();
    const id = await make(store, CLIENT, now);
    oddMembers(reply as unknown as unknown[]);
    const said = await outcome(() => forgetRequestsPerson(store.sid!, CLIENT));
    setPipeline(realPipeline);
    is("an unknown reply is never 'no requests': the erasure throws (not done)", said, "threw");
    is("the person's set is kept, so a retry finds the request", (await personSets()).length, 1);
    is("nothing was deleted: the request stays readable", (await readRequest(id))?.email, CLIENT);
    is("a retry with Redis answering normally erases the request and the person's set", [await forgetRequestsPerson(store.sid!, CLIENT), await readRequest(id), (await personSets()).length], [1, null, 0]);
  }

  part("A member of the person's set that is not a request id is unknown, not skipped");
  {
    const store = await freshStore();
    const id = await make(store, CLIENT, now);
    const [key] = await personSets();
    await realPipeline([["SADD", key, "not-a-request-id"]]);
    const said = await outcome(() => forgetRequestsPerson(store.sid!, CLIENT));
    is("the erasure throws instead of answering a count", said, "threw");
    is("nothing was deleted: the request and the set stay", [(await readRequest(id))?.email, (await personSets()).length], [CLIENT, 1]);
  }

  part("More requests in the set than one read used to take: every one is erased");
  {
    const store = await freshStore();
    const first = await make(store, CLIENT, now);
    const [key] = await personSets();
    const [raw] = await realPipeline([["GET", `nl:payreq:r:${first}`]]);
    const extra = Array.from({ length: MAX_PER_PERSON * 2 + 5 }, (_, i) => (0xa0000000 + i).toString(16).padStart(32, "0"));
    for (const id of extra) {
      const record = JSON.stringify({ ...JSON.parse(String(raw)), id });
      await realPipeline([["SET", `nl:payreq:r:${id}`, record], ["ZADD", `nl:payreq:s:${store.sid}`, String(now), id], ["SADD", key, id]]);
    }
    const all = [first, ...extra];
    is("before: every request reads", (await Promise.all(all.map(readRequest))).filter(Boolean).length, all.length);
    is("the erasure answers every request of theirs", await outcome(() => forgetRequestsPerson(store.sid!, CLIENT)), `answered ${all.length}`);
    is("none is left behind without its index", [(await Promise.all(all.map(readRequest))).filter(Boolean).length, records().length, (await personSets()).length], [0, 0, 0]);
  }

  part("The records' deletes answer in another shape (nothing confirmed)");
  {
    const store = await freshStore();
    const id = await make(store, CLIENT, now);
    let lost = true;
    setPipeline(async (commands) => {
      if (lost && deletesARecord(commands)) {
        lost = false;
        return commands.map(() => undefined);
      }
      return realPipeline(commands);
    });
    const said = await outcome(() => forgetRequestsPerson(store.sid!, CLIENT));
    setPipeline(realPipeline);
    is("deletes that may not have happened are never 'done': the erasure throws", said, "threw");
    is("the person's set is kept, and the request with it", [(await personSets()).length, (await readRequest(id))?.email], [1, CLIENT]);
    is("the retry erases everything", [await forgetRequestsPerson(store.sid!, CLIENT), await readRequest(id), (await personSets()).length], [1, null, 0]);
  }

  part("The index's own update answers in another shape");
  {
    const store = await freshStore();
    const id = await make(store, CLIENT, now);
    let odd = true;
    setPipeline(async (commands) => {
      const replies = await realPipeline(commands);
      if (odd && commands.some((c) => c[0] === "SREM" && String(c[1]).startsWith(PERSON_PREFIX))) {
        odd = false;
        return replies.map(() => "OK");
      }
      return replies;
    });
    const said = await outcome(() => forgetRequestsPerson(store.sid!, CLIENT));
    setPipeline(realPipeline);
    is("a count that does not read is never 'done': the erasure throws", said, "threw");
    is("the record itself is gone (its delete ran first)", await readRequest(id), null);
    is("a retry answers and leaves nothing of the person", [await outcome(() => forgetRequestsPerson(store.sid!, CLIENT)), (await personSets()).length, records().length], ["answered 0", 0, 0]);
  }

  part("A change in progress on a request is waited for, never written back after the erasure");
  {
    const store = await freshStore();
    const id = await make(store, CLIENT, now);
    await realPipeline([["SET", `nl:payreq:w:${id}`, "someone-else", "EX", 60]]);
    const started = Date.now();
    const said = await outcome(() => forgetRequestsPerson(store.sid!, CLIENT));
    is("while the request's write lock stays taken, the erasure is not done", said, "threw");
    is("it waited for the lock before giving up", Date.now() - started >= 4_000, true);
    is("the request and the person's set are kept for the retry", [(await readRequest(id))?.email, (await personSets()).length], [CLIENT, 1]);
    await realPipeline([["DEL", `nl:payreq:w:${id}`]]);
    is("once the change let go, the retry erases it", [await forgetRequestsPerson(store.sid!, CLIENT), await readRequest(id), (await personSets()).length], [1, null, 0]);
  }

  part("Control: an exact empty set is the only 'nothing to erase'");
  {
    const store = await freshStore();
    const other = await make(store, OTHER, now);
    is("a person with no requests: answered 0, no throw", await outcome(() => forgetRequestsPerson(store.sid!, CLIENT)), "answered 0");
    is("someone else's request is untouched", [(await readRequest(other))?.email, (await personSets()).length], [OTHER, 1]);
  }

  part("Control: healthy requests are fully erased, someone else's stay");
  {
    const store = await freshStore();
    const first = await make(store, CLIENT, now);
    const second = await make(store, CLIENT, now + 1_000);
    const other = await make(store, OTHER, now + 2_000);
    // A reminder waiting for each (one is queued once the first email went; here put on the list directly).
    await realPipeline([["ZADD", "nl:payreq:due", String(now + 86_400_000), `${store.sid}|${first}`, String(now + 86_400_000), `${store.sid}|${other}`]]);
    is("the erasure answers both of the person's requests", await forgetRequestsPerson(store.sid!, CLIENT), 2);
    is("their records are gone, the other person's stays", [await readRequest(first), await readRequest(second), (await readRequest(other))?.email], [null, null, OTHER]);
    const [index] = await realPipeline([["ZRANGEBYSCORE", `nl:payreq:s:${store.sid}`, "-inf", "+inf"]]);
    const [open] = await realPipeline([["ZRANGEBYSCORE", `nl:payreq:o:${store.sid}`, "-inf", "+inf"]]);
    const [due] = await realPipeline([["ZRANGEBYSCORE", "nl:payreq:due", "-inf", "+inf"]]);
    is("the store's lists and the reminders keep only the other person's", [index, open, (due as string[]).map((m) => m.split("|")[1])], [[other], [other], [other]]);
    is("the person's set is gone, the other person's stays", (await personSets()).length, 1);
    is("a second erasure finds nothing and answers 0", await forgetRequestsPerson(store.sid!, CLIENT), 0);
  }

  part("lib/person-erasure.ts runs it, and a throw is not finished");
  {
    const store = await freshStore();
    const id = await make(store, CLIENT, now);
    const eraser = ERASERS.find((e) => e.module === "lib/payment-request-store.ts");
    is("the erasure has a payment request step", Boolean(eraser), true);
    const scope = (await erasureScope(store, CLIENT))!;
    oddMembers([undefined]);
    const said = await outcome(async () => (await eraser!.run(scope, [], new Set())) as number);
    setPipeline(realPipeline);
    is("the step throws, which erasePerson records as failed (incomplete)", said, "threw");
    is("and the retry erases", [await eraser!.run(scope, [], new Set()), await readRequest(id)], [1, null]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
