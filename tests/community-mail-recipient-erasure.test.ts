/**
 * Codex L-20261121-0758 (MEDIUM, #5010 row 20): an announcement's recipients (nl:cm:mail:<job>:to) kept a member's
 * key, derived from their address, for up to 60 days after the member's erasure said done. Now the erasure replaces
 * their key in place in every announcement of the community still under way (lib/community-mail.ts
 * forgetAnnouncementRecipient, FORGET_RECIPIENT), walking the community's own line (nl:cm:<id>:mailq), which
 * queueAnnouncement writes and the worker leaves with the company's one. Synthetic data on the in-memory Redis.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { ERASURE_ANNOUNCEMENTS_MOST, advanceAnnouncement, forgetAnnouncementRecipient, type AnnouncementJob } from "@/lib/community-mail";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];

const community = "0123456789abcdef0123456789abcdef";
const other = "fedcba9876543210fedcba98765432ff";
const member = "fedcba9876543210fedcba9876543210";
const email = "fictional.member@example.test";
const x = "a".repeat(32);
const y = "b".repeat(32);
const KEY = /^[0-9a-f]{32}$/;
const jobId = (n: number) => n.toString(16).padStart(24, "0");
const toKey = (id: string) => `nl:cm:mail:${id}:to`;
const line = (id: string) => `nl:cm:${id}:mailq`;

const original = redis.pipeline;
const call = (c: Command[]) => original.call(redis, c);

function job(id: string, of: string, total: number, status: AnnouncementJob["status"] = "sending"): AnnouncementJob {
  return { id, community: of, handle: "synthetic", post: "f".repeat(12), subject: "Synthetic", body: "Synthetic", total, done: 0, sent: 0, status, note: "", failures: 0 };
}

async function seed(jobs: { id: string; of: string; to: string[]; inLine?: boolean }[]) {
  redis.clear();
  const record = { k: member, e: email, n: "Fictional Member", h: "", dir: false, mail: true, at: 1, seen: 1, removed: false, muted: false };
  const commands: Command[] = [["HSET", `nl:cm:${community}:m`, member, JSON.stringify(record)]];
  for (const j of jobs) {
    commands.push(["SET", `nl:cm:mail:${j.id}`, JSON.stringify(job(j.id, j.of, j.to.length))], ["RPUSH", toKey(j.id), ...j.to], ["SADD", "nl:cm:mailq", j.id]);
    if (j.inLine !== false) commands.push(["SADD", line(j.of), j.id]);
  }
  await call(commands);
}
const list = async (id: string) => (await call([["LRANGE", toKey(id), 0, -1]]))[0] as string[];

test("the erasure replaces the member's key in place in every announcement of the community under way", async () => {
  await seed([
    { id: jobId(1), of: community, to: [x, member, y] },
    { id: jobId(2), of: community, to: [member] },
    { id: jobId(3), of: community, to: [x, y] },
    { id: jobId(4), of: other, to: [member, x] },
  ]);
  await forgetCommunityPerson(community, member, email, []);
  const [one, two, three, four] = await Promise.all([jobId(1), jobId(2), jobId(3), jobId(4)].map(list));
  assert.equal(one.length, 3, "the list keeps its length, so the send's cursor keeps its meaning");
  assert.deepEqual([one[0], one[2]], [x, y], "the other members keep their places");
  assert.ok(one[1] !== member && KEY.test(one[1]), "the member's place holds a random key of the same shape");
  assert.ok(two[0] !== member && KEY.test(two[0]), "at the start of a list too");
  assert.equal(two[0], one[1], "one tombstone for the whole erasure");
  assert.deepEqual(three, [x, y], "a list without them is untouched");
  assert.deepEqual(four, [member, x], "another community's announcement is that community's erasure's, not this one's");
  assert.deepEqual(await call([["SMEMBERS", line(community)]]).then(([ids]) => (ids as string[]).sort()), [jobId(1), jobId(2), jobId(3)], "the community's line is kept: the sends go on");
  assert.equal((await call([["HGET", `nl:cm:${community}:m`, member]]))[0], null, "and the member's record went");
});

test("an announcement queued before the community's line existed is not walked (its send never emails an erased member)", async () => {
  await seed([{ id: jobId(5), of: community, to: [member], inLine: false }]);
  assert.equal(await forgetAnnouncementRecipient(community, member), 0);
  assert.deepEqual(await list(jobId(5)), [member]);
});

test("unknown is never done: a line that does not read, too many announcements, or a member listed twice", async () => {
  await seed([{ id: jobId(6), of: community, to: [member, x, member] }]);
  await assert.rejects(() => forgetAnnouncementRecipient(community, member), /unknown/i);
  assert.deepEqual(await list(jobId(6)), [member, x, member], "nothing written");
  await assert.rejects(() => forgetCommunityPerson(community, member, email, []), /unknown/i);
  assert.notEqual((await call([["HGET", `nl:cm:${community}:m`, member]]))[0], null, "the erasure is not said done: the record stays for the retry");

  await seed(Array.from({ length: ERASURE_ANNOUNCEMENTS_MOST + 1 }, (_, i) => ({ id: jobId(100 + i), of: community, to: [member] })));
  await assert.rejects(() => forgetAnnouncementRecipient(community, member), /unknown/i);
  await seed(Array.from({ length: ERASURE_ANNOUNCEMENTS_MOST }, (_, i) => ({ id: jobId(100 + i), of: community, to: [member] })));
  assert.equal(await forgetAnnouncementRecipient(community, member), ERASURE_ANNOUNCEMENTS_MOST, "at the most, every one is walked");

  await seed([]);
  await call([["SADD", line(community), "not-a-job-id"]]);
  await assert.rejects(() => forgetAnnouncementRecipient(community, member), /unknown/i);
  await assert.rejects(() => forgetAnnouncementRecipient(community, ""), /unknown/i);

  await seed([{ id: jobId(7), of: community, to: [x] }]);
  redis.pipeline = (async (commands: Command[]) => (commands[0]?.[0] === "SMEMBERS" ? ["garbage"] : call(commands))) as typeof redis.pipeline;
  try {
    await assert.rejects(() => forgetAnnouncementRecipient(community, member), /unknown/i);
  } finally {
    redis.pipeline = original;
  }
});

test("nothing under way: nothing to walk", async () => {
  await seed([]);
  assert.equal(await forgetAnnouncementRecipient(community, member), 0);
});

test("a send that is over leaves the community's line with the company's", async () => {
  await seed([{ id: jobId(8), of: community, to: [x] }]);
  await call([["SET", `nl:cm:mail:${jobId(8)}`, JSON.stringify(job(jobId(8), community, 1, "sent"))]]);
  await advanceAnnouncement(jobId(8), async () => null, Date.now() + 1000);
  const [company, own] = await call([["SISMEMBER", "nl:cm:mailq", jobId(8)], ["SISMEMBER", line(community), jobId(8)]]);
  assert.deepEqual([company, own], [0, 0]);
});
