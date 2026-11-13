/**
 * A community member's record and the community's head count, read in their
 * exact shape before anyone is let in (CX-123 rule 24).
 *
 * lib/community.ts readMember read any reply that was not a parseable record
 * as "no record" (null). lib/community-access.ts communityViewer checks a
 * removal on that read (`existing?.removed`), so a reply that was missing,
 * cut short or of another shape let a member the creator had taken out past
 * the removal; touchMember then took them for somebody new, its HSETNX left
 * the removed record as it was, its own re-read was just as loose, and the
 * fresh record it handed back (not removed, not muted) let them in with
 * writing rights. touchMember also read the community's head count with
 * Number(...): a missing or off-shape HLEN read as NaN, never at the ceiling,
 * so a new record was written whatever the count was.
 *
 * Each is called here as the community's pages call it, on the in-memory
 * store, with only the member read or the head count answered differently.
 * What is checked: an unknown reply never lets anybody in (it is thrown, and
 * the page answers with its error); a record that is not there still lets a
 * ticket holder in, a removed record still keeps its member out, and a
 * confirmed count under the ceiling still makes the record.
 */
import { communityViewer } from "@/lib/community-access";
import { freshConfig, memberKey, readMember, saveConfig } from "@/lib/community";
import { parseDmSetting } from "@/lib/community-dm";
import { emailKey, mintPass, passCookieName } from "@/lib/learn";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];

/** Which pipeline is answered differently, and with what. */
let odd: { match: (commands: Command[]) => boolean; reply: unknown } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  if (odd && odd.match(commands)) return odd.reply;
  return pipeline(commands);
}) as typeof redis.pipeline;

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

/** What the viewer came to, or "thrown" when the read was refused. */
async function outcome(look: () => Promise<{ state: string; canWrite?: boolean }>): Promise<string> {
  const quiet = console.error;
  console.error = () => {};
  try {
    const viewer = await look();
    return viewer.state === "in" ? `in${viewer.canWrite ? " and writing" : ""}` : viewer.state;
  } catch {
    return "thrown";
  } finally {
    console.error = quiet;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const CLUB = "club@memberread.example";
  const made = await claimHandle(CLUB, "memberreadclub", "Member Read Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(CLUB);
  await ensureStoreId(CLUB);
  await ensureListId(CLUB);
  await setSubscription(CLUB, { customerId: "cus_MemberRead1", subscriptionId: "sub_MemberRead1", active: true, tier: "creator", period: paidPeriod() });
  const ticket = await addProduct(CLUB, "Club pass", "", "0", null);
  if (!ticket.ok) throw new Error("no product");
  await setCommunity(CLUB, true);
  const club: Store = (await storeForEmail(CLUB))!;
  const cid = club.community!.id;
  await saveConfig(cid, { ...freshConfig(club.name), access: [ticket.product.id], dm: parseDmSetting({ on: true, between: true }) });
  const members = `nl:cm:${cid}:m`;

  /** A ticket holder with a pass cookie, as the gate keeps their answer. */
  async function holder(email: string) {
    await redis.pipeline([["SET", `nl:cm:${cid}:ok:${emailKey(email)}`, JSON.stringify({ v: 1, ok: true })]]);
    const pass = await mintPass(club, email, "all");
    const cookies = { get: (name: string) => (name === passCookieName(club) ? { value: pass } : undefined) } as never;
    return () => communityViewer(club, cookies);
  }

  part("A member the creator took out");
  const REMOVED = "taken.out@memberread.example";
  const removedKey = memberKey(REMOVED);
  const look = await holder(REMOVED);
  is("comes in once, holding the ticket", await outcome(look), "in and writing");
  // Taken out and muted by the creator, written as the record keeps it (moderateMember's compare-and-set runs a script the stand-in does not).
  const [record] = await redis.pipeline([["HGET", members, removedKey]]);
  await redis.pipeline([["HSET", members, removedKey, JSON.stringify({ ...JSON.parse(String(record)), removed: true, muted: true })]]);
  is("and is then kept out, whatever they bought", await outcome(look), "removed");

  const memberRead = (commands: Command[]) => commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === members && commands[0][2] === removedKey;
  const shapes: [string, unknown][] = [
    ["no reply at all", []],
    ["a hole where the record was", [undefined]],
    ["a number", [7]],
    ["an object", [{ k: removedKey }]],
    ["a list", [["removed", "true"]]],
    ["text that is not a record", ["not a record"]],
    ["a record without its removal", [JSON.stringify({ k: removedKey, e: REMOVED })]],
    ["a record whose removal is not a yes or a no", [JSON.stringify({ ...JSON.parse(String(record)), removed: "yes", muted: "yes" })]],
    ["another member's record", [JSON.stringify({ ...JSON.parse(String(record)), k: memberKey("someone.else@memberread.example"), e: "someone.else@memberread.example" })]],
  ];
  for (const [what, reply] of shapes) {
    odd = { match: memberRead, reply };
    is(`their record read as ${what}: never let back in`, await outcome(look), "thrown");
    odd = null;
  }
  is("and readMember itself throws on it, never says there is no record", await (async () => {
    odd = { match: memberRead, reply: [7] };
    try { return String(await readMember(cid, removedKey)); } catch { return "thrown"; } finally { odd = null; }
  })(), "thrown");
  is("still taken out once the record reads again", await outcome(look), "removed");

  part("A record that is not there");
  const NEW = "new.member@memberread.example";
  const lookNew = await holder(NEW);
  is("a ticket holder with no record is let in, and their record made", [await outcome(lookNew), (await readMember(cid, memberKey(NEW)))?.removed], ["in and writing", false]);

  part("The community's head count");
  const headCount = (commands: Command[]) => commands.length === 1 && commands[0][0] === "HLEN" && commands[0][1] === members;
  const counts: [string, unknown][] = [
    ["no reply at all", []],
    ["a hole", [undefined]],
    ["nothing", [null]],
    ["text", ["many"]],
    ["digits as text", ["3"]],
    ["a negative number", [-1]],
    ["a fraction", [1.5]],
  ];
  let n = 0;
  for (const [what, reply] of counts) {
    n += 1;
    const email = `count${n}@memberread.example`;
    const lookCount = await holder(email);
    odd = { match: headCount, reply };
    const got = await outcome(lookCount);
    odd = null;
    const [kept] = await redis.pipeline([["HGET", members, memberKey(email)]]);
    const written = kept !== null && kept !== undefined;
    is(`the count read as ${what}: nobody let in, no record written`, [got, written], ["thrown", false]);
  }
  const COUNTED = "counted@memberread.example";
  const lookCounted = await holder(COUNTED);
  odd = { match: headCount, reply: [3] };
  const countedIn = await outcome(lookCounted);
  odd = null;
  is("a count Redis confirmed, under the ceiling, still lets the new member in", [countedIn, (await readMember(cid, memberKey(COUNTED)))?.k], ["in and writing", memberKey(COUNTED)]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
