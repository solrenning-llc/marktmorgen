/**
 * Issue #4672 (erasure, HIGH): a private message authorised before the sender's erasure (lib/community-dm.ts, send)
 * recreated the deleted conversation, both inbox lines and the read mark after the erasure, so the other member saw
 * the erased sender's words again. Transcribed from Claude 2's reproduction on main @e4dbb5e9bf. The final write is
 * now made only while the sender is still in, in one step; current members and the creator write as before.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld, seedPerson } from "./erasure-world";
import { erasePerson } from "@/lib/person-erasure";
import { normaliseEmail } from "@/lib/auth";
import { emailKey } from "@/lib/learn";
import { conversationsOf, pairOf, send } from "@/lib/community-dm";
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

  part("DM: a send authorised before the sender's erasure is written after it");
  is("control: before the pending send, the conversation exists for the recipient", (await conversationsOf(id, benKey)).length, 1);
  const finishDm = await pausedOn((c) => (c[0]?.[0] === "RPUSH" && String(c[0][1]).startsWith(`nl:cm:${id}:dm:`))
    || (c[0]?.[0] === "EVAL" && String(c[0][1]).startsWith("-- marktmorgen:dm-send-if-member:") && String(c[0][3]).startsWith(`nl:cm:${id}:dm:`)),
    () => send(id, { on: true, between: true, ask: false }, tessKey, benKey, "pending direct words", store));
  try {
    is("erasure completes", (await erasePerson(store, tess, { kind: "person" })).ok, true);
    is("the recipient's copy is empty after erasure", await conversationsOf(id, benKey), []);
  } finally { await finishDm(); }
  is("the pending send recreates nothing in the recipient's copy", await conversationsOf(id, benKey), []);
  is("nor the sender's", await conversationsOf(id, tessKey), []);

  part("DM: a send authorised before the RECIPIENT's erasure is written after it (5bNDa, MEDIUM)");
  const cara = normaliseEmail("cara@example.com");
  const dan = normaliseEmail("dan@example.com");
  await seedPerson(world, dan, null);
  await seedPerson(world, cara, dan);
  const caraKey = emailKey(cara);
  const danKey = emailKey(dan);
  is("control: before the pending send, the recipient has the conversation", (await conversationsOf(id, danKey)).length, 1);
  const finishToErased = await pausedOn((c) => (c[0]?.[0] === "RPUSH" && String(c[0][1]).startsWith(`nl:cm:${id}:dm:`))
    || (c[0]?.[0] === "EVAL" && String(c[0][1]).startsWith("-- marktmorgen:dm-send-if-member:") && String(c[0][3]).startsWith(`nl:cm:${id}:dm:`)),
    () => send(id, { on: true, between: true, ask: false }, caraKey, danKey, "words to someone leaving", store));
  try {
    is("the recipient's erasure completes", (await erasePerson(store, dan, { kind: "person" })).ok, true);
  } finally { await finishToErased(); }
  is("the pending send recreates nothing in the erased recipient's inbox", await conversationsOf(id, danKey), []);
  // What is held, not which keys exist: the stand-in makes an empty key on a read, as the send's own checks do.
  const heldFor = (who: string, other: string) => original([
    ["ZCARD", `nl:cm:${id}:dm:i:${who}`], ["ZCARD", `nl:cm:${id}:dm:q:${who}`],
    ["LLEN", `nl:cm:${id}:dm:${pairOf(who, other)}`], ["HLEN", `nl:cm:${id}:dm:r:${pairOf(who, other)}`],
  ]);
  is("nor any inbox or request line, message or read mark of the pair", await heldFor(danKey, caraKey), [0, 0, 0, 0]);

  part("DM: the creator writing to a member already erased writes nothing (5bNDa, MEDIUM)");
  await send(id, { on: true, between: true, ask: false }, CREATOR, danKey, "hello, are you there?", store).catch(() => undefined);
  is("nothing in the erased member's inbox or requests, and no message or read mark", [await conversationsOf(id, danKey), await heldFor(danKey, CREATOR)], [[], [0, 0, 0, 0]]);

  part("an unknown reply of the write is never a message sent (rule 24)");
  for (const shape of [[], [null], ["OK"], [3]] as unknown[][]) {
    redis.pipeline = (async (c: Command[]) => (c[0]?.[0] === "EVAL" && String(c[0][1]).startsWith("-- marktmorgen:dm-send-if-member:") ? shape : original(c))) as typeof redis.pipeline;
    let outcome = "";
    try {
      outcome = JSON.stringify(await send(id, { on: true, between: true, ask: false }, CREATOR, benKey, "unknown write", store));
    } catch (error) {
      outcome = (error as Error).name;
    }
    redis.pipeline = original;
    is(`write answered ${JSON.stringify(shape)}: unknown`, outcome, "UnknownReplyError");
  }

  part("a current member and the creator still write");
  const amy = normaliseEmail("amy@example.com");
  await seedPerson(world, amy, null);
  is("a current member's message goes", (await send(id, { on: true, between: true, ask: false }, benKey, emailKey(amy), "hello Amy", store)).ok, true);
  is("it is in the recipient's conversations", (await conversationsOf(id, emailKey(amy))).length, 1);
  is("the creator's too", (await send(id, { on: true, between: true, ask: false }, CREATOR, benKey, "hello Ben", store)).ok, true);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
