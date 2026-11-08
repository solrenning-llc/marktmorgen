/** Independent review evidence only. Synthetic Redis, real reader and copier; no vendor or whole-copy claim. */
import { COPIERS } from "@/lib/person-copy";
import { leadId, readLeads } from "@/lib/affiliate-leads";
import { leadsKey, type LeadRecord } from "@/lib/affiliate-lead-rules";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const store = { statsId: "z3157synthetic" } as Store;
const key = leadsKey(store.statsId!);
const email = "person.a@example.com";
const own = leadId(store.statsId!, email);
const other = leadId(store.statsId!, "person.b@example.com");
const lead = (id: string, address: string): LeadRecord => ({
  id, aff: "aaaaaaaaaaaa", kind: "signup", at: 1_780_000_000, end: 0,
  ref: "", pi: "", paid: 0, title: "", email: address, cents: 500,
  currency: "usd", hold: 7, daily: 10, budget: 1_000, state: "open", d: 0, why: "",
});
const pipeline = redis.pipeline.bind(redis);
let injected = false;
let answer: unknown;
const observations: { commands: number; requestJsonBytes: number; replyJsonBytes: number }[] = [];
redis.pipeline = (async (commands: (string | number)[][]) => {
  const result = injected ? answer : await pipeline(commands);
  observations.push({ commands: commands.length, requestJsonBytes: Buffer.byteLength(JSON.stringify(commands)), replyJsonBytes: Buffer.byteLength(JSON.stringify(result) ?? "") });
  return result;
}) as typeof redis.pipeline;
const copier = COPIERS["lib/affiliate-leads.ts"];
const scope = { store, email } as Parameters<typeof copier>[0];
async function copy(): Promise<string[] | string> {
  try { return (await copier(scope) as LeadRecord[]).map((row) => row.id); }
  catch (error) { return error instanceof UnknownReplyError ? "unknown" : `other:${String(error)}`; }
}
async function put(rows: [string, string][]): Promise<void> {
  await pipeline([["DEL", key]]);
  if (rows.length) await pipeline([["HSET", key, ...rows.flat()]]);
}
async function main(): Promise<void> {
  part("C4 LOW 6716917431: a healthy person's copy survives another person's unreadable lead");
  await put([[own, JSON.stringify(lead(own, email))], [other, JSON.stringify(lead(other, "person.b@example.com"))]]);
  is("healthy two-person control: only A is copied", await copy(), [own]);
  for (const [name, raw] of [
    ["text amount", JSON.stringify({ ...lead(other, "person.b@example.com"), cents: "500" })],
    ["broken JSON", '{"email":"person.b@example.com","cents":500,'],
  ]) {
    await put([[own, JSON.stringify(lead(own, email))], [other, raw]]);
    is(`${name}: A's own healthy lead remains copyable`, await copy(), [own]);
  }
  await put([[own, '{"email":"person.a@example.com","cents":500,']]);
  is("own unreadable lead: unknown, never an apparently complete empty copy", await copy(), "unknown");
  await put([]);
  is("exact empty healthy control", await copy(), []);

  part("Exact envelope controls: no missing, extra or non-string reply is treated as empty");
  injected = true;
  const hole = new Array(1);
  for (const [name, reply] of [
    ["missing outer reply", []], ["extra outer reply", [[], []]], ["nil HGETALL", [null]],
    ["numeric HGETALL", [0]], ["outer hole", hole], ["non-string field", [[1, JSON.stringify(lead(own, email))]]],
  ] as [string, unknown][]) {
    answer = reply;
    let outcome: unknown;
    try { outcome = await readLeads(store); }
    catch (error) { outcome = error instanceof UnknownReplyError ? "unknown" : `other:${String(error)}`; }
    is(`${name}: read is unknown`, outcome, "unknown");
  }
  injected = false;
  console.log("Z_DIRECT_READ_VOLUMES", JSON.stringify(observations));
  done();
}
void main();
