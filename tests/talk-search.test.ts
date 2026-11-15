/**
 * Searching the room and one's own messages.
 *
 * Circle searches messages with filters; Whop searches direct messages and
 * group chat. These close that gap — read straight from where the words are
 * kept rather than from an index, so nothing can fall out of step.
 *
 * The check that matters most is the last section: a person's search reads
 * their own conversations and nobody else's, whatever is typed.
 */
import { holdsAll, queryWords } from "@/lib/community-search";
import { say, searchRoom, NO_CHAT } from "@/lib/community-chat";
import { accept, pairOf, searchMessages, send as sendDm } from "@/lib/community-dm";
import { store as memberStub } from "./redis-stub";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

/** send, its sender and recipient members of the community: a message is written only while their records are there (#4672). */
const send = (...args: Parameters<typeof sendDm>) => {
  for (const who of [args[2], args[3]]) if (who !== "creator") memberStub.run(["HSET", `nl:cm:${args[0]}:m`, who, "{}"]);
  return sendDm(...args);
};


const CM = "cm1";
const room = { ...NO_CHAT, on: true };
const dm = { on: true, between: true, ask: false };

async function main(): Promise<void> {
  part("The same test of a word everywhere");
  is("every word, as a whole word", holdsAll("Refund policy for the course", queryWords("refund policy")), true);
  is("one missing is no match", holdsAll("Refund requests", queryWords("refund policy")), false);
  is("a word is not a piece of another", holdsAll("payment plans", queryWords("pay")), false);
  is("accents fold here too", holdsAll("Café opening hours", queryWords("cafe")), true);
  is("nothing asked finds nothing", holdsAll("anything", []), false);

  part("The room, as it is now");
  redis.clear();
  await say(CM, room, "m1", false, "Is the refund policy in the course?");
  await say(CM, room, "m2", false, "Yes, module three");
  await say(CM, room, "m3", false, "Where is the refund form?");
  const found = await searchRoom(CM, queryWords("refund"));
  is("both messages that say it", found.length, 2);
  is("newest first", found.map((m) => m.a), ["m3", "m1"]);
  is("two words need both", (await searchRoom(CM, queryWords("refund policy"))).map((m) => m.a), ["m1"]);

  part("One's own messages");
  redis.clear();
  // m1 writes to m2 and to m3. m2 and m3 also talk to each other.
  await send(CM, dm, "m1", "m2", "Can you send me the invoice template?", ROOM);
  await send(CM, dm, "m2", "m1", "Sure, the invoice template is in the files", ROOM);
  await send(CM, dm, "m1", "m3", "Loved your invoice post", ROOM);
  await send(CM, dm, "m2", "m3", "The invoice from the retreat is attached", ROOM);
  for (const [a, b] of [["m1", "m2"], ["m1", "m3"], ["m2", "m3"]]) await accept(CM, b, pairOf(a, b)).catch(() => {});

  const mine = await searchMessages(CM, "m1", queryWords("invoice"));
  is("finds what m1 said and was told, in m1's conversations", mine.length, 3);
  is(
    "and every hit is in a conversation m1 is part of",
    mine.every((h) => h.pair.split(".").includes("m1")),
    true,
  );

  part("Nobody reads a conversation they are not in");
  // The conversation between m2 and m3 holds the word too. m1 must not find it.
  is(
    "m2 and m3's conversation is not in m1's results",
    mine.some((h) => h.pair === pairOf("m2", "m3")),
    false,
  );
  is(
    "and a stranger with no conversations finds nothing at all",
    (await searchMessages(CM, "m9", queryWords("invoice"))).length,
    0,
  );
  is(
    "m3 finds the word in both of their own conversations, and only those",
    (await searchMessages(CM, "m3", queryWords("invoice"))).map((h) => h.pair).sort(),
    [pairOf("m1", "m3"), pairOf("m2", "m3")].sort(),
  );

  done();
}

void main();
