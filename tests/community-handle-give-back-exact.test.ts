/**
 * Controls beside Codex G's proof (tests/community-handle-reserve-unknown.test.ts,
 * review 5815559331 of #3123): when setProfile's member update after the handle
 * claim answers in no known shape, the handle is given back only when the
 * record, read in the same step, does not carry it.
 *
 * - applied: the CAS went in but its answer was lost. The record carries the
 *   new handle, so the handle stays tied to it, and the caller still sees the
 *   failure.
 * - double failure: the CAS did not go in and the give-back itself answers in
 *   no known shape ([] or a "1" that is text). The caller sees the original
 *   failure, never the give-back's; the handle stays (the stated limit).
 * - replaced: a change made at the same time wrote another handle, this one
 *   replaces it, and that one is given back while the record carries this one.
 */
import { freshConfig, memberKey, readMember, saveConfig, setProfile, type Member } from "@/lib/community";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

type Command = (string | number)[];
const CAS = 'local cur = redis.call("HGET"';
const GIVE_BACK = "-- marktmorgen:community-handle-give-back:v1\n";
let casMode: "apply" | "applied-lost" | "lost" = "apply";
let giveBackAnswer: null | unknown[] = null;
let beforeCas: null | (() => Promise<void>) = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith(GIVE_BACK) && giveBackAnswer) return giveBackAnswer;
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith(CAS)) {
    if (beforeCas) {
      const act = beforeCas;
      beforeCas = null;
      await act();
    }
    if (casMode === "lost") return [];
    // The member CAS as Redis runs it: no await between HGET, the comparison, HSET and the directory.
    const [, , , members, dir, field, expected, next, listed, at] = commands[0];
    if (redis.run(["HGET", members, field]) !== expected) return [0];
    redis.run(["HSET", members, field, next]);
    redis.run(listed === "1" ? ["ZADD", dir, at, field] : ["ZREM", dir, field]);
    return casMode === "applied-lost" ? [] : [1];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "club@handlegiveback.example";
  const made = await claimHandle(OWNER, "handlegivebackclub", "Handle Give Back Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_HandleGiveBack1", subscriptionId: "sub_HandleGiveBack1", active: true, tier: "creator", period: paidPeriod() });
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const cid = club.community!.id;
  await saveConfig(cid, freshConfig(club.name));
  const members = `nl:cm:${cid}:m`;
  const handles = `nl:cm:${cid}:h`;

  let n = 0;
  async function member(): Promise<{ key: string; email: string }> {
    n += 1;
    const email = `member${n}@handlegiveback.example`;
    const key = memberKey(email);
    const record: Member = { k: key, e: email, n: "", h: "", dir: false, mail: false, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] };
    await pipeline([["HSET", members, key, JSON.stringify(record)]]);
    return { key, email };
  }
  const handlesOf = async (key: string) => {
    const [flat] = (await pipeline([["HGETALL", handles]])) as [string[] | null];
    const out: string[] = [];
    for (let i = 0; flat && i + 1 < flat.length; i += 2) if (flat[i + 1] === key) out.push(flat[i]);
    return out.sort();
  };
  const profile = (name: string) => ({ name, dir: true, mail: false });
  const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

  {
    const m = await member();
    const snapshot = (await readMember(cid, m.key))!;
    casMode = "applied-lost";
    const outcome = await setProfile(cid, snapshot, profile("Applied Name"), club).then(() => "returned", failure);
    casMode = "apply";
    is("applied: the caller still sees the lost answer", outcome, "Redis answered a change to a community member record in an unknown shape");
    is("applied: the record carries the new handle", (await readMember(cid, m.key))?.h, "applied-name");
    is("applied: the handle it carries stays tied to it", await handlesOf(m.key), ["applied-name"]);
  }

  for (const [label, answer] of [["empty", []], ["text", ["1"]], ["unreadable record", [-1]]] as const) {
    const m = await member();
    const snapshot = (await readMember(cid, m.key))!;
    casMode = "lost";
    giveBackAnswer = [...answer];
    const outcome = await setProfile(cid, snapshot, profile(`Double ${n}`), club).then(() => "returned", failure);
    casMode = "apply";
    giveBackAnswer = null;
    is(`double failure (${label}): the caller sees the original failure`, outcome, "Redis answered a change to a community member record in an unknown shape");
    is(`double failure (${label}): nothing was written on the record`, (await readMember(cid, m.key))?.h, "");
    is(`double failure (${label}): the handle stays, the stated limit`, await handlesOf(m.key), [`double-${n}`]);
  }

  {
    const m = await member();
    const snapshot = (await readMember(cid, m.key))!;
    // A change made at the same time takes and writes "first-name" before this one's CAS.
    beforeCas = async () => {
      const current = (await readMember(cid, m.key))!;
      await pipeline([["HSET", handles, "first-name", m.key]]);
      await pipeline([["HSET", members, m.key, JSON.stringify({ ...current, n: "First Name", h: "first-name" })]]);
    };
    const saved = await setProfile(cid, snapshot, profile("Second Name"), club);
    is("replaced: this change is written", saved.h, "second-name");
    is("replaced: the record carries this change's handle", (await readMember(cid, m.key))?.h, "second-name");
    is("replaced: the replaced handle is given back, this one kept", await handlesOf(m.key), ["second-name"]);
  }
  done();
}
void main();
