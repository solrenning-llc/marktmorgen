import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld, seedPerson } from "./erasure-world";
import { erasePerson } from "@/lib/person-erasure";
import { normaliseEmail } from "@/lib/auth";
import { emailKey } from "@/lib/learn";
import { conversationsOf, send } from "@/lib/community-dm";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";
import { dmSendFence } from "@/lib/dm-send-fence";
import { utcDay } from "@/lib/today-rules";

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

  const listId = store.listId as string;
  const fenceFor = (...emails: string[]) => ({ listId, emails, ranSeconds: 0 });
  const dm = { on: true, between: true, ask: false };
  // The write is paused where it goes to Redis: the fenced script, or the plain writes it replaces.
  const atWrite = (c: Command[]) => (c[0]?.[0] === "EVAL" && String(c[0][1]).startsWith("-- marktmorgen:dm-send-unless-erased:v1\n"))
    || (c[0]?.[0] === "RPUSH" && String(c[0][1]).startsWith(`nl:cm:${id}:dm:`));

  part("DM: a send authorised before the sender's erasure is written after it (#4672)");
  is("control: before the pending send, the conversation exists for the recipient", (await conversationsOf(id, benKey)).length, 1);
  let result: unknown;
  const finishDm = await pausedOn(atWrite, async () => (result = await send(id, dm, tessKey, benKey, "pending direct words", store, { fence: fenceFor(tess, ben) })));
  try {
    is("erasure completes", (await erasePerson(store, tess, { kind: "person" })).ok, true);
    is("the recipient's copy is empty after erasure", await conversationsOf(id, benKey), []);
  } finally { await finishDm(); }
  is("the pending send is refused as erased", result, { ok: false, reason: "erased" });
  is("the pending send recreates nothing in the recipient's copy", await conversationsOf(id, benKey), []);
  is("nor the sender's", await conversationsOf(id, tessKey), []);
  is("nor the sender's inbox line", (await redis.pipeline([["ZRANGE", `nl:cm:${id}:dm:i:${tessKey}`, 0, -1]]))[0], []);

  part("DM: a send to someone erased while it was on its way writes nothing of theirs");
  const ava = normaliseEmail("ava@example.com");
  const cal = normaliseEmail("cal@example.com");
  await seedPerson(world, ava, null);
  await seedPerson(world, cal, null);
  const avaKey = emailKey(ava);
  const calKey = emailKey(cal);
  const finishTo = await pausedOn(atWrite, async () => (result = await send(id, dm, calKey, avaKey, "to someone leaving", store, { fence: fenceFor(cal, ava) })));
  try {
    is("the recipient's erasure completes", (await erasePerson(store, ava, { kind: "person" })).ok, true);
  } finally { await finishTo(); }
  is("the send is refused as erased", result, { ok: false, reason: "erased" });
  is("no inbox line of the erased recipient comes back", (await redis.pipeline([["ZRANGE", `nl:cm:${id}:dm:i:${avaKey}`, 0, -1]]))[0], []);
  is("and the sender has no conversation with them", await conversationsOf(id, calKey), []);

  part("DM: a fenced send with nobody erased is written as before");
  const dee = normaliseEmail("dee@example.com");
  await seedPerson(world, dee, null);
  const deeKey = emailKey(dee);
  is("the send goes", await send(id, dm, deeKey, calKey, "hello cal", store, { fence: fenceFor(dee, cal) }), { ok: true, asked: false });
  is("the recipient has the conversation", (await conversationsOf(id, calKey)).length, 1);
  is("and the sender too", (await conversationsOf(id, deeKey)).length, 1);

  part("DM: a print not in whole seconds is unknown and nothing is written");
  const eve = normaliseEmail("eve@example.com");
  await seedPerson(world, eve, null);
  const eveKey = emailKey(eve);
  await redis.pipeline([["HSET", suppressedKey(listId), suppressionPrint(listId, eve), "not-a-second"]]);
  const before = await conversationsOf(id, calKey);
  let thrown = false;
  try {
    await send(id, dm, eveKey, calKey, "odd print", store, { fence: fenceFor(eve, cal) });
  } catch {
    thrown = true;
  }
  is("the send throws (the route answers 503)", thrown, true);
  is("the recipient's conversations are unchanged", await conversationsOf(id, calKey), before);

  part("DM: a request whose copy of the store has no list still asks the list an erasure gave it meanwhile (Codex L on #5495)");
  // The request read the store before an erasure gave it its list and wrote the person's print in it (lib/person-erasure.ts asks
  // ensureListId first): the copy says no list, the store has one.
  const fay = normaliseEmail("fay@example.com");
  const gus = normaliseEmail("gus@example.com");
  await seedPerson(world, gus, null);
  await seedPerson(world, fay, gus);
  const fayKey = emailKey(fay);
  const gusKey = emailKey(gus);
  const stale: typeof store = { ...store, listId: null };
  const startedAt = Date.now();
  is("erasure completes", (await erasePerson(store, fay, { kind: "person" })).ok, true);
  const fence = await dmSendFence(stale, [fay, gus], startedAt);
  is("the fence asks the store's own list, not the copy's none", fence?.listId, listId);
  is("the send from the stale copy is refused as erased", await send(id, dm, fayKey, gusKey, "words from before", stale, { fence }), { ok: false, reason: "erased" });
  is("and nothing of the erased sender comes back", await conversationsOf(id, fayKey), []);
  is("nor in the recipient's copy", (await conversationsOf(id, gusKey)).filter((c) => JSON.stringify(c).includes(fayKey)), []);

  part("DM: a copy with no list and no try left today writes nothing");
  const day = utcDay(Date.now());
  // The day's one try already taken (lib/store-readings.ts, listTryKey), by a reading or a send whose try failed.
  await redis.pipeline([["SET", `nl:list:try:${store.statsId}:${day}`, "1"]]);
  let refused = false;
  try {
    await dmSendFence({ ...stale, statsId: store.statsId }, [gus], Date.now());
  } catch {
    refused = true;
  }
  is("no list to ask: it throws before anything is written (the route answers 503)", refused, true);
  is("a message naming nobody needs no list", await dmSendFence(stale, [""], Date.now()), null);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
