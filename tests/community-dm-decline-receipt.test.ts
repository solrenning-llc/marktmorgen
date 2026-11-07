/**
 * Saying no to private messages is only said done when Redis confirmed it
 * (CX-123 rule 24; consent).
 *
 * lib/community-dm.ts decline() wrote the refusal (SADD to the person's
 * declined set) in the same pipeline as the request's removal and never read
 * its reply: an SADD answered in an unknown shape, or lost, still answered
 * true, the page said "Declined. It is gone, and they cannot ask again.",
 * and the person declined could write again. The SADD is now written first,
 * on its own, and read as an exact 0 or 1; anything else throws
 * UnknownReplyError before the request is taken away, so the route answers
 * 503 "We could not confirm that this went through" and a second try finds
 * the request still there and finishes it (SADD is idempotent). The removal's
 * own replies are read as counts too.
 *
 * Rule 30, same file and flow: unblock() answered "They can write to you
 * again." on an SREM reply nobody could read. It now throws the same way.
 *
 * Rule 30, the community's other consent writes: lib/community.ts
 * patchMember() read a member's record with HGET and took any reply that was
 * not a string for "no such member", so setMail() (a community email's stop
 * link) and moderateMember() (mute) wrote nothing and still answered: the
 * one-click stop said "Unsubscribed." while the announcements stayed on. For
 * those two, a reply that is neither a record nor an exact null now throws
 * UnknownReplyError before any write; the stop door answers 503 "We could not
 * save that just now" (as the reminder and review stops already do), and the
 * community route's own catch says "Nothing was changed".
 *
 * Synthetic only: the in-memory Redis stand-in, with one reply made unknown
 * or one command lost.
 */
import { NextRequest } from "next/server";
import { decline, declinedBy, inbox, parseDmSetting, send, unblock } from "@/lib/community-dm";
import { freshConfig, moderateMember, readMember, saveConfig } from "@/lib/community";
import { stopAnnouncements } from "@/lib/community-mail";
import { POST as unsubscribeRoute } from "@/app/api/mail/unsubscribe/route";
import { communityViewer } from "@/lib/community-access";
import { communityWords } from "@/lib/buyer-words/community";
import { emailKey, mintPass, passCookieName } from "@/lib/learn";
import { POST as messagesRoute } from "@/app/api/store/community/messages/route";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];

/**
 * The reply `bad` stands in for the command `match` picks, in every pipeline.
 * With `lost`, the command never reaches the store (a write that did not
 * happen); without it, the command runs and only its reply is unknown.
 */
let swap: { match: (command: Command) => boolean; bad: unknown; lost?: boolean } | null = null;
const stub = redis.pipeline.bind(redis);
/**
 * The stand-in runs only the EVALs it knows; lib/community.ts patchMember's
 * compare-and-set of a member's record (CAS_MEMBER) is run here, with the
 * same plain commands the script runs, one command at a time.
 */
const isMemberCas = (c: Command) => c[0] === "EVAL" && String(c[1]).includes('if cur ~= ARGV[2] then return 0 end');
async function memberCas(c: Command): Promise<number> {
  const [, , , members, dir, key, raw, next, listed, at] = c;
  const [cur] = await stub([["HGET", members, key]]);
  if (cur !== raw) return 0;
  await stub([["HSET", members, key, next], listed === "1" ? ["ZADD", dir, at, key] : ["ZREM", dir, key]]);
  return 1;
}
const real = async (commands: Command[]): Promise<unknown[]> => {
  if (!commands.some(isMemberCas)) return stub(commands);
  const out: unknown[] = [];
  for (const command of commands) out.push(isMemberCas(command) ? await memberCas(command) : (await stub([command]))[0]);
  return out;
};
/** Matches only the nth command `match` picks (1 is the first), counting from when it is made. */
const nth = (match: (command: Command) => boolean, n: number) => {
  let count = 0;
  return (command: Command) => match(command) && (count += 1) === n;
};
redis.pipeline = (async (commands: Command[]) => {
  if (!swap) return real(commands);
  const rule = swap;
  // Decided once per command, so a counting match is asked exactly once each.
  const picked = commands.map((c) => rule.match(c));
  const kept = rule.lost ? commands.filter((_, i) => !picked[i]) : commands;
  const replies = await real(kept);
  let at = 0;
  return commands.map((_, i) => {
    if (picked[i]) {
      if (!rule.lost) at += 1;
      return rule.bad;
    }
    return replies[at++];
  });
}) as typeof redis.pipeline;

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

/** Replies that are not an exact 0 or 1. */
const UNKNOWN: [string, unknown][] = [
  ["null", null],
  ["undefined", undefined],
  ["the text \"1\"", "1"],
  ["true", true],
  ["a list [1]", [1]],
  ["an object", { result: 1 }],
  ["two", 2],
  ["minus one", -1],
  ["one and a half", 1.5],
];

const verbIs = (verb: string, part: string) => (command: Command) => command[0] === verb && String(command[1]).includes(part);

/** What a call answered, or the name of what it threw. */
async function outcome<T>(call: () => Promise<T>): Promise<T | string> {
  const quiet = console.error;
  console.error = () => {};
  try {
    return await call();
  } catch (error) {
    return `threw ${error instanceof Error ? error.name : "something"}`;
  } finally {
    console.error = quiet;
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  const ID = "cmdeclinercpt";
  const BIA = "b2b2b2b2b2b2";
  const open = parseDmSetting({ on: true, between: true, ask: true });
  let next = 0;
  /** A fresh stranger, with one request waiting on Bia. */
  const stranger = async (): Promise<{ who: string; pair: string }> => {
    const who = (0xa00000000000 + (next += 1)).toString(16);
    is(`control: ${who} asks Bia`, await send(ID, open, who, BIA, "Hello Bia", ROOM), { ok: true, asked: true });
    const pair = (await inbox(ID, BIA, true)).find((c) => c.other === who)?.pair ?? "";
    return { who, pair };
  };

  part("lib/community-dm.ts decline(): an SADD reply that is not an exact 0 or 1 is never said declined");
  {
    for (const [label, bad] of UNKNOWN) {
      const { pair } = await stranger();
      swap = { match: verbIs("SADD", ":dm:x:"), bad };
      const got = await outcome(() => decline(ID, BIA, pair, ROOM));
      swap = null;
      is(`SADD answered ${label}: not declined, unknown`, got, "threw UnknownReplyError");
    }
  }

  part("A refusal that was lost is never said done, and a second try finishes it");
  {
    const { who, pair } = await stranger();
    swap = { match: verbIs("SADD", ":dm:x:"), bad: undefined, lost: true };
    const got = await outcome(() => decline(ID, BIA, pair, ROOM));
    swap = null;
    is("lost SADD: not declined, unknown", got, "threw UnknownReplyError");
    is("the request still waits, so the person can try again", (await inbox(ID, BIA, true)).some((c) => c.pair === pair), true);
    is("second try with exact replies: declined", await decline(ID, BIA, pair, ROOM), true);
    is("they are in Bia's declined list", (await declinedBy(ID, BIA)).includes(who), true);
    is("and cannot write to her again", await send(ID, open, who, BIA, "hello? hello?", ROOM), { ok: false, reason: "declined" });
    is("a third try is harmless: the request is gone", await decline(ID, BIA, pair, ROOM), false);
  }

  part("The removal's own replies are read as counts (rule 30)");
  {
    for (const [verb, keyPart] of [["ZREM", ":dm:q:"], ["ZREM", ":dm:i:"], ["DEL", ":dm:"]] as const) {
      const { who, pair } = await stranger();
      swap = { match: verbIs(verb, keyPart), bad: { result: 1 } };
      const got = await outcome(() => decline(ID, BIA, pair, ROOM));
      swap = null;
      is(`${verb} ${keyPart} answered an object: unknown, not said gone`, got, "threw UnknownReplyError");
      is(`but the refusal was confirmed first: ${who} cannot write again`, await send(ID, open, who, BIA, "again", ROOM), { ok: false, reason: "declined" });
    }
  }

  part("unblock(): an SREM reply nobody can read is never said done (rule 30)");
  {
    const { who, pair } = await stranger();
    is("control: Bia declines", await decline(ID, BIA, pair, ROOM), true);
    for (const [label, bad] of UNKNOWN) {
      swap = { match: verbIs("SREM", ":dm:x:"), bad, lost: true };
      const got = await outcome(() => unblock(ID, BIA, who, ROOM));
      swap = null;
      is(`SREM answered ${label}: unknown, not said done`, got, "threw UnknownReplyError");
    }
    is("still declined after every unknown answer", (await declinedBy(ID, BIA)).includes(who), true);
    is("control: an exact SREM lets them write again", [await unblock(ID, BIA, who, ROOM), (await declinedBy(ID, BIA)).includes(who)], [undefined, false]);
    is("control: unblocking twice is harmless", await unblock(ID, BIA, who, ROOM), undefined);
  }

  part("app/api/store/community/messages/route.ts: 503 'could not confirm', never 'Declined' or 'They can write to you again'");
  {
    const CLUB = "club@dmdeclinercpt.example";
    const MEMBER = "member@dmdeclinercpt.example";
    const made = await claimHandle(CLUB, "dmdeclinercptclub", "Decline Receipt Club", "");
    if (!made.ok) throw new Error("no club store");
    await ensureStatsId(CLUB);
    await ensureStoreId(CLUB);
    await ensureListId(CLUB);
    await setSubscription(CLUB, { customerId: "cus_DmDeclineRcpt1", subscriptionId: "sub_DmDeclineRcpt1", active: true, tier: "creator", period: paidPeriod() });
    const ticket = await addProduct(CLUB, "Club pass", "", "0", null);
    if (!ticket.ok) throw new Error("no product");
    await setCommunity(CLUB, true);
    const club: Store = (await storeForEmail(CLUB))!;
    const cid = club.community!.id;
    const setting = parseDmSetting({ on: true, between: true, ask: true });
    await saveConfig(cid, { ...freshConfig(club.name), access: [ticket.product.id], dm: setting });
    await real([["SET", `nl:cm:${cid}:ok:${emailKey(MEMBER)}`, JSON.stringify({ v: 1, ok: true })]]);
    const cookie = `${passCookieName(club)}=${await mintPass(club, MEMBER, "all")}`;
    const viewer = await communityViewer(club, { get: (name: string) => (name === passCookieName(club) ? { value: cookie.split("=")[1] } : undefined) } as never);
    if (viewer.state !== "in" || !viewer.member) throw new Error("the member is not in: " + viewer.state);
    if (!(await readMember(cid, viewer.key))) throw new Error("no member");
    const ANA = "a1a1a1a1a1a1";
    is("control: Ana asks the member", await send(cid, setting, ANA, viewer.key, "Hello", ROOM), { ok: true, asked: true });
    const pair = (await inbox(cid, viewer.key, true))[0]?.pair ?? "";
    const words = communityWords("en").notices;
    const post = (action: string) =>
      messagesRoute(
        new NextRequest("https://marktmorgen.com/api/store/community/messages", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://marktmorgen.com", Host: "marktmorgen.com", cookie },
          body: new URLSearchParams({ handle: club.handle, action, pair }).toString(),
        }),
      );
    const read = async (action: string) => {
      const got = await outcome(() => post(action));
      if (typeof got === "string") return got;
      return { status: got.status, notice: /n=([a-z]+)/.exec(got.headers.get("location") ?? "")?.[1] ?? null, body: got.status === 303 ? "" : await got.text() };
    };
    swap = { match: verbIs("SADD", ":dm:x:"), bad: undefined, lost: true };
    is("decline with a lost SADD: 503 'could not confirm', not 'Declined'", await read("decline"), { status: 503, notice: null, body: words.unconfirmed });
    swap = null;
    is("Ana's request still waits on the member", (await inbox(cid, viewer.key, true)).some((c) => c.pair === pair), true);
    is("control: the second try declines", await read("decline"), { status: 303, notice: "dmdeclined", body: "" });
    is("and Ana cannot write again", await send(cid, setting, ANA, viewer.key, "again", ROOM), { ok: false, reason: "declined" });
    swap = { match: verbIs("SREM", ":dm:x:"), bad: undefined, lost: true };
    is("unblock with a lost SREM: 503 'could not confirm', not 'They can write to you again'", await read("unblock"), { status: 503, notice: null, body: words.unconfirmed });
    swap = null;
    is("Ana is still declined", await send(cid, setting, ANA, viewer.key, "still?", ROOM), { ok: false, reason: "declined" });
    is("control: the second try unblocks", await read("unblock"), { status: 303, notice: "dmunblocked", body: "" });
  }

  part("Rule 30: a community email's stop link is never said done on a member record nobody could read");
  {
    const CM = "cmstoprcpt";
    const KEY = "f".repeat(32);
    const TOKEN = "e".repeat(40);
    const member = { k: KEY, e: "stop@dmdeclinercpt.example", n: "Stop", h: "", dir: false, mail: true, at: 1, seen: 1, muted: false, removed: false, t: TOKEN, q: [], qa: 0, qq: [] };
    await real([["HSET", `nl:cm:${CM}:m`, KEY, JSON.stringify(member)], ["SET", `nl:cm:unsub:${TOKEN}`, `${CM}|${KEY}|stopclub`]]);
    // The first HGET finds the link's member; the second is the read before the write.
    const writeRead = (command: Command) => command[0] === "HGET" && command[1] === `nl:cm:${CM}:m`;
    for (const [label, bad] of UNKNOWN.filter(([, bad]) => bad !== null)) {
      swap = { match: nth(writeRead, 2), bad };
      const got = await outcome(() => stopAnnouncements(TOKEN));
      swap = null;
      is(`the record's read answered ${label}: unknown, not stopped`, got, "threw UnknownReplyError");
    }
    is("the announcements are still on, as nothing was written", (await readMember(CM, KEY))?.mail, true);
    const oneClick = () =>
      unsubscribeRoute(
        new NextRequest(`https://marktmorgen.com/api/mail/unsubscribe?c=${TOKEN}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://marktmorgen.com", Host: "marktmorgen.com" },
          body: "List-Unsubscribe=One-Click",
        }),
      );
    swap = { match: nth(writeRead, 2), bad: { result: "lost" } };
    const failed = await outcome(oneClick);
    swap = null;
    is(
      "one-click stop on an unknown read: 503 'could not save', never 'Unsubscribed.'",
      typeof failed === "string" ? failed : [failed.status, await failed.text()],
      [503, "We could not save that just now. Please try again in a minute."],
    );
    is("still on", (await readMember(CM, KEY))?.mail, true);
    const ok = await oneClick();
    is("control: exact replies, 'Unsubscribed.'", [ok.status, await ok.text()], [200, "Unsubscribed."]);
    is("control: the announcements are off", (await readMember(CM, KEY))?.mail, false);

    part("Rule 30: a mute is never said done on a member record nobody could read");
    for (const [label, bad] of UNKNOWN.filter(([, bad]) => bad !== null)) {
      swap = { match: nth(writeRead, 1), bad };
      const got = await outcome(() => moderateMember(CM, KEY, { muted: true }));
      swap = null;
      is(`the record's read answered ${label}: unknown, not muted`, got, "threw UnknownReplyError");
    }
    is("not muted, as nothing was written", (await readMember(CM, KEY))?.muted, false);
    is("control: an absent member is still null (nothing to mute)", await moderateMember(CM, "0".repeat(32), { muted: true }), null);
    is("control: exact replies mute", (await moderateMember(CM, KEY, { muted: true }))?.muted, true);
  }

  done();
}

main();
