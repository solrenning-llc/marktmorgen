/**
 * A person who declined somebody's private messages is never written to again
 * on a reply nobody can read (CX-123 rule 24; consent).
 *
 * lib/community-dm.ts send() asked Redis, in one pipeline, whether the sender
 * was declined (SISMEMBER), whether the two had spoken (EXISTS) and how many
 * conversations the receiver has (ZCARD), and read them with Number(...): a
 * declined reply that was missing, cut short or of another shape read as
 * "not declined", so somebody who said no got the message anyway. Each of the
 * three is now read in its exact shape; anything else refuses the message
 * with UnknownReplyError before anything is written, and the route answers
 * 503 with the community's "Nothing was changed; try again" in the store's
 * language. The answer is the same whether or not the sender was declined, so
 * it never tells them they were.
 *
 * Synthetic only: the in-memory Redis stand-in, with one reply made unknown.
 */
import { NextRequest } from "next/server";
import { decline, inbox, parseDmSetting, send } from "@/lib/community-dm";
import { CREATOR, freshConfig, readMember, saveConfig } from "@/lib/community";
import { communityViewer } from "@/lib/community-access";
import { communityWords } from "@/lib/buyer-words/community";
import { emailKey, mintPass, passCookieName } from "@/lib/learn";
import { POST as messagesRoute } from "@/app/api/store/community/messages/route";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setLanguage, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];

/** The reply `bad` stands in for the command `match` picks, in every pipeline; the command itself still runs. */
let swap: { match: (command: Command) => boolean; bad: unknown } | null = null;
/** Every command that reached the store, to see what was written. */
const seen: Command[] = [];
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  seen.push(...commands);
  const replies = await real(commands);
  return swap ? replies.map((reply: unknown, i: number) => (swap!.match(commands[i]) ? swap!.bad : reply)) : replies;
}) as typeof redis.pipeline;

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

/** Replies that are not an exact 0 or 1. */
const UNKNOWN: [string, unknown][] = [
  ["null", null],
  ["undefined", undefined],
  ["the text \"1\"", "1"],
  ["the text \"0\"", "0"],
  ["true", true],
  ["false", false],
  ["a list [1]", [1]],
  ["an object", { result: 1 }],
  ["two", 2],
  ["minus one", -1],
  ["one and a half", 1.5],
  ["an empty text", ""],
];

const verbIs = (verb: string, part: string) => (command: Command) => command[0] === verb && String(command[1]).includes(part);
/** The message lists written since `from` (a message went to somebody). */
const pushedSince = (from: number) => seen.slice(from).filter((c) => c[0] === "RPUSH" && String(c[1]).includes(":dm:")).length;

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
  const ID = "cmdeclined";
  const ANA = "a1a1a1a1a1a1";
  const BIA = "b2b2b2b2b2b2";
  const CARLA = "c3c3c3c3c3c3";
  const open = parseDmSetting({ on: true, between: true, ask: true });

  part("lib/community-dm.ts send(): a declined reply that cannot be read never lets the message through");
  {
    const asked = await send(ID, open, ANA, BIA, "Hello Bia", ROOM);
    is("control: a stranger's first message is a request", asked, { ok: true, asked: true });
    const pair = (await inbox(ID, BIA, true))[0]?.pair ?? "";
    is("control: Bia declines it", await decline(ID, BIA, pair, ROOM), true);
    {
      const from = seen.length;
      is("control: an exact 1 is declined, nothing written", [await send(ID, open, ANA, BIA, "again", ROOM), pushedSince(from)], [{ ok: false, reason: "declined" }, 0]);
    }
    for (const [label, bad] of UNKNOWN) {
      swap = { match: verbIs("SISMEMBER", ":dm:x:"), bad };
      const from = seen.length;
      const got = await outcome(() => send(ID, open, ANA, BIA, `are you there? (${label})`, ROOM));
      swap = null;
      is(`declined answered ${label}: refused as unknown, nothing written`, [got, pushedSince(from)], ["threw UnknownReplyError", 0]);
    }
    is("Bia still has no request from Ana", (await inbox(ID, BIA, true)).length, 0);
    is("and no conversation with her", (await inbox(ID, BIA)).length, 0);
  }

  part("The same pipeline's other two replies are read exactly too (rule 30)");
  {
    for (const [verb, keyPart] of [["EXISTS", ":dm:"], ["ZCARD", ":dm:i:"]] as const) {
      // ZCARD is a count: two is a known size there, so only the shapes that are not a whole number from zero are unknown.
      for (const [label, bad] of UNKNOWN.filter(([, bad]) => verb === "EXISTS" || bad !== 2)) {
        swap = { match: verbIs(verb, keyPart), bad };
        const from = seen.length;
        const got = await outcome(() => send(ID, open, CARLA, BIA, `hello (${verb} ${label})`, ROOM));
        swap = null;
        is(`${verb} answered ${label}: refused as unknown, nothing written`, [got, pushedSince(from)], ["threw UnknownReplyError", 0]);
      }
    }
    swap = null;
    is("control: exact replies, the message goes as a request", await send(ID, open, CARLA, BIA, "hello", ROOM), { ok: true, asked: true });
  }

  part("app/api/store/community/messages/route.ts: 503 'Nothing was changed' in the store's language, nothing sent");
  {
    const CLUB = "club@dmdeclined.example";
    const MEMBER = "member@dmdeclined.example";
    const made = await claimHandle(CLUB, "dmdeclinedclub", "Declined Club", "");
    if (!made.ok) throw new Error("no club store");
    await ensureStatsId(CLUB);
    await ensureStoreId(CLUB);
    await ensureListId(CLUB);
    await setSubscription(CLUB, { customerId: "cus_DmDeclined1", subscriptionId: "sub_DmDeclined1", active: true, tier: "creator", period: paidPeriod() });
    const ticket = await addProduct(CLUB, "Club pass", "", "0", null);
    if (!ticket.ok) throw new Error("no product");
    await setCommunity(CLUB, true);
    await setLanguage(CLUB, "es");
    const club: Store = (await storeForEmail(CLUB))!;
    const cid = club.community!.id;
    await saveConfig(cid, { ...freshConfig(club.name), access: [ticket.product.id], dm: parseDmSetting({ on: true, between: true }) });
    await real([["SET", `nl:cm:${cid}:ok:${emailKey(MEMBER)}`, JSON.stringify({ v: 1, ok: true })]]);
    const cookie = `${passCookieName(club)}=${await mintPass(club, MEMBER, "all")}`;
    const viewer = await communityViewer(club, { get: (name: string) => (name === passCookieName(club) ? { value: cookie.split("=")[1] } : undefined) } as never);
    if (viewer.state !== "in" || !viewer.member) throw new Error("the member is not in: " + viewer.state);
    const [record] = await real([["HGET", `nl:cm:${cid}:m`, viewer.key]]);
    await real([["HSET", `nl:cm:${cid}:m`, viewer.key, JSON.stringify({ ...JSON.parse(String(record)), n: "Member One" })]]);
    if (!(await readMember(cid, viewer.key))?.n) throw new Error("no name");
    // The creator declined this member.
    await real([["SADD", `nl:cm:${cid}:dm:x:${CREATOR}`, viewer.key]]);
    const es = communityWords("es").notices;
    let n = 0;
    const post = () =>
      messagesRoute(
        new NextRequest("https://marktmorgen.com/api/store/community/messages", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://marktmorgen.com", Host: "marktmorgen.com", cookie },
          body: new URLSearchParams({ handle: club.handle, action: "send", to: CREATOR, text: `A private message ${(n += 1)}` }).toString(),
        }),
      );
    const read = async () => {
      const got = await outcome(post);
      if (typeof got === "string") return got;
      return { status: got.status, store: got.headers.get("cache-control"), location: got.status === 303 ? /n=dmsent/.test(got.headers.get("location") ?? "") : null, body: got.status === 303 ? "" : await got.text() };
    };
    {
      const from = seen.length;
      is("control: an exact 1 reads as declined: told it went, as success is, nothing written", [await read(), pushedSince(from)], [{ status: 303, store: null, location: true, body: "" }, 0]);
    }
    for (const [label, bad] of UNKNOWN) {
      swap = { match: verbIs("SISMEMBER", ":dm:x:"), bad };
      const from = seen.length;
      const got = await read();
      swap = null;
      is(`declined answered ${label}: 503 "nothing was changed" in Spanish, nothing sent`, [got, pushedSince(from)], [{ status: 503, store: "no-store", location: null, body: es.error }, 0]);
    }
    await real([["SREM", `nl:cm:${cid}:dm:x:${CREATOR}`, viewer.key]]);
    {
      const from = seen.length;
      is("control: no longer declined, exact replies: the message goes", [await read(), pushedSince(from)], [{ status: 303, store: null, location: true, body: "" }, 1]);
    }
  }

  done();
}

main();
