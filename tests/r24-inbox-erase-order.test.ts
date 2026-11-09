/**
 * Erasing a person's inbox conversations stays recoverable when Redis fails
 * part-way (synthetic; Codex J's review 5814674643 on #3113, its proof
 * tests/j-3113-partial-erase.proof.ts @ 640e9204c6, SHA-256 7e70dd4f...).
 *
 * A Redis REST pipeline is not a transaction: a command after one that errors
 * can still be applied, and lib/redis.ts then throws. If the index entry is
 * removed while the conversation, its messages and its token stay, the first
 * erasure honestly throws, but the retry no longer finds the conversation,
 * answers 0 ("done") and leaves everything kept. Here the person's data must
 * always be found again by a healthy retry and be gone after it, with the
 * other buyer's conversation untouched.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fileContact, forgetInboxPerson, readInbox, tokenHandle, visitorThread } from "@/lib/inbox";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner.r24@example.test";
const ANA = "ana.r24@example.test";
const BEN = "ben.r24@example.test";

type Command = (string | number)[];

async function setup() {
  redis.clear();
  await claimHandle(OWNER, "r24inbox", "R24 Inbox", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_R24Inbox01", subscriptionId: "sub_R24Inbox01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  assert.equal(await fileContact({ store, email: ANA, name: "Ana", text: "Hello, a question about the course." }), true);
  assert.equal(await fileContact({ store, email: BEN, name: "Ben", text: "Hello, do you do collaborations?" }), true);
  const statsId = store.statsId!;
  const all = await readInbox(statsId);
  assert.equal(all.length, 2);
  const ana = all.find((c) => c.email === ANA)!;
  const ben = all.find((c) => c.email === BEN)!;
  const kept = JSON.parse(String(redis.run(["GET", `nl:inbox:${statsId}:c:${ana.id}`]))) as { token: string };
  return { statsId, anaId: ana.id, benId: ben.id, token: kept.token };
}

/** Is this the deletion of Ana's own records (her conversation key among the DEL's keys)? */
const deletesAna = (command: Command | undefined, statsId: string, anaId: string) =>
  command?.[0] === "DEL" && command.includes(`nl:inbox:${statsId}:c:${anaId}`);
/** Is this the removal of Ana's id from the creator's index? */
const unindexesAna = (command: Command | undefined, statsId: string, anaId: string) =>
  command?.[0] === "ZREM" && command[1] === `nl:inbox:${statsId}:all` && command.slice(2).includes(anaId);

/**
 * Runs the first erasure with `fault` deciding, once, what the storage does with
 * the first pipeline it matches; every later pipeline is healthy. Then a healthy
 * retry runs, and what is left is read back from the storage itself.
 */
type World = Awaited<ReturnType<typeof setup>>;

async function eraseWithFault(fault: (commands: Command[], original: (c: Command[]) => Promise<unknown[]>, world: World) => Promise<unknown[]> | null) {
  const world = await setup();
  const { statsId, anaId, benId, token } = world;
  const original = redis.pipeline.bind(redis) as (c: Command[]) => Promise<unknown[]>;
  let injected = 0;
  redis.pipeline = (async (commands: Command[]) => {
    if (!injected) {
      const faulty = fault(commands, original, world);
      if (faulty) {
        injected++;
        return faulty;
      }
    }
    return original(commands);
  }) as typeof redis.pipeline;
  let first: unknown;
  try {
    first = await forgetInboxPerson(statsId, ANA);
  } catch {
    first = "threw";
  } finally {
    redis.pipeline = original as typeof redis.pipeline;
  }
  const retry = await forgetInboxPerson(statsId, ANA).then((n) => n, () => "threw");
  return {
    injected,
    first,
    retry,
    conversation: redis.run(["GET", `nl:inbox:${statsId}:c:${anaId}`]),
    messages: redis.run(["LRANGE", `nl:inbox:${statsId}:m:${anaId}`, 0, -1]),
    token: redis.run(["GET", `nl:inbox:tok:${token}`]),
    handle: await tokenHandle(token),
    visitor: await visitorThread(token),
    index: redis.run(["ZREVRANGE", `nl:inbox:${statsId}:all`, 0, -1]),
    shown: (await readInbox(statsId)).map((c) => c.email),
    benId,
  };
}

function assertErasedAndRecoverable(r: Awaited<ReturnType<typeof eraseWithFault>>, label: string) {
  assert.equal(r.injected, 1, `${label}: the fault was never injected`);
  assert.equal(r.first, "threw", `${label}: a partial erasure was answered ${String(r.first)}, not as not done`);
  assert.equal(typeof r.retry, "number", `${label}: the healthy retry did not finish`);
  assert.equal(r.conversation, null, `${label}: the retry answered ${String(r.retry)} while the conversation is still kept`);
  assert.deepEqual(r.messages, [], `${label}: the conversation's messages are still kept`);
  assert.equal(r.token, null, `${label}: the chat token is still kept`);
  assert.equal(r.handle, null, `${label}: the chat token still opens the store`);
  assert.equal(r.visitor, null, `${label}: the visitor's chat still reads the conversation`);
  assert.deepEqual(r.index, [r.benId], `${label}: the index is not exactly the other buyer's conversation`);
  assert.deepEqual(r.shown, [BEN], `${label}: the other buyer's conversation was not kept`);
}

test("J's fault: the DEL of the person's records errors while a later command in the same pipeline is applied", async () => {
  const r = await eraseWithFault((commands, original, w) => {
    const at = commands.findIndex((c) => deletesAna(c, w.statsId, w.anaId));
    if (at < 0) return null;
    // Every other command of that pipeline is applied, the DEL is not, and the REST wrapper throws.
    return original(commands.filter((_, i) => i !== at)).then(() => {
      throw new Error("synthetic DEL failed, the rest of the pipeline applied");
    });
  });
  assertErasedAndRecoverable(r, "DEL failed");
});

test("the DEL is applied but its reply is lost: the retry still clears the index", async () => {
  const r = await eraseWithFault((commands, original, w) => {
    if (!commands.some((c) => deletesAna(c, w.statsId, w.anaId))) return null;
    return original(commands).then(() => {
      throw new Error("synthetic reply lost after the DEL applied");
    });
  });
  assertErasedAndRecoverable(r, "DEL reply lost");
});

test("the DEL is applied but answers an off-shape count: not said as done, and recoverable", async () => {
  const r = await eraseWithFault((commands, original, w) => {
    if (!commands.some((c) => deletesAna(c, w.statsId, w.anaId))) return null;
    return original(commands).then((replies) => replies.map((reply, i) => (deletesAna(commands[i], w.statsId, w.anaId) ? "3" : reply)));
  });
  assertErasedAndRecoverable(r, "DEL off-shape");
});

test("the DEL answers more keys than were sent: not said as done, and recoverable", async () => {
  const r = await eraseWithFault((commands, original, w) => {
    if (!commands.some((c) => deletesAna(c, w.statsId, w.anaId))) return null;
    return original(commands).then((replies) => replies.map((reply, i) => (deletesAna(commands[i], w.statsId, w.anaId) ? 99 : reply)));
  });
  assertErasedAndRecoverable(r, "DEL count above keys");
});

test("the index removal fails after the records are deleted: the retry finds the id with nothing kept and removes it", async () => {
  const r = await eraseWithFault((commands, _original, w) => {
    if (!commands.some((c) => unindexesAna(c, w.statsId, w.anaId))) return null;
    // Nothing of this pipeline is applied.
    return Promise.reject(new Error("synthetic ZREM failed"));
  });
  assertErasedAndRecoverable(r, "ZREM failed");
});

test("the index removal is applied but answers off-shape: not said as done, and recoverable", async () => {
  const r = await eraseWithFault((commands, original, w) => {
    if (!commands.some((c) => unindexesAna(c, w.statsId, w.anaId))) return null;
    return original(commands).then((replies) => replies.map(() => "1"));
  });
  assertErasedAndRecoverable(r, "ZREM off-shape");
});

test("healthy erasure: one pass removes the person's records and index entry, and the other buyer stays", async () => {
  const { statsId, anaId, benId, token } = await setup();
  assert.equal(await forgetInboxPerson(statsId, ANA), 1);
  assert.equal(redis.run(["GET", `nl:inbox:${statsId}:c:${anaId}`]), null);
  assert.deepEqual(redis.run(["LRANGE", `nl:inbox:${statsId}:m:${anaId}`, 0, -1]), []);
  assert.equal(redis.run(["GET", `nl:inbox:tok:${token}`]), null);
  assert.equal(await visitorThread(token), null);
  assert.deepEqual(redis.run(["ZREVRANGE", `nl:inbox:${statsId}:all`, 0, -1]), [benId]);
  assert.equal(await forgetInboxPerson(statsId, ANA), 0);
  assert.deepEqual((await readInbox(statsId)).map((c) => c.email), [BEN]);
});
