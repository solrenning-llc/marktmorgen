/** Separate recovery disposition of J's frozen two-case diagnostic.
 * Same real Ana/Ben setup; fault matches the DEL operation regardless of batch
 * layout. The fixed contract requires unreadable visitor data AFTER recovery.
 * No production Redis or whole erasePerson/HTTP call is exercised here.
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

for (const fault of ["healthy", "del-before", "del-after", "zrem-before", "zrem-after", "zrem-too-large"] as const) {
  test("J recovery disposition: " + fault, async () => {
    const statsId = await setup();
    const all = await readInbox(statsId);
    const ana = all.find(c => c.email === ANA)!;
    const ben = all.find(c => c.email === BEN)!;
    const key = `nl:inbox:${statsId}:c:${ana.id}`;
    const messages = `nl:inbox:${statsId}:m:${ana.id}`;
    const index = `nl:inbox:${statsId}:all`;
    const token = (JSON.parse(String(redis.run(["GET", key]))) as {token: string}).token;
    const tokenKey = `nl:inbox:tok:${token}`;
    assert.ok(await visitorThread(token), "token opens the actual seeded thread before fault");
    const original = redis.pipeline.bind(redis);
    let injected = 0;
    redis.pipeline = async commands => {
      const op = fault.startsWith("del-") ? "DEL" : "ZREM";
      const at = commands.findIndex(c => c[0] === op && c.includes(op === "DEL" ? key : ana.id));
      if (fault === "healthy" || injected || at < 0) return original(commands);
      injected++;
      if (fault.endsWith("before")) {
        await original(commands.filter((_, i) => i !== at));
        throw new Error("synthetic command failure; other commands in batch applied");
      }
      const replies = await original(commands);
      if (fault === "zrem-too-large") return replies.map((r, i) => i === at ? 99 : r);
      throw new Error("synthetic lost reply after command application");
    };
    let first: unknown;
    try { first = await forgetInboxPerson(statsId, ANA); }
    catch { first = "threw"; }
    finally { redis.pipeline = original; }
    const firstRetained = redis.run(["GET", key]) !== null;
    const firstIndexed = (redis.run(["ZREVRANGE", index, 0, -1]) as string[]).includes(ana.id);
    const firstVisitor = Boolean(await visitorThread(token));
    const retry = await forgetInboxPerson(statsId, ANA);
    const finalIndex = redis.run(["ZREVRANGE", index, 0, -1]);
    const retained = redis.run(["GET", key]) !== null;
    const visitor = await visitorThread(token);
    console.log("J_RECOVERY", JSON.stringify({fault, injected, first, firstRetained, firstIndexed, firstVisitor, retry, retained, visitorReadable: Boolean(visitor), finalIndex}));
    assert.equal(injected, fault === "healthy" ? 0 : 1, "generic fault reached actual operation");
    assert.equal(first, fault === "healthy" ? 1 : "threw", "unknown deletion is not answered as completed");
    assert.equal(typeof retry, "number");
    assert.equal(retained, false, "healthy retry removes the conversation");
    assert.deepEqual(redis.run(["LRANGE", messages, 0, -1]), []);
    assert.equal(redis.run(["GET", tokenKey]), null);
    assert.equal(await tokenHandle(token), null);
    assert.equal(visitor, null, "healthy retry revokes visitor access");
    assert.deepEqual(finalIndex, [ben.id]);
    assert.deepEqual((await readInbox(statsId)).map(c => c.email), [BEN]);
    if (fault === "del-before") {
      assert.equal(firstRetained, true);
      assert.equal(firstIndexed, true, "failed DEL leaves discovery intact for retry");
      assert.equal(firstVisitor, true, "the fault really kept the seeded visitor data before retry");
      assert.equal(retry, 1);
    }
  });
}
