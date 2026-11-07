/** Synthetic review evidence for #3035, with the real applyAccess and MemoryRedis. */
import { applyAccess } from "@/lib/student-bulk";
import { accessSummary } from "@/lib/student-bulk-rules";
import { emailKey } from "@/lib/learn";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const courseId = "c".repeat(20);
const address = "learner@example.com";
const students = `nl:course:${courseId}:students`;
const blocked = `nl:course:${courseId}:blocked`;
const room = { sid: "j-3035-synthetic", statsId: "j-3035-synthetic" } as Store;

async function main() {
  redis.clear();
  await redis.pipeline([["HSET", students, emailKey(address), JSON.stringify({ e: address, s: 1, l: 1 })]]);
  const base = redis.pipeline.bind(redis);
  let reads = 0;
  let commands = 0;
  redis.pipeline = async input => {
    commands += input.length;
    if (commands > 2000) throw new Error("Synthetic review command ceiling exceeded");
    const result = await base(input);
    if (input.some(command => command[0] === "SMISMEMBER") && ++reads === 2) return result.map((reply, index) => input[index][0] === "SMISMEMBER" ? "unreadable" : reply);
    return result;
  };
  const changed = await applyAccess(room, courseId, { change: "revoke", emails: [address], expect: 1 }, async () => ({ ok: true }));
  redis.pipeline = base;
  if (changed.kind !== "done") throw new Error("Expected the bounded apply result");
  part("An applied write with unreadable read-back remains uncertain in every summary");
  is("the actual course blocked set was changed", await redis.pipeline([["SISMEMBER", blocked, emailKey(address)]]), [1]);
  is("the caller correctly keeps this result unknown", [changed.done.changed, changed.done.unknown], [[], [address]]);
  const message = accessSummary(changed.done, "revoke");
  is("the visible/full summary does not claim that nothing changed", message.words.startsWith("Nothing was changed."), false);
  is("the short live-region summary also preserves uncertainty", message.short.startsWith("Nothing was changed."), false);
  is("the detailed reason still says that the applied write is unconfirmed", message.words.includes("it may or may not be removed"), true);
  const healthy = await applyAccess(room, courseId, { change: "grant", emails: [address], expect: 1 }, async () => ({ ok: true }));
  if (healthy.kind !== "done") throw new Error("Expected healthy control");
  is("healthy confirmed grant remains a confirmed success", [healthy.done.changed, healthy.done.unknown, accessSummary(healthy.done, "grant").short], [[address], [], "Access given back to 1 student."]);
  is("the command ceiling stayed bounded", commands <= 2000, true);
  done();
}
void main();
