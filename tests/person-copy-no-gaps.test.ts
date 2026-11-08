/**
 * A part of the person's data copy that cannot be read fails the copy (GDPR art. 15, CX-123 rule 24): the
 * contact record, the affiliate bond, the membership invitations and the store's call packages (the set and each
 * listed package's record, with a member that is not a checkout id) each refuse a reply in an unknown shape, so
 * the copy is retried rather than handed over with that part silently missing. Confirmed absence (no record, an
 * empty set) stays an empty part, and a record kept as written is copied. Synthetic data, the in-memory Redis
 * stub, no provider.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { COPIERS, copyPerson } from "@/lib/person-copy";
import { erasureScope } from "@/lib/person-erasure";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { leadsKey } from "@/lib/contacts";
import { inviteField } from "@/lib/move-members";
import { packagesKey } from "@/lib/call-packages";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { ErasureScope } from "@/lib/erasure-rules";
import { store as redis } from "./redis-stub";

const owner = "nogaps-owner@example.com", email = "nogaps-person@example.com", productId = "synthetic_course";

const fixture = (async () => {
  redis.clear();
  await claimHandle(owner, "nogapscopy", "Synthetic no-gaps shop", "");
  await ensureStatsId(owner);
  const store = (await storeForEmail(owner))!;
  const scope = (await erasureScope(store, email))!;
  assert.ok(scope.listId && scope.statsId, "the synthetic store has a list and stats id");
  // One product to read an invitation for, as the scope would list it.
  return { ...scope, productIds: [productId] } as ErasureScope;
})();

const contactRecord = JSON.stringify({ agreed: true, agreedAt: "2026-11-01T00:00:00.000Z", firstAt: "2026-11-01T00:00:00.000Z", lastAt: "2026-11-01T00:00:00.000Z", titles: [], ids: [], source: "free", unsub: false, unsubAt: "" });
const inviteRecord = JSON.stringify({ e: email, p: productId, o: "", r: 1500, job: "", at: 1_700_000_000, t: "synthetictoken0000000000", kept: 0 });

/** Each copier, how to find its one read in a pipeline, and a reply that says nothing is kept. */
const parts = (s: ErasureScope) => [
  { module: "lib/contacts.ts", is: (c: unknown[]) => c[0] === "HGET" && c[1] === leadsKey(s.listId!), absent: null, healthy: contactRecord },
  { module: "lib/affiliate-bond.ts", is: (c: unknown[]) => c[0] === "HGET" && c[1] === `nl:aff:${s.statsId}:bond`, absent: null, healthy: "0123456789ab" },
  { module: "lib/move-members.ts", is: (c: unknown[]) => c[0] === "HGET" && c[1] === `nl:mv:${s.statsId}` && c[2] === inviteField(s.email, productId), absent: null, healthy: inviteRecord },
  { module: "lib/call-packages.ts", is: (c: unknown[]) => c[0] === "SMEMBERS" && c[1] === packagesKey(s.statsId), absent: [] as unknown, healthy: null as unknown },
] as const;

/** Runs `run` with the one read of `part` answered by `reply` (a function of the real pipeline's answer). */
async function withReply<T>(match: (c: unknown[]) => boolean, reply: (real: unknown[]) => unknown[], run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  let hit = 0;
  redis.pipeline = async (batch) => {
    if (batch.length === 1 && match(batch[0] as unknown[])) {
      hit += 1;
      return reply(await real(batch)) as never;
    }
    return real(batch);
  };
  try {
    return await run();
  } finally {
    redis.pipeline = real;
    assert.ok(hit > 0, "the copier made the read under test");
  }
}

const malformed: [string, (real: unknown[]) => unknown[]][] = [
  ["a missing reply", () => []],
  ["a number for a record", () => [42]],
  ["an object for a record", () => [{ agreed: true }]],
];

for (const index of [0, 1, 2]) {
  for (const [label, reply] of [...malformed, ["a record that is not JSON", () => ["{not json"]] as [string, (real: unknown[]) => unknown[]]]) {
    // A bond is kept as the affiliate's id itself, not JSON: any text is the record.
    if (index === 1 && label === "a record that is not JSON") continue;
    test(`${["contacts", "affiliate bond", "invitation"][index]}: ${label} fails the copy, never an empty part`, async () => {
      const scope = await fixture;
      const part = parts(scope)[index];
      await withReply(part.is, reply, async () => {
        await assert.rejects(() => COPIERS[part.module](scope), UnknownReplyError);
      });
    });
  }
}

for (const [label, reply] of [
  ["a missing reply", () => []],
  ["null for the set", () => [null]],
  ["a text for the set", () => ["cs_test_0000000000"]],
  ["a number among the members", () => [[7]]],
] as [string, (real: unknown[]) => unknown[]][]) {
  test(`call packages: ${label} fails the copy, never an empty part`, async () => {
    const scope = await fixture;
    const part = parts(scope)[3];
    await withReply(part.is, reply, async () => {
      await assert.rejects(() => COPIERS[part.module](scope), UnknownReplyError);
    });
  });
}

// A package listed for the store whose record cannot be read: the record is the only place that says whose it is,
// so it is never taken as "not theirs" (lib/person-copy.ts, packageForCopy).
const listed = "cs_test_nogapspackage00";
const packageRead = (c: unknown[]) => c[0] === "GET" && c[1] === `nl:pkg:${listed}`;
const packageRecord = (e: string) => JSON.stringify({ s: "x", h: "nogapscopy", p: "synthetic_call", e, total: 3, at: 1_700_000_000, until: 0, token: "t", holds: [] });
for (const [label, reply] of [
  ["a missing reply", () => []],
  ["a number for the record", () => [42]],
  ["a record that is not JSON", () => ["{nope"]],
  ["a record that is JSON but not an object", () => ['"7"']],
  ["a record that is a list", () => ["[1,2]"]],
  ["a record with no buyer", () => [JSON.stringify({ p: "synthetic_call", total: 3, at: 1, until: 0, holds: [] })]],
  ["a record whose buyer is not text", () => [JSON.stringify({ p: "synthetic_call", e: 7, total: 3, at: 1, until: 0, holds: [] })]],
] as [string, (real: unknown[]) => unknown[]][]) {
  test(`call packages: ${label} for a listed package fails the copy, never an empty part`, async () => {
    const scope = await fixture;
    await redis.pipeline([["DEL", packagesKey(scope.statsId)], ["SADD", packagesKey(scope.statsId), listed]]);
    await withReply(packageRead, reply, async () => {
      await assert.rejects(() => COPIERS["lib/call-packages.ts"](scope), UnknownReplyError);
    });
  });
}

test("call packages: a listed member that is not a checkout id fails the copy, never skipped", async () => {
  const scope = await fixture;
  await withReply(parts(scope)[3].is, () => [["not-a-checkout"]], async () => {
    await assert.rejects(() => COPIERS["lib/call-packages.ts"](scope), UnknownReplyError);
  });
});

test("call packages: a listed package with no record (ran out) is confirmed none, and the person's own is copied", async () => {
  const scope = await fixture;
  await redis.pipeline([["DEL", packagesKey(scope.statsId), `nl:pkg:${listed}`], ["SADD", packagesKey(scope.statsId), listed]]);
  assert.deepEqual(await withReply(packageRead, () => [null], () => COPIERS["lib/call-packages.ts"](scope)), []);
  await redis.pipeline([["SET", `nl:pkg:${listed}`, packageRecord("someone-else@example.com")]]);
  assert.deepEqual(await COPIERS["lib/call-packages.ts"](scope), []);
  await redis.pipeline([["SET", `nl:pkg:${listed}`, packageRecord(email)]]);
  const copied = (await COPIERS["lib/call-packages.ts"](scope)) as { product: string; sessions: number }[];
  assert.deepEqual(copied.map((c) => [c.product, c.sessions]), [["synthetic_call", 3]]);
  await redis.pipeline([["DEL", packagesKey(scope.statsId), `nl:pkg:${listed}`]]);
});

test("the whole copy fails, never handed over, when the contact record cannot be read", async () => {
  const scope = await fixture;
  await withReply(parts(scope)[0].is, () => [42], async () => {
    await assert.rejects(() => copyPerson(scope), UnknownReplyError);
  });
});

test("confirmed absence stays an empty part", async () => {
  const scope = await fixture;
  for (const part of parts(scope)) {
    const records = await withReply(part.is, () => [part.absent], () => COPIERS[part.module](scope));
    assert.deepEqual(records, [], part.module);
  }
});

test("a record kept as written is copied", async () => {
  const scope = await fixture;
  const [contacts, bond, invite] = parts(scope);
  const contact = (await withReply(contacts.is, () => [contacts.healthy], () => COPIERS[contacts.module](scope))) as { email: string; agreed: boolean }[];
  assert.deepEqual(contact.map((c) => [c.email, c.agreed]), [[email, true]]);
  assert.deepEqual(await withReply(bond.is, () => [bond.healthy], () => COPIERS[bond.module](scope)), [{ affiliate: "0123456789ab" }]);
  const invites = (await withReply(invite.is, () => [invite.healthy], () => COPIERS[invite.module](scope))) as { product: string; e: string }[];
  assert.deepEqual(invites.map((i) => [i.product, i.e]), [[productId, email]]);
  // A package sold to somebody else, read from the real stub: the set is read, and nothing of theirs is copied.
  await redis.pipeline([["SADD", packagesKey(scope.statsId), "cs_test_0000000000"]]);
  assert.deepEqual(await COPIERS["lib/call-packages.ts"](scope), []);
});
