/**
 * A private message refused before anything was written says so: the
 * messages route answers 503 "Nothing was changed; try again", never "We
 * could not confirm that this went through" (CX-123 rule 24; consent).
 *
 * lib/community-dm.ts send() reads, before it writes anything, whether the
 * sender was declined, and throws UnknownReplyError on a reply it cannot
 * read. app/api/store/community/messages/route.ts had already set
 * progress.writing before calling send(), so that refusal reached the person
 * as "could not confirm", which asks them to look for a message that was
 * never sent. UnknownReplyError from send() is now answered as what it is:
 * nothing changed. The answer is the same whether or not the sender was
 * declined, so it never tells them they were.
 *
 * Synthetic only: the in-memory Redis stand-in, with one reply made unknown.
 */
import { NextRequest } from "next/server";
import { parseDmSetting } from "@/lib/community-dm";
import { CREATOR, freshConfig, readMember, saveConfig } from "@/lib/community";
import { communityViewer } from "@/lib/community-access";
import { communityWords } from "@/lib/buyer-words/community";
import { emailKey, mintPass, passCookieName } from "@/lib/learn";
import { POST as messagesRoute } from "@/app/api/store/community/messages/route";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setLanguage, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
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
