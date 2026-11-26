/**
 * #4670 (Codex L, HIGH, erasure; reproduced by Claude 2 on main e4dbb5e9bf): a member's room message checked before
 * their erasure and written after it was left in the room with their member key, their name and their words. The
 * message is now written only while the member was not deleted that recently, in one step with the write
 * (lib/community-chat.ts CHAT_SAY_UNLESS_ERASED). Controls: another member's message, and one from a member deleted
 * long ago who joined again, are written as before. Synthetic data, in-memory Redis; the pause stands for the request
 * being in flight.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld, seedPerson } from "./erasure-world";
import { erasePerson } from "@/lib/person-erasure";
import { normaliseEmail } from "@/lib/auth";
import { emailKey } from "@/lib/learn";
import { chatMessagesOf, room as roomOf, say } from "@/lib/community-chat";
import { suppressionPrint } from "@/lib/suppression";

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

  // What the chat route passes for a member's message (app/api/store/community/chat/route.ts).
  const fence = (email: string) => ({ listId: store.listId as string, email, ranSeconds: 0 });

  part("chat: a message authorised before erasure is written after it");
  // The message's write, as a plain ZADD or inside the script that writes it (CHAT_SAY_UNLESS_ERASED).
  const writes = (c: Command[]) => c.some((command) => command.includes(`nl:cm:${id}:ch`) && command.some((part) => String(part).includes("pending words")));
  const finishChat = await pausedOn(writes,
    () => say(id, { on: true, slow: 0, links: true, creatorOnly: false }, tessKey, false, "pending words", "Tess", fence(tess)));
  try {
    is("erasure completes", (await erasePerson(store, tess, { kind: "person" })).ok, true);
    is("the member has no room messages after erasure", await chatMessagesOf(id, tessKey), []);
  } finally { await finishChat(); }
  is("the pending message leaves nothing of the erased member", await chatMessagesOf(id, tessKey), []);
  is("the room holds no message attributed to them", (await roomOf(id)).messages.filter((m) => m.a === tessKey), []);

  part("control: another member's message is written as before");
  const said = await say(id, { on: true, slow: 0, links: true, creatorOnly: false }, benKey, false, "ben checks in", "Ben", fence(ben));
  is("it is written", said.ok, true);
  is("the room holds it", (await roomOf(id)).messages.some((m) => m.a === benKey && m.text === "ben checks in"), true);

  part("a member deleted that recently: refused, nothing written");
  const late = await say(id, { on: true, slow: 0, links: true, creatorOnly: false }, tessKey, false, "late words", "Tess", fence(tess));
  is("said as erased", late.ok ? "ok" : late.reason, "erased");
  is("nothing of theirs is in the room", (await roomOf(id)).messages.filter((m) => m.a === tessKey), []);

  part("control: a member deleted long ago, who joined again, is written as before");
  await redis.pipeline([["HSET", `nl:erased:${store.listId}`, suppressionPrint(store.listId as string, tess), Math.floor(Date.now() / 1000) - 2 * 86_400]]);
  const back = await say(id, { on: true, slow: 0, links: true, creatorOnly: false }, tessKey, false, "back again", "Tess", fence(tess));
  is("it is written", back.ok, true);

  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
