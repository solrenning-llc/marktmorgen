/**
 * A join request held on an old Store cannot recreate its confirmation link, its erasure note or its email once the
 * store's erasure has begun (Codex L-20261120-2002, MEDIUM, lib/store-join.ts askToJoin).
 *
 * askToJoin admits the request on the Store it was handed and then waits on two limits. Meanwhile the closing walk can
 * write the store's erasing mark, delete its identity and prune the person's erasure notes and the links they name.
 * The grant (nl:join:t:), its note (nl:erase:ix:...:z) and the email must then never appear: the store must still be
 * its own and not erasing in the same step as both writes, and the email is sent only after that step said yes.
 *
 * Checked with the real askToJoin on the in-memory Redis, the closing write interleaved just before the grant's write;
 * synthetic store and addresses, Resend stubbed, nothing leaves.
 */
import { createHash } from "node:crypto";
import { ERASING_KEY, claimHandle, ensureListId, ensureStatsId, ensureStoreId, erasingField, ownerKey, setJoin, setStripeAccount, setSubscription, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { askToJoin } from "@/lib/store-join";
import { normaliseEmail } from "@/lib/auth";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    sent.push(String((JSON.parse(String(init?.body)) as { to?: unknown }).to));
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

const grants = () => redis.keys().filter((key) => key.startsWith("nl:join:t:")).length;
const notesOf = (statsId: string, email: string) =>
  Number(redis.run(["ZCARD", `nl:erase:ix:${statsId}:${createHash("sha256").update(`nimbus-erase-ix:${statsId}:${normaliseEmail(email)}`).digest("hex").slice(0, 32)}:z`]));

let ip = 0;
const ask = (store: NonNullable<Awaited<ReturnType<typeof storeForEmail>>>, email: string) =>
  askToJoin({ store, email, ip: `198.18.2.${++ip}`, origin: "https://marktmorgen.com" });

/** Runs `then` once, just before the first write that names a join grant (the grant's SET, or the step that holds it). */
function beforeGrantWrite(then: () => Promise<unknown>): () => void {
  const original = redis.pipeline.bind(redis);
  let fired = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!fired && commands.some((command) => command.map(String).some((word) => word.startsWith("nl:join:t:")))) {
      fired = true;
      await then();
    }
    return original(commands);
  }) as typeof redis.pipeline;
  return () => { redis.pipeline = original; };
}

async function openStore(owner: string, handle: string, withId = true) {
  await claimHandle(owner, handle, "Join Fence", "");
  await ensureStatsId(owner);
  if (withId) await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, `acct_${handle}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  await setJoin(owner, { on: true });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

  part("A live store: the link, its note and the email, as before");
  const live = await openStore("owner@join-fence.example", "joinfence", true);
  is("the request is sent", await ask(live, "ann@join-fence.example"), "sent");
  is("one grant is kept", grants(), 1);
  is("its erasure note is kept", notesOf(live.statsId!, "ann@join-fence.example"), 1);
  is("one email went out", sent.length, 1);

  part("The erasure begins while the request waits: nothing is made, nobody is written to");
  const erasing = await erasingField(storeRef(live));
  let mailed = sent.length;
  let grantsBefore = grants();
  let undo = beforeGrantWrite(() => redis.pipeline([["HSET", ERASING_KEY, erasing, String(Date.now())]]));
  is("the request is refused as closed", await ask(live, "bo@join-fence.example"), "closed");
  undo();
  is("no grant is made", grants() - grantsBefore, 0);
  is("no erasure note is made", notesOf(live.statsId!, "bo@join-fence.example"), 0);
  is("no email went out", sent.length - mailed, 0);
  await redis.pipeline([["HDEL", ERASING_KEY, erasing]]);

  part("The store's identity is gone (its record closed) while the request waits");
  const [, idKey] = storeIdCommand(live.sid);
  const record = redis.run(["GET", idKey]);
  mailed = sent.length;
  grantsBefore = grants();
  undo = beforeGrantWrite(() => redis.pipeline([["DEL", idKey]]));
  is("the request is refused as closed", await ask(live, "cy@join-fence.example"), "closed");
  undo();
  is("no grant is made", grants() - grantsBefore, 0);
  is("no erasure note is made", notesOf(live.statsId!, "cy@join-fence.example"), 0);
  is("no email went out", sent.length - mailed, 0);
  await redis.pipeline([["SET", idKey, String(record)]]);

  part("An unknown answer to the step: no email for a link that may not exist");
  mailed = sent.length;
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.some((command) => command.map(String).some((word) => word.startsWith("nl:join:t:"))) ? commands.map(() => "QUEUED") : original(commands)) as typeof redis.pipeline;
  is("the request is an error", await ask(live, "di@join-fence.example"), "error");
  redis.pipeline = original;
  is("no email went out", sent.length - mailed, 0);

  part("A store from before ids: its owner's record must still be its own");
  // As tests/store-live-cache-same-store.test.ts does: a store read as one kept from before ids, its sid "".
  const old = { ...(await openStore("owner@join-old.example", "joinold", false)), sid: "", extra: false };
  is("this store has no id and a statsId", [old.sid, (old.statsId ?? "").length > 0], ["", true]);
  mailed = sent.length;
  is("the request is sent", await ask(old, "ed@join-fence.example"), "sent");
  is("one more email went out", sent.length - mailed, 1);
  const ownerRecord = await ownerKey(storeRef(old));
  const before = String(redis.run(["GET", ownerRecord]));
  mailed = sent.length;
  undo = beforeGrantWrite(() => redis.pipeline([["SET", ownerRecord, JSON.stringify({ ...JSON.parse(before), statsId: "zzzzzzzzzzzz" })]]));
  is("a record that is now another store's refuses the request", await ask(old, "fay@join-fence.example"), "closed");
  undo();
  is("no erasure note is made", notesOf(old.statsId!, "fay@join-fence.example"), 0);
  is("no email went out", sent.length - mailed, 0);
  await redis.pipeline([["SET", ownerRecord, before]]);
  mailed = sent.length;
  undo = beforeGrantWrite(() => redis.pipeline([["DEL", ownerRecord]]));
  is("a record that is gone refuses the request", await ask(old, "gil@join-fence.example"), "closed");
  undo();
  is("no email went out", sent.length - mailed, 0);

  // Codex L on #4995 (L-20261120-2142, MEDIUM): on Redis a ZADD on a key of another type fails the script after its SET
  // has already run, and nothing is undone, so the grant would stay with no note for the person's erasure to find it.
  part("The person's erasure notes hold another type: no grant without its note, nobody written to");
  const email = "hal@join-fence.example";
  const notes = `nl:erase:ix:${live.statsId}:${createHash("sha256").update(`nimbus-erase-ix:${live.statsId}:${normaliseEmail(email)}`).digest("hex").slice(0, 32)}:z`;
  await redis.pipeline([["SET", notes, "not-a-sorted-set"]]);
  grantsBefore = grants();
  mailed = sent.length;
  is("the request is an error", await ask(live, email), "error");
  is("no grant is made", grants(), grantsBefore);
  is("no email went out", sent.length - mailed, 0);

  done();
}

main();
