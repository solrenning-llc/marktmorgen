/**
 * A payment request's record is written only while its writer still holds the
 * record's write lock, and never after the record was erased
 * (lib/payment-request-store.ts, changeRequest and createRequest).
 *
 * An erasure (forgetRequestsPerson, run by lib/person-erasure.ts) takes each
 * request's write lock and deletes its record under it. The writers used to
 * write with a plain SET: a change held up past its own ten-second lock (a slow
 * network, a paused function) could land its copy after the erasure, putting
 * the person's address, name, amounts and note back for another KEEP_DAYS, with
 * nothing left to find it by. A creation interleaved the same way. Now:
 *
 *   - every write of a record is one script that checks the writer's lock
 *     token first: a writer that lost its lock writes nothing and is told so
 *     (LockBusyError for a change; "unavailable" for a creation);
 *   - a change writes over a record only while it is still there: one deleted
 *     meanwhile (an erasure, or the creator deleting it) is not put back, and
 *     the change answers "gone";
 *   - the record, its open entry and its reminder are written in the same
 *     step, so no index entry is left pointing at a record that was refused;
 *   - a write whose reply is of another shape is never "saved" (rule 24).
 *
 * Synthetic only: the Redis stand-in, a fetch stub, one step made slow or odd.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readDraft } from "@/lib/payment-request-rules";
import { cancelRequest, changeRequest, createRequest, deleteRequest, forgetRequestsPerson, readRequest } from "@/lib/payment-request-store";
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
const LINE = { text: "Coaching, October (4 sessions)", quantity: 1, amount: "480" };
const RECORD = "nl:payreq:r:";
const PERSON_PREFIX = "nl:payreq:p:";

async function freshStore(): Promise<Store> {
  redis.clear();
  const owner = "payreq-fenced@example.com";
  await claimHandle(owner, "payreqfenced", "Fenced Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1PayFencedXxx", true);
  await setSubscription(owner, { customerId: "cus_payreqfenced", subscriptionId: "sub_payreqfenced", active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

const draftOf = (now: number) => {
  const read = readDraft({ email: CLIENT, name: "Dana", lines: [LINE], note: "Thank you.", dueDate: "", autoReminders: 2, consent: true }, "usd", now);
  if (!read.ok) throw new Error("synthetic draft refused");
  return read.draft;
};

async function make(store: Store, now: number): Promise<string> {
  const made = await createRequest(store, draftOf(now), now);
  if (!made.ok) throw new Error(made.message);
  return made.request.id;
}

/** A pipeline that writes a request's record: a plain SET of it, or a script naming it. */
const writesARecord = (commands: Commands) => commands.some((c) => (c[0] === "SET" || c[0] === "EVAL") && c.some((x) => String(x).startsWith(RECORD)) && !c.some((x) => String(x).startsWith("-- marktmorgen:fenced-del")));

/** Runs `meanwhile` just before the first record write reaches Redis, then lets the write go on. */
function beforeTheWrite(meanwhile: () => Promise<void>): void {
  let first = true;
  setPipeline(async (commands) => {
    if (first && writesARecord(commands)) {
      first = false;
      setPipeline(realPipeline);
      await meanwhile();
    }
    return realPipeline(commands);
  });
}

async function outcome<T>(run: () => Promise<T>): Promise<string> {
  try {
    const value = await run();
    return value === null ? "null" : typeof value === "object" ? "an answer" : `answered ${String(value)}`;
  } catch (error) {
    return error instanceof Error && error.name === "LockBusyError" ? "lock lost" : "threw";
  }
}

const records = () => redis.keys().filter((k) => k.startsWith(RECORD));
const members = async (key: string) => ((await realPipeline([["ZRANGEBYSCORE", key, "-inf", "+inf"]]))[0] as string[]) ?? [];
const personSets = async () => {
  const out: string[] = [];
  for (const key of redis.keys().filter((k) => k.startsWith(PERSON_PREFIX))) {
    const [n] = await realPipeline([["SCARD", key]]);
    if (n !== 0) out.push(key);
  }
  return out;
};

async function main(): Promise<void> {
  const now = Date.now();

  part("A change held up past its lock: the erasure ran meanwhile, the change's write lands after it");
  {
    const store = await freshStore();
    const id = await make(store, now);
    let erased = "";
    beforeTheWrite(async () => {
      // The change's ten seconds ran out (a paused function): its lock is gone, and the erasure takes its own.
      await realPipeline([["DEL", `nl:payreq:w:${id}`]]);
      erased = await outcome(() => forgetRequestsPerson(store.sid!, CLIENT));
    });
    const said = await outcome(() => cancelRequest(store, id, now + 1_000));
    setPipeline(realPipeline);
    is("the erasure itself finished and answered the one request", erased, "answered 1");
    is("the late write is refused: the record stays erased", [await readRequest(id), records().length], [null, 0]);
    is("nothing of it is put back in the open list or the reminders", [await members(`nl:payreq:o:${store.sid}`), await members("nl:payreq:due")], [[], []]);
    is("the change is told it did not save (its lock was lost), never answered as done", said, "lock lost");
  }

  part("A change whose record was deleted under it (the creator's delete, which takes no lock): not written back");
  {
    const store = await freshStore();
    const id = await make(store, now);
    await cancelRequest(store, id, now + 1_000);
    beforeTheWrite(async () => {
      is("the delete went through", await deleteRequest(store, id, now + 2_000), "deleted");
    });
    const said = await outcome(() => changeRequest(store, id, (current) => ({ next: { ...current, failed: "late" }, answer: null }), now + 3_000));
    setPipeline(realPipeline);
    is("the record stays deleted", [await readRequest(id), records().length], [null, 0]);
    is("the reminders hold nothing for it", await members("nl:payreq:due"), []);
    is("the change answers that the request is gone", said, "null");
  }

  part("A creation held up past its lock: an erasure of the person ran between its count and its write");
  {
    const store = await freshStore();
    let erased = "";
    beforeTheWrite(async () => {
      for (const key of redis.keys().filter((k) => k.startsWith("nl:payreq:w:"))) await realPipeline([["DEL", key]]);
      erased = await outcome(() => forgetRequestsPerson(store.sid!, CLIENT));
    });
    const made = await createRequest(store, draftOf(now), now);
    setPipeline(realPipeline);
    is("the erasure finished", erased, "answered 1");
    is("no record is left that the erasure can no longer find", [records().length, (await personSets()).length], [0, 0]);
    is("the creation is answered as not saved, in plain words", made.ok ? "saved" : `${made.reason}: ${made.message}`, "unavailable: This can't be saved right now. Try again in a minute.");
    is("nothing of it stays in the store's lists", [await members(`nl:payreq:s:${store.sid}`), await members(`nl:payreq:o:${store.sid}`)], [[], []]);
  }

  part("A change's write that answers in another shape is never 'saved' (rule 24)");
  {
    const store = await freshStore();
    const id = await make(store, now);
    let odd = true;
    setPipeline(async (commands) => {
      if (odd && writesARecord(commands)) {
        odd = false;
        await realPipeline(commands);
        return commands.map(() => "OK?");
      }
      return realPipeline(commands);
    });
    const said = await outcome(() => cancelRequest(store, id, now + 1_000));
    setPipeline(realPipeline);
    is("an unconfirmed write throws instead of answering the request as canceled", said === "threw" || said === "lock lost", true);
  }

  part("Control: a change holding its lock writes, keeps the record's expiry and its lists in step");
  {
    const store = await freshStore();
    const id = await make(store, now);
    const [before] = await realPipeline([["TTL", `${RECORD}${id}`]]);
    const done = await cancelRequest(store, id, now + 1_000);
    is("the cancel answers the canceled request", typeof done === "object" && done !== null ? done.state : done, "canceled");
    is("the record reads as canceled", (await readRequest(id))?.state, "canceled");
    const [after] = await realPipeline([["TTL", `${RECORD}${id}`]]);
    is("it still goes by itself when it is no longer kept", typeof after === "number" && after > 0 && Math.abs(after - Number(before)) <= 5, true);
    is("it left the open list", await members(`nl:payreq:o:${store.sid}`), []);
    const sent = await changeRequest(store, id, (current) => ({ next: { ...current, state: "open", closedAt: 0, sent: [now] }, answer: "ok" }), now + 2_000);
    is("an open one written back is in the open list and has its reminder waiting", [sent?.answer, await members(`nl:payreq:o:${store.sid}`), (await members("nl:payreq:due")).length], ["ok", [id], 1]);
    is("no write lock is left behind", redis.keys().filter((k) => k.startsWith("nl:payreq:w:")), []);
  }

  part("Control: a creation with nothing in its way is saved and indexed");
  {
    const store = await freshStore();
    const id = await make(store, now);
    is("the record reads, under the person's set", [(await readRequest(id))?.email, (await personSets()).length], [CLIENT, 1]);
    const [ttl] = await realPipeline([["TTL", `${RECORD}${id}`]]);
    is("with its expiry", typeof ttl === "number" && ttl > 0, true);
    is("no write lock is left behind", redis.keys().filter((k) => k.startsWith("nl:payreq:w:")), []);
    is("the erasure still erases it", [await forgetRequestsPerson(store.sid!, CLIENT), await readRequest(id), records().length], [1, null, 0]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
