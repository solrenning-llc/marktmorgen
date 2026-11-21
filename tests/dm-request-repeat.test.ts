/**
 * A request stays a request until the member answers it (lib/community-dm.ts,
 * send). A stranger's first message waits in the member's request list; the
 * conversation it opens already exists, so before this fix a second message
 * from the same stranger was taken for "already talking" and written straight
 * into the member's inbox, past the request she never accepted. A stranger who
 * wrote twice reached her conversations without her yes.
 *
 * Checked: a second and a third message from the stranger stay in the request
 * list, in their first place, and none reaches her inbox; accepting still
 * moves it, with every message; once accepted, both write freely; a decline
 * still takes it all and shuts the stranger out. Controls: the creator and a
 * community without requests go straight through as before.
 */
import { accept, decline, inbox, parseDmSetting, requestCount, send, thread } from "@/lib/community-dm";
import { CREATOR } from "@/lib/community";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const ID = "cmrep";
const ANA = "a1a1a1a1a1a1";
const BIA = "b2b2b2b2b2b2";
const CARLA = "c3c3c3c3c3c3";
const DANI = "d4d4d4d4d4d4";
const open = parseDmSetting({ on: true, between: true, ask: true });
const noQueue = parseDmSetting({ on: true, between: true, ask: false });

async function main() {
  redis.clear();

  part("A stranger who writes twice is still waiting");
  is("the first message is a request", await send(ID, open, ANA, BIA, "Hello Bia", ROOM), { ok: true, asked: true });
  is("the second is a request too", await send(ID, open, ANA, BIA, "Hello again", ROOM), { ok: true, asked: true });
  is("and the third", await send(ID, open, ANA, BIA, "Are you there?", ROOM), { ok: true, asked: true });
  is("none of it is among her conversations", (await inbox(ID, BIA)).length, 0);
  is("one request is waiting, not three", await requestCount(ID, BIA), 1);
  const pair = (await inbox(ID, ANA))[0].pair;
  const waiting = await thread(ID, BIA, pair);
  is("the thread still reads as pending for her", waiting?.pending, true);
  is("with every message in it", waiting?.messages.map((m) => m.text), ["Hello Bia", "Hello again", "Are you there?"]);

  part("Writing again does not move a request up the list");
  is("a second stranger's request", await send(ID, open, CARLA, BIA, "Hi", ROOM), { ok: true, asked: true });
  await send(ID, open, ANA, BIA, "Still here", ROOM);
  is("the newer request stays first", (await inbox(ID, BIA, true)).map((c) => c.other), [CARLA, ANA]);

  part("Accepting still opens the conversation, with everything said");
  is("she accepts", await accept(ID, BIA, pair), true);
  is("it is among her conversations now", (await inbox(ID, BIA)).map((c) => c.other), [ANA]);
  is("both write freely after", [await send(ID, open, BIA, ANA, "Hi Ana", ROOM), await send(ID, open, ANA, BIA, "Hi!", ROOM)], [
    { ok: true, asked: false },
    { ok: true, asked: false },
  ]);
  is("all five of Ana's and Bia's messages are there", (await thread(ID, BIA, pair))?.messages.length, 6);

  part("Declining a stranger who wrote twice takes it all");
  await send(ID, open, CARLA, BIA, "Buy my course", ROOM);
  const carla = (await inbox(ID, CARLA))[0].pair;
  is("still not among her conversations", (await inbox(ID, BIA)).map((c) => c.other), [ANA]);
  is("she declines", await decline(ID, BIA, carla, ROOM), true);
  is("the request is gone", await requestCount(ID, BIA), 0);
  is("and Carla cannot write again", await send(ID, open, CARLA, BIA, "?", ROOM), { ok: false, reason: "declined" });

  part("Controls: no request, nothing changes");
  is("the creator goes straight through", await send(ID, open, CREATOR, DANI, "Welcome", ROOM), { ok: true, asked: false });
  is("and again", await send(ID, open, CREATOR, DANI, "Welcome again", ROOM), { ok: true, asked: false });
  is("a community without requests", await send(ID, noQueue, DANI, ANA, "hi", ROOM), { ok: true, asked: false });
  is("lands in her inbox at once", (await inbox(ID, ANA)).some((c) => c.other === DANI), true);

  done();
}

void main();
