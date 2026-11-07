/**
 * Rule 24 (synthetic): an unknown or off-shape Redis reply in the inbox is
 * never read as "nothing there" or "gone". A person's erasure never answers
 * done while their conversations stay kept, and the creator's inbox index
 * never drops a conversation that still exists.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fileContact, forgetInboxPerson, readInbox, tokenHandle, visitorThread } from "@/lib/inbox";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner.r24@example.test";
const ANA = "ana.r24@example.test";
const BEN = "ben.r24@example.test";

async function setup() {
  redis.clear();
  await claimHandle(OWNER, "r24inbox", "R24 Inbox", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_R24Inbox01", subscriptionId: "sub_R24Inbox01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  assert.equal(await fileContact({ store, email: ANA, name: "Ana", text: "Hello, a question about the course." }), true);
  assert.equal(await fileContact({ store, email: BEN, name: "Ben", text: "Hello, do you do collaborations?" }), true);
  assert.equal((await readInbox(store.statsId)).length, 2);
  return store.statsId!;
}

/** Replaces the reply of the first pipeline whose first command is `op`. */
async function withReplyFor<T>(op: string, reply: unknown[], run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === op ? [...reply] : original(commands))) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}


for (const partial of [false,true]) test("J partial deletion recovery; partial="+partial, async()=>{
 const statsId=await setup();
 const ana=(await readInbox(statsId)).find(c=>c.email===ANA)!;
 const key=`nl:inbox:${statsId}:c:${ana.id}`;
 const before=JSON.parse(String(redis.run(["GET",key]))) as {token:string};
 const original=redis.pipeline.bind(redis);
 let injected=0;
 redis.pipeline=async(commands)=>{
  if(partial && commands[0]?.[0]==="DEL" && commands[1]?.[0]==="ZREM") {
   injected++;
   // Redis pipeline may execute the later ZREM even when DEL errors. The REST
   // wrapper then throws on that DEL error. No DEL dispatched in this fixture.
   await original([commands[1]]);
   throw new Error("synthetic DEL failed, later ZREM applied");
  }
  return original(commands);
 };
 let first:unknown;
 try {first=await forgetInboxPerson(statsId,ANA);}catch {first="threw";}finally{redis.pipeline=original;}
 const retainedBeforeRetry=redis.run(["GET",key])!==null;
 const tokenBeforeRetry=await tokenHandle(before.token);
 const retry=await forgetInboxPerson(statsId,ANA);
 const visitorStillReadable=Boolean(await visitorThread(before.token));
 const retained=redis.run(["GET",key])!==null;
 console.log('J_PARTIAL_ERASE',JSON.stringify({partial,injected,first,retainedBeforeRetry,tokenBeforeRetry,retry,retained,visitorStillReadable,index:(await readInbox(statsId)).map(c=>c.email)}));
 assert.equal(injected,partial?1:0);
 assert.equal(first,partial?"threw":1);
 assert.equal(retry,0);
 assert.equal(visitorStillReadable,partial,"visitor path must confirm the retained fixture is still reachable");
 assert.equal(retained,false,"healthy retry must not finish with the original conversation retained after partial DEL/ZREM");
});
