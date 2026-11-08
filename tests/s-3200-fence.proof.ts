/** S nominal financial review: helpers adapted from author fenced-save test; token handover and applied-but-unknown writes. */
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
import { cancelRequest, createRequest, readRequest } from "@/lib/payment-request-store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
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

const members = async (key: string) => ((await realPipeline([["ZRANGEBYSCORE", key, "-inf", "+inf"]]))[0] as string[]) ?? [];

async function main():Promise<void>{
 const now=Date.now();
 {
  const store=await freshStore();const id=await make(store,now);
  const before=[await members(`nl:payreq:o:${store.sid}`),await members("nl:payreq:due")];
  beforeTheWrite(async()=>{
   await realPipeline([["SET",`nl:payreq:w:${id}`,"next-owner","EX",10]]);
   const current=(await readRequest(id))!;
   await realPipeline([["SET",`${RECORD}${id}`,JSON.stringify({...current,name:"New owner version"}),"EX",3600]]);
  });
  const said=await outcome(()=>cancelRequest(store,id,now+1000));setPipeline(realPipeline);
  is("stale writer reports lost lock with a newer record still present",said,"lock lost");
  is("stale writer does not overwrite the new holder's record",(await readRequest(id))?.name,"New owner version");
  is("stale release cannot delete the next holder's lock",await realPipeline([["GET",`nl:payreq:w:${id}`]]),["next-owner"]);
  is("a refused stale write cannot alter open/reminder indexes",[await members(`nl:payreq:o:${store.sid}`),await members("nl:payreq:due")],before);
 }
 for(const shape of ["extra","sparse"]){
  const store=await freshStore();const id=await make(store,now);let hit=false;
  setPipeline(async(commands)=>{
   if(!hit&&writesARecord(commands)){
    hit=true;const reply=await realPipeline(commands);
    return shape==="extra"?[...reply,1]:new Array(reply.length);
   }
   return realPipeline(commands);
  });
  const said=await outcome(()=>cancelRequest(store,id,now+1000));setPipeline(realPipeline);
  is(`${shape}: applied write with unknown ACK is never reported confirmed`,[hit,said],[true,"threw"]);
  is(`${shape}: unknown ACK does not imply rollback of the applied change`,(await readRequest(id))?.state,"canceled");
 }
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
