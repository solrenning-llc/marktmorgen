/**
 * Issue #4676 (Codex L, reproduced by Claude 2): forgetLeadPerson ignored the reply of the HSET that takes the address
 * off a lead, so a write that did not land was counted as done and the address stayed. Synthetic, the Redis stub.
 */
import { done, is, part } from "./check";
import { leadsKey } from "@/lib/affiliate-lead-rules";
import { forgetLeadPerson, leadId } from "@/lib/affiliate-leads";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const STATS = "a".repeat(32);
const email = "erase.me@example.com";
const store = { sid: "sidlead0001", statsId: STATS } as unknown as Store;
const real = redis.pipeline.bind(redis);
let bend: "none" | "missing" | "null" | "text" = "none";
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (bend !== "none" && commands.length === 1 && commands[0][0] === "HSET" && commands[0][1] === leadsKey(STATS)) {
    return bend === "missing" ? [] : bend === "null" ? [null] : ["OK"];
  }
  return real(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  part("A lead's address is not erased when the HSET reply is unreadable");
  const id = leadId(STATS, email);
  const body = { id, aff: "aaaaaaaaaaaa", kind: "signup", at: 1, end: 0, ref: "", pi: "", paid: 0, title: "", email, cents: 500, currency: "usd", hold: 7 };
  for (const shape of ["missing", "null", "text"] as const) {
    bend = "none";
    redis.clear();
    await real([["HSET", leadsKey(STATS), id, JSON.stringify(body)]]);
    bend = shape;
    let outcome = "";
    try {
      outcome = `returned ${await forgetLeadPerson(store, email)}`;
    } catch {
      outcome = "threw";
    }
    const kept = (JSON.parse(String((await real([["HGET", leadsKey(STATS), id]]))[0])) as { email: string }).email;
    is(`${shape} reply: throws or the address is empty (${outcome}; address now "${kept}")`, outcome === "threw" || kept === "", true);
  }
  bend = "none";
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
