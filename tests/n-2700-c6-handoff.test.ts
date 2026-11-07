/**
 * A person's link use is read in its exact shape on the paths of their privacy
 * rights (CX-123 rule 24; proof in tests/sweep-m-r-mail-clicks.proof.ts, PR #2949).
 *
 * - forgetClicksPerson (lib/person-erasure.ts): a contact's HGET that is not a
 *   confirmed absent row (null) or a kept contact never reads as "no token".
 *   The module says it could not finish, nothing is taken for gone, and the
 *   list's row is kept for the retry, so the key their links carried
 *   (nl:mail:mk:<key>, kept 400 days) can still be found and deleted then.
 * - clicksOf (lib/person-copy.ts): an SMEMBERS that is not a list of strings
 *   never reads as "used no link"; the copy is refused instead.
 *
 * Synthetic data only; no provider is called.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { clicksOf, forgetClicksPerson, keyIndex, linkKeyOf, rememberLinkKeys } from "@/lib/mail-clicks";
import { leadsKey } from "@/lib/contacts";
import { erasePerson, erasureScope } from "@/lib/person-erasure";
import { copyPerson } from "@/lib/person-copy";
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Commands = (string | number)[][];
const LIST = "mailclicksexact00001";
const EMAIL = "reader@example.test";
const TOKEN = "a".repeat(40);
const CAMPAIGN = "s-0000000000000000-0000000000000000";

const original = redis.pipeline.bind(redis);
/** Answers `replies` (the whole pipeline's answer) for the pipelines `when` picks, `times` times. */
function answering(when: (commands: Commands) => boolean, replies: (real: unknown[]) => unknown, times = Infinity): () => number {
  let hit = 0;
  redis.pipeline = (async (commands: Commands) => {
    const real = await original(commands);
    if (hit < times && when(commands)) {
      hit++;
      return replies(real);
    }
    return real;
  }) as typeof redis.pipeline;
  return () => hit;
}
const restore = () => {
  redis.pipeline = original as typeof redis.pipeline;
};
const has = (name: string) => (commands: Commands) => commands.some((c) => c[0] === name);

async function exists(key: string): Promise<boolean> {
  return (await redisPipeline([["EXISTS", key]]))[0] === 1;
}

async function setUp(listId = LIST): Promise<string> {
  redis.clear();
  await redisPipeline([["HSET", leadsKey(listId), EMAIL, JSON.stringify({ agreed: true, t: TOKEN })]]);
  await rememberLinkKeys([TOKEN]);
  return keyIndex(linkKeyOf(TOKEN));
}

const UNKNOWN_HGET: [string, unknown][] = [
  ["an error string", "ERR"],
  ["an empty string", ""],
  ["a string that is not a contact", "not json"],
  ["an object", { agreed: true, t: TOKEN }],
  ["a number", 1],
  ["false", false],
  ["undefined", undefined],
  ["a list", [JSON.stringify({ agreed: true, t: TOKEN })]],
];

test("control: a kept contact's link key and used set are deleted, and the count is Redis's", async () => {
  const linkKey = await setUp();
  await redisPipeline([["SADD", `nl:mail:clk:${LIST}:x`, CAMPAIGN]]);
  assert.equal(await exists(linkKey), true, "the token is one the module accepts");
  assert.equal(await forgetClicksPerson(LIST, EMAIL), 1, "the link key went; no set was kept for this person");
  assert.equal(await exists(linkKey), false);
});

test("control: a confirmed absent row (null) has no link key, and the erasure goes on", async () => {
  redis.clear();
  assert.equal(await forgetClicksPerson(LIST, EMAIL), 0);
});

for (const [name, reply] of UNKNOWN_HGET) {
  test(`the contact's HGET answers ${name}: unknown, nothing taken for gone`, async () => {
    const linkKey = await setUp();
    const deletes: Commands[] = [];
    answering(has("HGET"), (real) => real.map(() => reply));
    const seen = redis.pipeline;
    redis.pipeline = (async (commands: Commands) => {
      if (has("DEL")(commands)) deletes.push(commands);
      return seen(commands);
    }) as typeof redis.pipeline;
    try {
      await assert.rejects(forgetClicksPerson(LIST, EMAIL), UnknownReplyError);
    } finally {
      restore();
    }
    assert.deepEqual(deletes, [], "no deletion is sent on a token that was not read");
    assert.equal(await exists(linkKey), true, "the link key is still there for the retry, not said gone");
  });
}

for (const [name, replies] of [["no reply", []], ["two replies", [null, null]], ["a hole", new Array(1)], ["not a list", "ERR"]] as const) {
  test(`the contact's HGET pipeline answers ${name}: unknown`, async () => {
    await setUp();
    answering(has("HGET"), () => replies);
    try {
      await assert.rejects(forgetClicksPerson(LIST, EMAIL), UnknownReplyError);
    } finally {
      restore();
    }
  });
}

for (const [name, reply] of [["a string", "1"], ["null", null], ["a negative", -1], ["a fraction", 1.5], ["a list", [1]]] as const) {
  test(`the DEL answers ${name}: unknown, never a count of zero`, async () => {
    await setUp();
    const run = answering(has("DEL"), (real) => real.map(() => reply));
    try {
      await assert.rejects(forgetClicksPerson(LIST, EMAIL), UnknownReplyError);
    } finally {
      restore();
    }
    assert.equal(run(), 1);
  });
}

test("the whole erasure stays incomplete on an unknown contact read, keeps the row, and a retry deletes the link key", async () => {
  redis.clear();
  const oldFetch = globalThis.fetch;
  const oldLog = console.error;
  globalThis.fetch = async () => {
    throw new Error("No external provider allowed");
  };
  const owner = "mail-clicks-owner@example.test";
  await claimHandle(owner, "mailclicksexact", "Mail Clicks Exact", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_MailClicksExact", subscriptionId: "sub_MailClicksExact", active: true, tier: "pro", period: paidPeriod() });
  const shop = (await storeForEmail(owner))!;
  const listId = shop.listId as string;
  await redisPipeline([["HSET", leadsKey(listId), EMAIL, JSON.stringify({ agreed: true, t: TOKEN })]]);
  await rememberLinkKeys([TOKEN]);
  const linkKey = keyIndex(linkKeyOf(TOKEN));
  const contactRead = (commands: Commands) => commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === leadsKey(listId);
  // Only the first read of the contact's row (lib/mail-clicks.ts's) answers in an unknown shape.
  const hits = answering(contactRead, () => ["ERR"], 1);
  console.error = () => {};
  try {
    const result = await erasePerson(shop, EMAIL, { kind: "person" });
    assert.equal(hits(), 1);
    assert.equal(result.ok, false, "an erasure that may leave the link key is never said done");
    assert.ok(!result.ok && result.reason === "incomplete");
    assert.ok(result.failed.includes("lib/mail-clicks.ts"));
    assert.ok(result.failed.includes("lib/contacts.ts"), "the list's row waits for the module that reads it");
    assert.equal(typeof (await redisPipeline([["HGET", leadsKey(listId), EMAIL]]))[0], "string", "the row, and so the token, is kept for the retry");
    assert.equal(await exists(linkKey), true);
    restore();
    const again = await erasePerson(shop, EMAIL, { kind: "person" });
    assert.equal(again.ok, true, "the same deletion finishes once the reads are confirmed");
    assert.equal(await exists(linkKey), false, "the key their links carried is gone");
    assert.equal((await redisPipeline([["HGET", leadsKey(listId), EMAIL]]))[0], null, "and so is the row");
  } finally {
    restore();
    globalThis.fetch = oldFetch;
    console.error = oldLog;
  }
});

test("control: the copy reads the emails whose links they used, sorted, and a confirmed empty set as none", async () => {
  redis.clear();
  assert.deepEqual(await clicksOf(LIST, EMAIL), []);
  const second = "s-1111111111111111-1111111111111111";
  answering(has("SMEMBERS"), () => [[second, CAMPAIGN]]);
  try {
    assert.deepEqual(await clicksOf(LIST, EMAIL), [CAMPAIGN, second]);
  } finally {
    restore();
  }
});

for (const [name, reply] of [["an error string", "ERR"], ["null", null], ["an object", { 0: CAMPAIGN, length: 1 }], ["a number in the list", [1]], ["a hole", new Array(1)]] as const) {
  test(`the copy's SMEMBERS answers ${name}: unknown, never "used no link"`, async () => {
    redis.clear();
    answering(has("SMEMBERS"), (real) => real.map(() => reply));
    try {
      await assert.rejects(clicksOf(LIST, EMAIL), UnknownReplyError);
    } finally {
      restore();
    }
  });
}

test("the person's copy is refused as a whole when their link use cannot be read", async () => {
  redis.clear();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("No external provider allowed");
  };
  const owner = "mail-clicks-copy@example.test";
  await claimHandle(owner, "mailclickscopy", "Mail Clicks Copy", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  const shop = (await storeForEmail(owner))!;
  const scope = await erasureScope(shop, EMAIL);
  assert.ok(scope);
  const clicksRead = (commands: Commands) => commands.length === 1 && commands[0][0] === "SMEMBERS" && String(commands[0][1]).startsWith(`nl:mail:clk:${shop.listId}:`);
  const hits = answering(clicksRead, () => ["ERR"], 1);
  try {
    await assert.rejects(copyPerson(scope), UnknownReplyError);
    assert.equal(hits(), 1, "the link-use read is the one that answered unknown");
  } finally {
    restore();
    globalThis.fetch = oldFetch;
  }
});
