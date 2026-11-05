import { FlowWriteUnconfirmed, saveFlow, removeFlow, readFlows } from "@/lib/flows";
import { setUpStarters } from "@/lib/mail-starters";
import { keepSending } from "@/lib/mail-reuse";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
const listId = "mutation-test-list";
const key = "nl:mail:flows:" + listId;
const store = { listId, statsId: null, mail: { fromName: "Sample", address: "Sample address" }, subscriptionActive: true, tier: "pro", trialEnds: 0, name: "Sample", handle: "sample", catalog: { items: [] } } as unknown as Store;
const first = { id: "1111111111111111", name: "First", trigger: "joined", productId: null, active: false, createdAt: 1, steps: [{ id: "aaaaaaaaaaaaaaaa", delayHours: 0, subject: "Hello", body: "Sample" }] };
const second = { ...first, id: "2222222222222222", name: "Second", trigger: "bought" };
const raw = { name: "New", trigger: "joined", productId: null, active: false, steps: [{ delayHours: 0, subject: "Hello", body: "Sample" }] };
async function main() {
  part("Sequence mutation read guards");
  const original = redis.pipeline;
  const normal = Symbol("normal");
  let reply: unknown = normal;
  let writes = 0;
  let writeReply: unknown = normal;
  let applyWrite = false;
  // A write of the list: a SET, or the write made only over what was read (lib/flows.ts, WRITE_FLOWS_IF; Codex G2 on #1927).
  const writesList = (command: (string | number)[]) => (command[0] === "SET" && command[1] === key) || (command[0] === "EVAL" && command[3] === key);
  redis.pipeline = async commands => {
    writes += commands.filter(writesList).length;
    if (commands.some(command => command[0] === "GET" && command[1] === key) && reply !== normal) {
      if (reply instanceof Error) throw reply;
      return reply as unknown[];
    }
    if (commands.some(writesList) && writeReply !== normal) {
      if (applyWrite) await original.call(redis, commands);
      if (writeReply instanceof Error) throw writeReply;
      return writeReply as unknown[];
    }
    return original.call(redis, commands);
  };
  const operations = [
    ["save", () => saveFlow(store, raw)],
    ["remove", () => removeFlow(store, first.id)],
    ["starters", () => setUpStarters(store)],
    ["keep", () => keepSending(store, "not-a-broadcast", async () => null)],
  ] as const;
  try {
    for (const failed of [[], ["bad json"], ["{}"], ["[null]"], [JSON.stringify([{ ...first, steps: null }])], new Error("storage unavailable")]) {
      for (const [name, operation] of operations) {
        const saved = JSON.stringify([first, second]);
        await original.call(redis, [["SET", key, saved]]);
        writes = 0;
        reply = failed;
        let rejected = false;
        try { await operation(); } catch { rejected = true; }
        is(name + " refuses an unknown list", rejected, true);
        is(name + " makes no sequence write", writes, 0);
        is(name + " preserves stored bytes", (await original.call(redis, [["GET", key]]))[0], saved);
      }
    }
    reply = normal;
    for (const uncertain of [[], [null], ["NO"], [true], ["OK", "extra"], null, {}, new Error("write unavailable")]) {
      for (const [name, operation] of operations.slice(0, 2)) {
        await original.call(redis, [["SET", key, JSON.stringify([first, second])]]);
        writeReply = uncertain;
        let rejected = false;
        try { await operation(); } catch (error) { rejected = error instanceof FlowWriteUnconfirmed; }
        is(name + " needs explicit write confirmation", rejected, true);
      }
    }
    await original.call(redis, [["SET", key, JSON.stringify([first, second])]]);
    applyWrite = true;
    writeReply = [];
    let uncertain = false;
    try { await saveFlow(store, raw); } catch (error) { uncertain = error instanceof FlowWriteUnconfirmed; }
    is("lost acknowledgement does not claim success", uncertain, true);
    is("unconfirmed response does not imply rollback", (await readFlows(listId)).length, 3);
    applyWrite = false;
    writeReply = normal;
    await original.call(redis, [["SET", key, JSON.stringify([first, second])]]);
    const added = await saveFlow(store, raw);
    is("valid creation succeeds", added.ok, true);
    is("creation preserves both existing sequences", (await readFlows(listId)).slice(0, 2), [first, second]);
    const edited = await saveFlow(store, { ...raw, id: first.id, name: "Edited" });
    is("valid editing succeeds", edited.ok, true);
    is("editing preserves the other sequence", (await readFlows(listId)).find(flow => flow.id === second.id), second);
    const removed = await removeFlow(store, first.id);
    is("valid removal succeeds", removed.ok, true);
    is("removal preserves remaining sequences", (await readFlows(listId)).length, 2);
    await original.call(redis, [["DEL", key]]);
    is("confirmed absent list permits creation", (await saveFlow(store, raw)).ok, true);
  } finally { redis.pipeline = original; }
  done();
}
void main();
