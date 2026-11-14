/**
 * Three cases of #4244's contact-writes-cas test that tests/contacts-write-race.test.ts does not hold, on the writes
 * main makes (consent audit of 9 November 2026: writeContactIf, writeRowIf, casWrite; Claude 7, 14 November 2026;
 * synthetic only):
 *
 *   - a merge (a name and a label written by the creator) in the moment between upsertContact's read and its write
 *     is kept, and the product is still noted;
 *   - a write whose answer cannot be read writes nothing and throws, for upsertContact, noteProduct and
 *     stopCounting alike, so it is tried again (an order's write throws a plain Error, see below);
 *   - an unsubscribe whose person is erased in the moment between does not raise the list's count of those who left,
 *     and still tells them they are off the list.
 */
import { forgetContactPerson, leadsKey, noteProduct, tokensFor, unsubscribe, upsertContact } from "@/lib/contacts";
import { stopCounting } from "@/lib/mail-clicks";
import { suppressCommand } from "@/lib/suppression";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const handle = "race-more-shop";
const real = redis.pipeline.bind(redis);
const OWNER = { sid: ROOM.sid, statsId: "race_more_stats", handle };
const list = "racemorelist0001";
const key = leadsKey(list);
const row = (email: string) => redis.run(["HGET", key, email]) as string | null;
const parsed = (email: string) => {
  const raw = row(email);
  return raw ? (JSON.parse(raw) as { name?: string; tags?: string[]; ids: string[]; unsub: boolean; clicks?: boolean }) : null;
};

/** Runs `between` once, right after the first pipeline `first` matches, with the real Redis. */
function raceAt(first: (commands: Commands) => boolean, between: () => Promise<unknown>): { ran: () => boolean } {
  let fired = false;
  redis.pipeline = async (commands: Commands) => {
    if (!fired && first(commands)) {
      fired = true;
      const before = await real(commands);
      const hook = redis.pipeline;
      redis.pipeline = real;
      await between();
      redis.pipeline = hook;
      return before;
    }
    return real(commands);
  };
  return { ran: () => fired };
}
/** A caller that pays each round past the first of a sign-up from the store's room (as tests/contacts-write-race.test.ts). */
const paid = async () => true;
const rowRead = (length: number) => (c: Commands) => c.length === length && c[0][0] === "HGET" && c[0][1] === key;

async function thrown(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "returned";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  }
}

async function main() {
  redis.clear();

  part("upsertContact: a merge in the moment between is kept");
  await upsertContact(list, "cy@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const race = raceAt(rowRead(3), async () => {
    const was = JSON.parse(String(row("cy@example.com")));
    await real([["HSET", key, "cy@example.com", JSON.stringify({ ...was, name: "Cy Merged", tags: ["vip"] })]]);
  });
  await upsertContact(list, "cy@example.com", { agreed: true, explicit: false, source: "import", productId: "p-cy", title: "Ebook" }, ROOM, paid);
  redis.pipeline = real;
  is("control: the race ran", race.ran(), true);
  const cy = parsed("cy@example.com");
  is("the merged name and label stay, and the product is noted", [cy?.name, cy?.tags, cy?.ids.includes("p-cy")], ["Cy Merged", ["vip"], true]);

  part("A write whose answer cannot be read writes nothing and throws, to be tried again");
  await upsertContact(list, "fay@example.com", { agreed: false, explicit: false, source: "buyer" }, ROOM);
  await upsertContact(list, "gil@example.com", { agreed: true, explicit: true, clicks: true, source: "free" }, ROOM);
  const gilToken = (await tokensFor(list, ["gil@example.com"], handle)).get("gil@example.com");
  if (!gilToken) throw Error("setup: token");
  const fayWas = row("fay@example.com");
  const gilWas = row("gil@example.com");
  // Every checked write of a contact's row (CONTACT_WRITE_IF, the CAS script, an order's ORDER_WRITE_IF_SAME) answers in
  // another shape, and writes nothing; the store's room and everything else answer as they are.
  const checkedWrite = /^-- marktmorgen:(contact-write-if|contact-cas-hset|order-write-if-same):v1/;
  redis.pipeline = async (commands: Commands) =>
    commands.length === 1 && commands[0][0] === "EVAL" && checkedWrite.test(String(commands[0][1])) ? [{ unexpected: true }] : real(commands);
  const answers = [
    await thrown(() => upsertContact(list, "fay@example.com", { agreed: true, explicit: true, source: "free" }, ROOM)),
    await thrown(() => noteProduct(list, "fay@example.com", "p-fay", "Guide", OWNER)),
    await thrown(() => stopCounting(gilToken)),
  ];
  redis.pipeline = real;
  // An order's checked write (lib/order-data.ts readScript) says an unreadable reply with a plain Error, not
  // UnknownReplyError; its caller (lib/buyer-list.ts putOnList) treats any throw as "failed", tried again by the sweep.
  is("each throws, never a write taken as done: unknown for the list's own writes", [answers[0], answers[2]], ["unknown", "unknown"]);
  is("and an order's write throws too", answers[1].startsWith("other: ") || answers[1] === "unknown", true);
  is("and the rows are as they were", [row("fay@example.com"), row("gil@example.com")], [fayWas, gilWas]);

  part("unsubscribe: an erasure in the moment between does not count them as leaving");
  await upsertContact(list, "ivy@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const ivyToken = (await tokensFor(list, ["ivy@example.com"], handle)).get("ivy@example.com");
  if (!ivyToken) throw Error("setup: token");
  const unsubBefore = Number(redis.run(["GET", `${key}:unsub`]) ?? 0);
  const erasing = raceAt(rowRead(1), async () => {
    await real([suppressCommand(list, "ivy@example.com")]);
    await forgetContactPerson(list, "ivy@example.com");
  });
  const left = await unsubscribe(ivyToken);
  redis.pipeline = real;
  is("control: the erasure ran inside the unsubscribe", erasing.ran(), true);
  is("the erased contact is not written back", row("ivy@example.com"), null);
  is("the list's count of those who left is not raised for them", Number(redis.run(["GET", `${key}:unsub`]) ?? 0), unsubBefore);
  is("the person is told they are off the list", left?.email, "ivy@example.com");
  done();
}
void main();
