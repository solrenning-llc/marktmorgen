/**
 * A whole conversation between two members and the creator.
 *
 * This is the flow that cannot be checked by calling one function: a first
 * message becoming a request, the request being accepted, a decline taking
 * the messages with it and shutting the sender out. It lives in the order of
 * the writes, not in any one function, and it is the part of private
 * messages that no other platform we compared against has.
 */
import { accept, decline, inbox, parseDmSetting, requestCount, send as sendDm, thread } from "@/lib/community-dm";
import { store as memberStub } from "./redis-stub";
import { CREATOR } from "@/lib/community";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

/** send, its sender a member of the community: a message is written only while its sender's record is there (#4672). */
const send = (...args: Parameters<typeof sendDm>) => {
  memberStub.run(["HSET", `nl:cm:${args[0]}:m`, args[2], "{}"]);
  return sendDm(...args);
};


const ID = "cm1";
const ANA = "a1a1a1a1a1a1";
const BIA = "b2b2b2b2b2b2";
const CARLA = "c3c3c3c3c3c3";
const DANI = "d4d4d4d4d4d4";
const open = parseDmSetting({ on: true, between: true, ask: true });
const noQueue = parseDmSetting({ on: true, between: true, ask: false });

async function main() {
  part("A stranger's first message waits");
  is("it lands as a request", await send(ID, open, ANA, BIA, "Hello Bia", ROOM), { ok: true, asked: true });
  is("one request is waiting", await requestCount(ID, BIA), 1);
  is("it is NOT among her conversations", (await inbox(ID, BIA)).length, 0);
  is("it is among the sender's", (await inbox(ID, ANA)).length, 1);
  is("she sees it in the request list", (await inbox(ID, BIA, true)).length, 1);

  const pair = (await inbox(ID, ANA))[0].pair;
  const waiting = await thread(ID, BIA, pair);
  is("the thread reads as pending for her", waiting?.pending, true);
  is("she can read what was written", waiting?.messages.map((m) => m.text), ["Hello Bia"]);

  part("Accepting turns it into a conversation");
  is("accepting works", await accept(ID, BIA, pair), true);
  is("it is among her conversations now", (await inbox(ID, BIA)).length, 1);
  is("no request is left", await requestCount(ID, BIA), 0);
  is("and it is no longer pending", (await thread(ID, BIA, pair))?.pending, false);
  is("a reply is not a request", await send(ID, open, BIA, ANA, "Hello Ana", ROOM), { ok: true, asked: false });
  is("nor is the one after it", await send(ID, open, ANA, BIA, "good", ROOM), { ok: true, asked: false });
  is("all three are in the thread", (await thread(ID, ANA, pair))?.messages.length, 3);

  part("Declining removes it, with its messages, for good");
  const asked = await send(ID, open, CARLA, BIA, "buy my course", ROOM);
  is("the stranger is queued", asked.ok && asked.asked, true);
  const theirs = (await inbox(ID, BIA, true))[0].pair;
  is("declining works", await decline(ID, BIA, theirs, ROOM), true);
  is("the request is gone", await requestCount(ID, BIA), 0);
  is("it is gone from the sender's list too", (await inbox(ID, CARLA)).length, 0);
  is("the messages went with it", await thread(ID, CARLA, theirs), null);
  is("and they cannot ask again", await send(ID, open, CARLA, BIA, "hello? hello?", ROOM), { ok: false, reason: "declined" });

  part("The creator neither asks nor is made to ask");
  is("creator to member goes straight through", await send(ID, open, CREATOR, ANA, "Thanks for joining", ROOM), { ok: true, asked: false });
  is("member to creator goes straight through", await send(ID, open, BIA, CREATOR, "A question", ROOM), { ok: true, asked: false });

  part("With the queue switched off");
  is("a first message arrives directly", await send(ID, noQueue, DANI, ANA, "hi", ROOM), { ok: true, asked: false });
  is("and lands among her conversations", (await inbox(ID, ANA)).some((c) => c.other === DANI), true);

  part("What counts as unread");
  const before = (await inbox(ID, ANA)).find((c) => c.other === DANI);
  is("a message she has not opened is new", before?.unread, true);
  await thread(ID, ANA, before!.pair);
  is("opening it stops it being new", (await inbox(ID, ANA)).find((c) => c.other === DANI)?.unread, false);

  done();
}

main();
