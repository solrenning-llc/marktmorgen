/**
 * #4786, #4788, #4789 (Codex V, transcribed by Claude 2): a community write admitted before a member's erasure and
 * landing after it brought the erased person back. An RSVP's HSETNX put them on an event's list again, a notice's
 * ZADD made their notice list again (with the author, the post and comment ids and the excerpt), and a like on a
 * post they wrote, kept without their name, gave their old key points and a place on the day's board again.
 *
 * Each write now decides in the same step whether the person is still a member, from the member record the erasure
 * deletes first (lib/community-erasure.ts: forgetMemberRecord, then each module's own part): a write that lands
 * after that deletion writes nothing, and one that lands before it is deleted by the module's part after. Here each
 * write is held at its write, the whole erasure runs, then the write is let go. Synthetic data, in-memory Redis.
 */
import { createEvent, rsvp, rsvpsOf } from "@/lib/community-events";
import { freshConfig, memberKey, saveConfig, touchMember } from "@/lib/community";
import { allNoticesOf, noticesFor, tell } from "@/lib/community-notify";
import { award, pointsOf } from "@/lib/community-points";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;
type Command = (string | number)[];
const original = redis.pipeline.bind(redis);

/** Runs `write` held at the first pipeline `at` picks, runs the whole erasure, then lets the write go. */
async function erasedMeanwhile<T>(id: string, who: string, email: string, at: (commands: Command[]) => boolean, write: () => Promise<T>): Promise<T> {
  let reached!: () => void;
  const writeReached = new Promise<void>((r) => (reached = r));
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let paused = false;
  redis.pipeline = (async (commands: Command[]) => {
    if (!paused && at(commands)) {
      paused = true;
      reached();
      await hold;
    }
    return original(commands);
  }) as typeof redis.pipeline;
  const pending = write();
  try {
    await writeReached;
    await forgetCommunityPerson(id, who, email, []);
  } finally {
    release();
  }
  try {
    return await pending;
  } finally {
    redis.pipeline = original;
  }
}

/** Whether a pipeline carries the write `name`, sent as itself or inside a script. */
const carries = (name: string) => (commands: Command[]) => commands.some((c) => c[0] === name || (c[0] === "EVAL" && c.map(String).join(" ").includes(name)));

async function club(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Fence Club", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "pro", period: paidPeriod() });
  await setCommunity(owner, true);
  const store = (await storeForEmail(owner))!;
  await saveConfig(store.community!.id, freshConfig(store.name));
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const store = await club("club@fence.example", "fenceclub");
  const id = store.community!.id;

  part("#4786: an RSVP admitted before the erasure");
  const made = await createEvent(store, { title: "Bread night", about: "Synthetic only.", start: Date.now() + 86_400_000, minutes: 60, tz: "UTC", cap: 0, where: "room", link: "", meet: null, only: [] });
  if (!made.ok) throw new Error(`no event ${JSON.stringify(made)}`);
  const goer = "going@fence.example";
  const goerKey = memberKey(goer);
  await touchMember(id, goer, null, store);
  const kept = "kept@fence.example";
  await touchMember(id, kept, null, store);
  is("(control) a member still in takes a place", await rsvp(id, made.event, memberKey(kept), store), "added");
  const answer = await erasedMeanwhile(id, goerKey, goer, carries("HSETNX"), () => rsvp(id, made.event, goerKey, store));
  is("the RSVP is not taken after the erasure", answer, "closed");
  is("the erased person is absent from the RSVP export", await rsvpsOf(id, goerKey), []);

  part("#4788: a notice admitted before the erasure");
  const told = "told@fence.example";
  const toldKey = memberKey(told);
  await touchMember(id, told, null, store);
  await tell(id, [memberKey(kept)], { kind: "mention", post: "post-zero", comment: "comment-zero", by: "another-member", words: "Synthetic only." }, store);
  is("(control) a member still in is told", (await noticesFor(id, memberKey(kept))).notices.length, 1);
  await erasedMeanwhile(id, toldKey, told, carries("ZADD"), () =>
    tell(id, [toldKey], { kind: "mention", post: "post-one", comment: "comment-one", by: "another-member", words: "Synthetic only." }, store),
  );
  is("the erased person's complete export stays empty", await allNoticesOf(id, toldKey), []);
  is("the erased person's visible notice list stays empty", (await noticesFor(id, toldKey)).notices, []);

  part("#4789: a point admitted before the erasure");
  const author = "author@fence.example";
  const authorKey = memberKey(author);
  await touchMember(id, author, null, store);
  await award(id, memberKey(kept), 1, store);
  is("(control) a member still in earns a point", (await pointsOf(id, [memberKey(kept)])).get(memberKey(kept)), 1);
  await erasedMeanwhile(id, authorKey, author, carries("ZINCRBY"), () => award(id, authorKey, 1, store));
  is("the erased author has no points after the erasure", (await pointsOf(id, [authorKey])).get(authorKey) ?? 0, 0);
  is("and no place on any board key", redis.run(["ZSCORE", `nl:cm:${id}:pts`, authorKey]), null);
  await award(id, authorKey, 1, store);
  is("a like after the erasure gives them nothing either", (await pointsOf(id, [authorKey])).get(authorKey) ?? 0, 0);
  done();
}

main().catch((error) => {
  console.error = globalThis.console.log;
  console.log(error);
  process.exit(1);
});
