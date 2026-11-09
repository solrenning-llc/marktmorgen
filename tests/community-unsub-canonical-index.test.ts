/**
 * Codex G on #3123 (review 5815472405): a stop-link record is written only for
 * the token the member's record holds (made canonical first, by the member
 * CAS), so no record of a token that never became the member's is left for
 * the erasure to miss. These are the author's checks of the paths around it:
 * a canonical token whose record is missing is given one, a member erased in
 * between never keeps one, and every reply is read in its exact shape (CX-123
 * rule 24). G's proofs are kept byte-identical in
 * tests/community-unsub-erasure-orphan.test.ts and
 * tests/community-unsub-erasure-after-cas.test.ts.
 */
import { NextRequest } from "next/server";
import { POST as unsubscribePost } from "@/app/api/mail/unsubscribe/route";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { freshConfig, memberKey, readMember, saveConfig, type Member } from "@/lib/community";
import { readCommunityUnsub, tokenFor } from "@/lib/community-mail";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
/** Answers in place of Redis for the first command it matches, then steps aside. */
let swap: null | ((commands: Command[]) => unknown | undefined) = null;
let afterCas: null | (() => Promise<void>) = null;
const indexWrites: string[] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  if (swap) {
    const answer = swap(commands);
    if (answer !== undefined) {
      swap = null;
      return answer;
    }
  }
  for (const command of commands) {
    if (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:order-write:v1")) {
      for (const arg of command.slice(3)) if (String(arg).startsWith("nl:cm:unsub:")) indexWrites.push(String(arg).slice("nl:cm:unsub:".length));
    }
  }
  // The member CAS as Redis runs it: no await between HGET, the comparison, HSET and the directory.
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith('local cur = redis.call("HGET"')) {
    const [, , , members, dir, field, expected, next, listed, at] = commands[0];
    if (redis.run(["HGET", members, field]) !== expected) return [0];
    redis.run(["HSET", members, field, next]);
    redis.run(listed === "1" ? ["ZADD", dir, at, field] : ["ZREM", dir, field]);
    if (afterCas) {
      const act = afterCas;
      afterCas = null;
      await act();
    }
    return [1];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

async function stopPress(token: string): Promise<[number, string]> {
  const response = await unsubscribePost(new NextRequest(`https://marktmorgen.com/api/mail/unsubscribe?c=${token}`, { method: "POST", body: new FormData() }));
  return [response.status, await response.text()];
}
const unsubKeys = async () => ((await pipeline([["SCAN", "0", "MATCH", "nl:cm:unsub:*"]])) as [[string, string[]]])[0][1].sort();
const outcome = (p: Promise<unknown>) => p.then(() => "returned", (e: unknown) => (e instanceof UnknownReplyError ? "unknown" : "threw"));
const isIndexGet = (commands: Command[]) => commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:cm:unsub:");
const isIndexSet = (commands: Command[]) =>
  commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:order-write:v1") && commands[0].some((a) => String(a).startsWith("nl:cm:unsub:"));
const isIndexDel = (commands: Command[]) => commands.length === 1 && commands[0][0] === "DEL" && String(commands[0][1]).startsWith("nl:cm:unsub:");

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "club@canonicalindex.example";
  const made = await claimHandle(OWNER, "canonicalindexclub", "Canonical Index Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_CanonicalIndex1", subscriptionId: "sub_CanonicalIndex1", active: true, tier: "creator", period: paidPeriod() });
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const cid = club.community!.id;
  await saveConfig(cid, freshConfig(club.name));
  const members = `nl:cm:${cid}:m`;

  let n = 0;
  /** A member with their emails on, holding `t` (no link record is written here). */
  async function member(t = ""): Promise<{ key: string; email: string }> {
    n += 1;
    const email = `member${n}@canonicalindex.example`;
    const key = memberKey(email);
    const record: Member = { k: key, e: email, n: `Member ${n}`, h: "", dir: false, mail: true, at: 1, seen: 1, muted: false, removed: false, t, q: [], qa: 0, qq: [] };
    await pipeline([["HSET", members, key, JSON.stringify(record)]]);
    return { key, email };
  }
  const mailOf = async (key: string) => (await readMember(cid, key))?.mail;

  part("Only the token the member holds is ever given a link record");
  {
    indexWrites.length = 0;
    const m = await member();
    const stale = (await readMember(cid, m.key))!;
    const first = await tokenFor(club, cid, stale);
    const second = await tokenFor(club, cid, stale);
    is("both sends embed the member's one token", [second, (await readMember(cid, m.key))?.t], [first, first]);
    is("no record was ever written for another token", [...new Set(indexWrites)], [first]);
    is("the second send writes nothing: the record is already there", indexWrites.length, 1);
  }

  part("A canonical token whose record is missing gets one (a send stopped after the CAS)");
  {
    const token = "4".repeat(40);
    const m = await member(token);
    const before = await unsubKeys();
    const fresh = (await readMember(cid, m.key))!;
    is("the member's own token is returned", await tokenFor(club, cid, fresh), token);
    is("its record is written, and only it", (await unsubKeys()).filter((k) => !before.includes(k)), [`nl:cm:unsub:${token}`]);
    is("the link stops the emails", [...(await stopPress(token)), await mailOf(m.key)], [200, "Unsubscribed.", false]);
  }

  part("A record that could not be written is never returned as a link (rule 24)");
  {
    const m = await member();
    const stale = (await readMember(cid, m.key))!;
    swap = (c) => (isIndexSet(c) ? [[16, "QUEUED"]] : undefined);
    is("an off-shape SET NX reply throws", await outcome(tokenFor(club, cid, stale)), "unknown");
    const kept = (await readMember(cid, m.key))!.t;
    is("the token stays canonical on the record", kept.length, 40);
    is("a later send writes its record and embeds the same token", await tokenFor(club, cid, (await readMember(cid, m.key))!), kept);
    is("and it is a working link", Boolean(await readCommunityUnsub(kept)), true);
  }

  part("An off-shape or foreign read of the record throws");
  {
    for (const reply of [[], [1], null, ["somebody|else|handle"]]) {
      const m = await member("5".repeat(39) + String(n % 10));
      swap = (c) => (isIndexGet(c) ? reply : undefined);
      is(`GET answered ${JSON.stringify(reply)}`, await outcome(tokenFor(club, cid, (await readMember(cid, m.key))!)), "unknown");
    }
  }

  part("A send holding the token of a member erased since then leaves no record");
  {
    const token = "6".repeat(40);
    const m = await member(token);
    const snapshot = (await readMember(cid, m.key))!;
    await forgetCommunityPerson(cid, m.key, m.email, []);
    const before = await unsubKeys();
    is("tokenFor refuses", await outcome(tokenFor(club, cid, snapshot)), "threw");
    is("nothing of the erased member is written back", [(await unsubKeys()).filter((k) => !before.includes(k)), await readMember(cid, m.key)], [[], null]);
  }

  part("An erasure between the CAS and the record: the cleanup's reply is confirmed");
  {
    const m = await member();
    const stale = (await readMember(cid, m.key))!;
    const before = await unsubKeys();
    afterCas = async () => {
      await forgetCommunityPerson(cid, m.key, m.email, []);
      // Only the cleanup's own delete, after the erasure finished, answers off-shape.
      swap = (c) => (isIndexDel(c) ? [] : undefined);
    };
    is("an unconfirmed delete is never read as done", await outcome(tokenFor(club, cid, stale)), "unknown");
    const left = (await unsubKeys()).filter((k) => !before.includes(k));
    if (left.length) await pipeline([["DEL", ...left]]);
    const again = await member();
    const staleAgain = (await readMember(cid, again.key))!;
    afterCas = async () => void (await forgetCommunityPerson(cid, again.key, again.email, []));
    is("with a healthy delete the call refuses", await outcome(tokenFor(club, cid, staleAgain)), "threw");
    is("and nothing is left", (await unsubKeys()).filter((k) => !before.includes(k)), []);
  }
  done();
}
void main();
