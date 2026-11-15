/**
 * Codex G on #1929 (the same finding on #1856's description): what the store
 * holds was read before the book's lock and the write did not compare it, so
 * a creator's edit made in between was overwritten by the confirmation or by
 * an undo. The write now compares in the same step (WRITE_ABOUT_IF): the
 * creator's edit stays, the proposal is refused as changed since, and the
 * description's room stays what it holds.
 */
import { addProduct, claimHandle, ensureStatsId, setProductAbout, setSubscription, storeForEmail } from "@/lib/store";
import { readAbout, writeAbout } from "@/lib/product-about";
import { proposeDescription } from "@/lib/agent-propose";
import { confirmFor, undoFor } from "@/lib/agent-confirm";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "agent-cas@example.test";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "agentcas", "Agent CAS shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_AgentCas00000001", subscriptionId: "sub_AgentCas00000001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Pottery course", "Learn to throw a bowl", "29", null);
  if (!made.ok) throw new Error("synthetic product refused");
  const product = made.product.id;
  const fresh = async () => (await storeForEmail(OWNER))!;
  const shop = await fresh();
  const statsId = shop.statsId!;
  const lockKey = `nl:agent:book:lock:${statsId}`;
  const roomOf = async () => Number((await redis.pipeline([["HGET", dataKey(shop)!, `ab:${product}`]]))[0] ?? 0);
  const studioEdit = async (text: string) => {
    const marked = await setProductAbout(OWNER, product, text !== "");
    if (!marked.ok) throw new Error("studio edit refused");
    await writeAbout(statsId, product, text, marked.store);
  };
  await studioEdit("The original description.");

  part("A creator's edit made between the read and the lock is never overwritten");
  const proposal = JSON.parse((await proposeDescription(await fresh(), "key-1", { product, description: "The agent's description." })).content[0].text).proposal as string;
  const base = redis.pipeline.bind(redis);
  let edited = false;
  redis.pipeline = async (commands) => {
    if (!edited && commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === lockKey) {
      edited = true;
      redis.pipeline = base;
      await studioEdit("The creator's own edit, made just now.");
      redis.pipeline = spy;
    }
    return base(commands);
  };
  const spy = redis.pipeline;
  let result;
  try {
    result = await confirmFor({ ...(await fresh()), statsId }, OWNER, [proposal], OWNER);
  } finally {
    redis.pipeline = base;
  }
  is("the edit landed between the read and the lock", edited, true);
  is("the confirmation is refused as changed since, and nothing is done", [result.done, result.refused.map((r) => r.why)], [[], ["changed_since"]]);
  is("the creator's edit stays", await readAbout(statsId, product), "The creator's own edit, made just now.");
  is("and the room is what the edit holds", await roomOf(), dataBytes(["The creator's own edit, made just now."], 1));

  part("An undo over an edit made after the read is refused too");
  const second = JSON.parse((await proposeDescription(await fresh(), "key-1", { product, description: "Another agent text." })).content[0].text).proposal as string;
  const plain = await confirmFor({ ...(await fresh()), statsId }, OWNER, [second], OWNER);
  is("a confirmation with nothing in between goes through", plain.done, [second]);
  let editedAgain = false;
  redis.pipeline = async (commands) => {
    if (!editedAgain && commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === lockKey) {
      editedAgain = true;
      redis.pipeline = base;
      await studioEdit("Edited again by the creator.");
      redis.pipeline = spy2;
    }
    return base(commands);
  };
  const spy2 = redis.pipeline;
  let undone;
  try {
    undone = await undoFor({ ...(await fresh()), statsId }, OWNER, second, OWNER);
  } finally {
    redis.pipeline = base;
  }
  is("the undo is refused as changed since", [editedAgain, undone], [true, { ok: false, error: "changed_since" }]);
  is("and the creator's newer edit stays", await readAbout(statsId, product), "Edited again by the creator.");
  done();
}

void main();
