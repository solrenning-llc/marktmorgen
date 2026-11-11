/**
 * Codex G on #3123 (review 5815399154): a member's stop link is made once and
 * kept. Two jobs that read the same member before the first token was written
 * (or a later job holding an old snapshot) must never replace a token that was
 * already confirmed and handed out for a message: every link returned by
 * tokenFor stays a working stop link, the token a member holds never changes,
 * and the losing job's unused index record is not left behind. G's proof is
 * kept byte-identical in tests/g3123-token-race-canonical.proof.ts.
 */
import { NextRequest } from "next/server";
import { POST as unsubscribePost } from "@/app/api/mail/unsubscribe/route";
import { freshConfig, memberKey, readMember, saveConfig, setMemberToken, type Member } from "@/lib/community";
import { readCommunityUnsub, tokenFor } from "@/lib/community-mail";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
let gate: null | (() => Promise<void>) = null;
let casReply: null | (() => unknown) = null;
const pipeline = redis.pipeline.bind(redis);
// The member CAS as Redis runs it: no await between HGET, the comparison, HSET and the directory.
redis.pipeline = (async (commands: Command[]) => {
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith('local cur = redis.call("HGET"')) {
    if (gate) await gate();
    if (casReply) return casReply();
    const [, , , members, dir, field, expected, next, listed, at] = commands[0];
    if (redis.run(["HGET", members, field]) !== expected) return [0];
    redis.run(["HSET", members, field, next]);
    redis.run(listed === "1" ? ["ZADD", dir, at, field] : ["ZREM", dir, field]);
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

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "club@tokenrace.example";
  const made = await claimHandle(OWNER, "tokenraceclub", "Token Race Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_TokenRace1", subscriptionId: "sub_TokenRace1", active: true, tier: "creator", period: paidPeriod() });
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const cid = club.community!.id;
  await saveConfig(cid, freshConfig(club.name));
  const members = `nl:cm:${cid}:m`;

  let n = 0;
  /** A member with their emails on and no stop link yet, as the first send finds them. */
  async function member(): Promise<{ key: string; email: string }> {
    n += 1;
    const email = `member${n}@tokenrace.example`;
    const key = memberKey(email);
    const record: Member = { k: key, e: email, n: `Member ${n}`, h: "", dir: false, mail: true, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] };
    await pipeline([["HSET", members, key, JSON.stringify(record)]]);
    return { key, email };
  }
  const mailOf = async (key: string) => (await readMember(cid, key))?.mail;
  const tokenOf = async (key: string) => (await readMember(cid, key))?.t;

  part("Two first stop links made at once from the same member snapshot");
  {
    const before = await unsubKeys();
    const m = await member();
    const first = (await readMember(cid, m.key))!;
    const second = { ...first };
    let entered = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => {
      release = r;
    });
    gate = async () => {
      entered++;
      if (entered === 2) release();
      await both;
    };
    const [a, b] = await Promise.all([tokenFor(club, cid, first), tokenFor(club, cid, second)]);
    gate = null;
    is("both jobs reached the write from the same old snapshot", [entered >= 2, a.length, b.length], [true, 40, 40]);
    is("both jobs embed the one token the member holds", [a === b, (await tokenOf(m.key)) === a], [true, true]);
    is("every returned link is a working stop link", (await Promise.all([readCommunityUnsub(a), readCommunityUnsub(b)])).map(Boolean), [true, true]);
    is("the losing job's unused link record is not left behind", (await unsubKeys()).filter((k) => !before.includes(k)), [`nl:cm:unsub:${a}`]);
    is("pressing the link from the second job stops the emails", await stopPress(b), [200, "Unsubscribed."]);
    is("the stop is saved", await mailOf(m.key), false);
  }

  part("A later job holding an old snapshot never replaces a link already sent");
  {
    const m = await member();
    const stale = (await readMember(cid, m.key))!;
    const sent = await tokenFor(club, cid, stale);
    const later = await tokenFor(club, cid, stale);
    is("the later job embeds the link already sent", later, sent);
    is("the member still holds the first link", await tokenOf(m.key), sent);
    is("the link already sent still stops the emails", [...(await stopPress(sent)), await mailOf(m.key)], [200, "Unsubscribed.", false]);
  }

  part("setMemberToken keeps a token that is already there and says which one");
  {
    const m = await member();
    const stale = (await readMember(cid, m.key))!;
    const kept = "1".repeat(40);
    is("an empty record takes the token", await setMemberToken(cid, stale, kept), kept);
    is("a second token for the same member is not written", await setMemberToken(cid, stale, "2".repeat(40)), kept);
    is("the record still holds the first", await tokenOf(m.key), kept);
  }

  part("An off-shape CAS answer is never read as a kept token (rule 24)");
  {
    const m = await member();
    const stale = (await readMember(cid, m.key))!;
    for (const reply of [[undefined], ["1"], [], null]) {
      casReply = () => reply;
      const thrown = await setMemberToken(cid, stale, "3".repeat(40)).then(
        () => "returned",
        (e: unknown) => (e instanceof UnknownReplyError ? "unknown" : String(e)),
      );
      casReply = null;
      is(`CAS answered ${JSON.stringify(reply)} throws`, thrown, "unknown");
    }
    is("nothing was kept on the record", await tokenOf(m.key), "");
  }

  part("A member with no record gets no stop link");
  {
    const ghost: Member = { k: memberKey("ghost@tokenrace.example"), e: "ghost@tokenrace.example", n: "", h: "", dir: false, mail: true, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] };
    const before = await unsubKeys();
    const thrown = await tokenFor(club, cid, ghost).then(() => "returned", () => "threw");
    is("tokenFor refuses a member Redis says is not there", thrown, "threw");
    is("and leaves no link record behind", (await unsubKeys()).filter((k) => !before.includes(k)), []);
  }
  done();
}
void main();
