/**
 * The room: what may be said in it, and how it is read.
 *
 * The cooldown is the one worth having a test for. It is a SET NX with an
 * expiry — the cooldown IS the key — and that is either exactly right or
 * quietly lets everybody through, with nothing in between and nothing visible
 * either way.
 */
import {
  type ChatRefusal,
  MAX_CHAT_KEPT,
  MAX_SLOW,
  clearRoom,
  parseChatSetting,
  refusalWords,
  room,
  roomSize,
  say,
  unsay,
} from "@/lib/community-chat";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "cm1";
const ANA = "a1a1a1a1a1a1";
const BIA = "b2b2b2b2b2b2";
const open = parseChatSetting({ on: true });
const noLinks = parseChatSetting({ on: true, links: false });
const quiet = parseChatSetting({ on: true, creatorOnly: true });
const slow = parseChatSetting({ on: true, slow: 60 });

async function main() {
  // A room message is written only while its author's record is there (#4670): Ana and Bia are members.
  await redis.pipeline([["HSET", `nl:cm:${ID}:m`, ANA, "{}", BIA, "{}"]]);
  part("What the settings parse to");
  is("a community from before has no room", parseChatSetting(undefined).on, false);
  is("links are allowed unless said otherwise", parseChatSetting({ on: true }).links, true);
  is("a cooldown past the limit is clamped", parseChatSetting({ on: true, slow: 9_999 }).slow, MAX_SLOW);
  is("a negative one is none", parseChatSetting({ on: true, slow: -5 }).slow, 0);

  part("Saying something");
  is("a closed room takes nothing", (await say(ID, parseChatSetting({ on: false }), ANA, false, "hi")).ok, false);
  is("empty is not a message", (await say(ID, open, ANA, false, "   ")).ok, false);
  const first = await say(ID, open, ANA, false, "Hello everyone");
  is("a real message is kept", first.ok, true);
  is("it is numbered", first.ok && first.message.i > 0, true);
  is("the room holds it", await roomSize(ID), 1);

  part("Reading the room");
  await say(ID, open, BIA, false, "Hello Ana");
  const all = await room(ID);
  is("both are there, oldest first", all.messages.map((m) => m.text), ["Hello everyone", "Hello Ana"]);
  is("the cursor is the last number", all.cursor, all.messages[1].i);
  const since = await room(ID, all.messages[0].i);
  is("asking since the first brings only the second", since.messages.map((m) => m.text), ["Hello Ana"]);
  is("asking since the last brings nothing", (await room(ID, all.cursor)).messages.length, 0);

  part("Web addresses, when the room does not take them");
  is("a member is refused", (await say(ID, noLinks, ANA, false, "look at https://example.com")).ok, false);
  is("the creator is not", (await say(ID, noLinks, "creator", true, "https://example.com")).ok, true);
  is("plain words still pass", (await say(ID, noLinks, ANA, false, "no address here")).ok, true);

  part("When only the creator writes");
  is("a member is refused", await say(ID, quiet, ANA, false, "hi"), { ok: false, reason: "creatorOnly" });
  is("the creator is not", (await say(ID, quiet, "creator", true, "Starting in five")).ok, true);

  part("The cooldown");
  const one = await say(ID, slow, BIA, false, "first");
  is("the first goes", one.ok, true);
  const two = await say(ID, slow, BIA, false, "second, straight after");
  is("the second is refused", two.ok === false && two.reason, "slow");
  is("and says how long is left", two.ok === false && typeof two.wait === "number" && two.wait > 0, true);
  is("somebody else is not waiting", (await say(ID, slow, ANA, false, "mine goes")).ok, true);
  is("the creator never waits", (await say(ID, slow, "creator", true, "nor do I")).ok, true);
  // The cooldown IS the key's expiry, so the only way to prove it ends is to
  // outlast it. The clock is moved rather than waited on.
  advance(61_000);
  is("once the wait is over, they may speak again", (await say(ID, slow, BIA, false, "back")).ok, true);

  part("Taking something out, and emptying it");
  const gone = await say(ID, open, ANA, false, "said in error");
  is("one message goes", await unsay(ID, gone.ok ? gone.message.i : 0), true);
  is("a number that is not there says so", await unsay(ID, 999_999), false);
  await clearRoom(ID);
  is("emptying it leaves nothing", await roomSize(ID), 0);

  part("How much it keeps");
  for (let n = 0; n < MAX_CHAT_KEPT + 20; n += 1) await say(ID, open, ANA, false, `message ${n}`);
  is("never more than the cap", await roomSize(ID), MAX_CHAT_KEPT);
  const tail = await room(ID);
  is("and what it kept is the newest", tail.messages[tail.messages.length - 1].text, `message ${MAX_CHAT_KEPT + 19}`);

  part("Every refusal has its own words");
  // Exhaustive on purpose. A reason without a sentence falls back to "try
  // again in a moment", which is wrong for most of these and false for two:
  // somebody whose place has ended will never succeed by trying again, and
  // somebody who hit the hourly ceiling is not waiting on the cooldown.
  const reasons: ChatRefusal[] = [
    "off", "empty", "links", "slow", "hourly", "creatorOnly", "muted", "full", "name", "out", "unknown",
  ];
  const said = reasons.map((reason) => refusalWords(reason, 30, 12));
  is("none is empty", said.every((one) => one.length > 10), true);
  is("none repeats another", new Set(said).size, reasons.length);
  is("the cooldown says how long is left", refusalWords("slow", 30, 12), "One message every 30 seconds here. 12 to go.");
  is(
    "the hourly ceiling is NOT the cooldown's sentence",
    refusalWords("hourly", 30, 12) === refusalWords("slow", 30, 12),
    false,
  );
  is(
    "somebody whose place ended is not told to try again",
    refusalWords("out", 30).includes("try again"),
    false,
  );
  is("a full community is not told to try again", refusalWords("full", 30).includes("try again"), false);

  done();
}

main();
