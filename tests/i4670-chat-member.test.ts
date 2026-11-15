/**
 * Issue #4670 (erasure, HIGH): a community room message authorised before the member's erasure (lib/community-chat.ts,
 * say) was written to the shared room after it, with the member's id, name and words. Transcribed from Claude 2's
 * reproduction on main @e4dbb5e9bf. The message is now written only while the member is still in, in one step; current
 * members and the creator speak as before.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld, seedPerson } from "./erasure-world";
import { erasePerson } from "@/lib/person-erasure";
import { normaliseEmail } from "@/lib/auth";
import { emailKey } from "@/lib/learn";
import { chatMessagesOf, room as roomOf, say } from "@/lib/community-chat";
import { CREATOR } from "@/lib/community";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;
type Command = (string | number)[];

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_d2_chat_stand_in";
  process.env.RESEND_API_KEY = "re_test_d2_chat_stand_in";
  const world = await makeWorld();
  const tess = normaliseEmail("tess@example.com");
  const ben = normaliseEmail("ben@example.com");
  await seedPerson(world, ben, null);
  await seedPerson(world, tess, ben);
  const store = world.store;
  const id = world.communityId;
  const tessKey = emailKey(tess);
  const benKey = emailKey(ben);
  const original = redis.pipeline.bind(redis);

  async function pausedOn(match: (c: Command[]) => boolean, run: () => Promise<unknown>) {
    let reached!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let paused = false;
    redis.pipeline = (async (commands: Command[]) => {
      if (!paused && match(commands)) { paused = true; reached(); await hold; }
      return original(commands);
    }) as typeof redis.pipeline;
    const pending = run();
    await at;
    return async () => { release(); await pending; redis.pipeline = original; };
  }

  part("chat: a message authorised before erasure is written after it");
  const writes = (c: Command[]) => (c.length === 2 && c[0][0] === "ZADD" && c[0][1] === `nl:cm:${id}:ch` && String(c[0][3]).includes("pending words"))
    || (c.length === 1 && c[0][0] === "EVAL" && String(c[0][1]).startsWith("-- marktmorgen:chat-say-if-member:") && c[0][3] === `nl:cm:${id}:ch` && String(c[0][7]).includes("pending words"));
  const finishChat = await pausedOn(writes,
    () => say(id, { on: true, slow: 0, links: true, creatorOnly: false }, tessKey, false, "pending words", "Tess"));
  try {
    is("erasure completes", (await erasePerson(store, tess, { kind: "person" })).ok, true);
    is("the member has no room messages after erasure", await chatMessagesOf(id, tessKey), []);
  } finally { await finishChat(); }
  is("the pending message leaves nothing of the erased member", await chatMessagesOf(id, tessKey), []);
  is("the room holds no message attributed to them", (await roomOf(id)).messages.filter((m) => m.a === tessKey), []);

  part("a current member and the creator still speak");
  const setting = { on: true, slow: 0, links: true, creatorOnly: false };
  is("a current member's message is written", (await say(id, setting, benKey, false, "still here 4670", "Ben")).ok, true);
  is("and the creator's", (await say(id, setting, CREATOR, true, "hello room 4670", store.name)).ok, true);
  is("both in the room", (await roomOf(id)).messages.filter((m) => m.text === "still here 4670" || m.text === "hello room 4670").length, 2);

  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
