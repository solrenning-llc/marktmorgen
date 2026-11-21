import { createHash } from "node:crypto";
import { FORM_RESPONSE_ID, type FormResponse } from "@/lib/forms";
import { MAX_DEALS, parseDeal, type Deal, type Stage } from "@/lib/crm-rules";
import { dealBytes, dealSlot } from "@/lib/crm";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, listSlots, repliesFor } from "@/lib/redis-reply";

export const MAX_CONVERTIBLE_FORM_RESPONSES = 50;

/** New responses use a server identity; legacy records keep their original content fingerprint. */
export function formOpportunityRef(statsId: string, formId: string, response: FormResponse): string {
  if (response.id && FORM_RESPONSE_ID.test(response.id)) return createHash("sha256").update(JSON.stringify([statsId, formId, "response-v1", response.id])).digest("hex");
  const answers = Object.entries(response.answers).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHash("sha256").update(JSON.stringify([statsId, formId, response.at, response.page, answers, response.outcome, response.joined])).digest("hex");
}

/** One hash, one mutation: capacity and absence are checked in the same Redis operation. */
export const CREATE_FORM_OPPORTUNITY = `-- marktmorgen:form-opportunity:v1
local existing = redis.call("HGET", KEYS[1], ARGV[1])
if existing then return {0, existing} end
if redis.call("HLEN", KEYS[1]) >= tonumber(ARGV[3]) then return {-1, ""} end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
return {1, ARGV[2]}`;

export async function createFormOpportunity(statsId: string, ref: string, draft: Deal, stages: readonly Stage[], room: DataStore): Promise<{ state: "created" | "existing"; deal: Deal } | { state: "full" }> {
  if (!statsId || !/^[a-f0-9]{64}$/.test(ref)) throw new Error("Invalid form opportunity identity");
  const id = ref.slice(0, 10);
  const deal = { ...draft, id, formResponseRef: ref };
  // Its room is taken first (DataRoomError when it does not fit), and given back only when the write answered,
  // exactly, that the CRM is full (CX-123 rule 24): a reply in another shape may have landed. The read before it is
  // never taken as "none": a deal that may already exist, larger than this draft, would have its room set to the
  // draft's (Codex Z on #3305), so a read that fails refuses before the room is touched. The store never counts less
  // than it keeps.
  const before = await readFormOpportunity(statsId, ref, stages);
  if (!before) await needData(room, [{ slot: dealSlot(id), bytes: dealBytes(deal), set: true }]);
  const replies = repliesFor(await redisPipeline([["EVAL", CREATE_FORM_OPPORTUNITY, 1, "nl:crm:deals:" + statsId, id, JSON.stringify(deal), MAX_DEALS]]), 1);
  const pair = replies ? listSlots(replies[0]) : null;
  if (!pair || pair.length !== 2) throw new UnknownReplyError("the form opportunity write");
  const [code, record] = pair;
  if (code === -1 && record === "") {
    if (!before) await giveData(room, [{ slot: dealSlot(id), bytes: 0, set: true }]);
    return { state: "full" };
  }
  if ((code !== 0 && code !== 1) || typeof record !== "string") throw new UnknownReplyError("the form opportunity write");
  const saved = parseDeal(JSON.parse(record), stages);
  if (!saved || saved.id !== id || saved.formResponseRef !== ref) throw new Error("Form opportunity identity conflict");
  return { state: code === 1 ? "created" : "existing", deal: saved };
}

/** Recover a committed conversion even after its source leaves the recent-response window. */
export async function readFormOpportunity(statsId: string, ref: string, stages: readonly Stage[]): Promise<Deal | null> {
  if (!statsId || !/^[a-f0-9]{64}$/.test(ref)) throw new Error("Invalid form opportunity identity");
  const id = ref.slice(0, 10);
  const result = await redisPipeline([["HGET", "nl:crm:deals:" + statsId, id]]);
  if (!Array.isArray(result) || result.length !== 1) throw new Error("Form opportunity read unconfirmed");
  if (result[0] === null) return null;
  if (typeof result[0] !== "string") throw new Error("Form opportunity read unconfirmed");
  const saved = parseDeal(JSON.parse(result[0]), stages);
  if (!saved || saved.id !== id || saved.formResponseRef !== ref) throw new Error("Form opportunity identity conflict");
  return saved;
}
