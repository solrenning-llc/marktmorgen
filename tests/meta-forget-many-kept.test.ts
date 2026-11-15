/**
 * Meta's deletion notice for a person with more kept stores than one pass walks (Claude 6 on #4819, LOW): a store
 * connected after the notice is kept, and kept in the person's index, so with more than META_FORGET_PASS of them every
 * later pass still saw more stores than it walked and answered 503 for good, even once nothing forgettable was left
 * (51 kept: 0 of 20 passes finished). Each notice now keeps where its passes left off in id order, so a round walks every
 * store once and is answered as done after at most ceil(stores / META_FORGET_PASS) passes, every pass bounded.
 * Rule 24: an unknown reply for that place, or for writing it, is never "done". Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { META_FORGET_PASS, forgetMetaUser } from "@/lib/meta-ads";
import { store as redis } from "./redis-stub";

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
const userKey = (user: string) => `nl:metaads:user:${hash(`metaads-user:${user}`)}`;
const connKey = (statsId: string) => `nl:metaads:conn:${statsId}`;
const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);
type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

function seed(user: string, statsId: string, connectedAt: number) {
  redis.run(["SADD", userKey(user), statsId]);
  redis.run(["SADD", "nl:metaads:stores", statsId]);
  redis.run(["SET", connKey(statsId), JSON.stringify({ user, token: "sealed", accounts: [], account: "", sid: "sid-1", connectedAt, owner: { email: `owner@${statsId}.example`, handle: statsId } })]);
}

/** Runs passes until one is answered as done; what each forgot, how many passes, and the most commands one sent. */
async function untilDone(user: string, cutoff: number, most: number) {
  const forgot: string[] = [];
  let passes = 0;
  let done = false;
  let heaviest = 0;
  while (!done && passes < most) {
    passes += 1;
    let sent = 0;
    redis.pipeline = async (commands: Command[]) => {
      sent += commands.length;
      return real(commands);
    };
    try {
      forgot.push(...(await forgetMetaUser(user, cutoff)).map((one) => one.statsId));
      done = true;
    } catch (error) {
      forgot.push(...((error as { forgot?: { statsId: string }[] }).forgot ?? []).map((one) => one.statsId));
    } finally {
      redis.pipeline = real;
    }
    heaviest = Math.max(heaviest, sent);
  }
  return { forgot, passes, done, heaviest };
}

/** The most commands one pass may send: the index and its place, a read and a five-command deletion per walked store, and the index's and place's writes. */
const PASS_COMMANDS = 2 + META_FORGET_PASS * 6 + 2;

for (const keptCount of [49, 50, 51, 52, 99, 100, 101, 160]) {
  test(`Meta: ${keptCount} kept stores and three old ones: answered as done within ceil(stores / pass) passes, every kept store kept`, async () => {
    redis.clear();
    const user = `1015000000000${String(keptCount).padStart(4, "0")}`;
    const now = Date.now();
    const cutoff = now - 60_000;
    const kept = ids(keptCount, "ka");
    for (const s of kept) seed(user, s, now);
    // Old stores before, among and after the kept ones in id order.
    const old = ["a-old", "ka025x-old", "zz-old"];
    for (const s of old) seed(user, s, cutoff - 3_600_000);
    const total = keptCount + old.length;
    const bound = Math.ceil(total / META_FORGET_PASS);
    const out = await untilDone(user, cutoff, bound);
    assert.equal(out.done, true, `answered as done within ${bound} passes`);
    assert.deepEqual(out.forgot.sort(), [...old].sort(), "every old store forgotten once, and only those");
    for (const s of old) assert.equal(redis.run(["EXISTS", connKey(s)]), 0, `${s}'s connection is gone`);
    assert.equal(kept.filter((s) => redis.run(["EXISTS", connKey(s)]) === 1).length, keptCount, "every kept store is kept");
    assert.deepEqual((redis.run(["SMEMBERS", userKey(user)]) as string[]).sort(), kept, "the index holds exactly the kept stores");
    assert.ok(out.heaviest <= PASS_COMMANDS, `a pass sent ${out.heaviest} commands, at most ${PASS_COMMANDS}`);
    // The same notice sent again is answered as done at once: nothing left to forget, the kept stores untouched.
    const again = await untilDone(user, cutoff, 1);
    assert.equal(again.done, true, "Meta asking again after done is answered as done");
    assert.deepEqual(again.forgot, []);
    assert.equal(kept.filter((s) => redis.run(["EXISTS", connKey(s)]) === 1).length, keptCount);
  });
}

test("Meta: a later notice walks its own round: it forgets stores the earlier one kept", async () => {
  redis.clear();
  const user = "10150000000009001";
  const now = Date.now();
  const kept = ids(70, "kb");
  for (const s of kept) seed(user, s, now);
  const first = await untilDone(user, now - 60_000, 2);
  assert.equal(first.done, true);
  assert.deepEqual(first.forgot, []);
  const later = await untilDone(user, now + 60_000, 2);
  assert.equal(later.done, true, "the later notice is answered as done");
  assert.deepEqual(later.forgot.sort(), kept, "every store the earlier notice kept is forgotten by the later one");
  assert.equal(redis.run(["EXISTS", userKey(user)]), 0, "the index is gone");
});

test("Meta, rule 24: an unknown place, or a place not written, is never answered as done", async () => {
  for (const fail of ["GET", "SET"] as const) {
    redis.clear();
    const user = `1015000000000900${fail === "GET" ? 2 : 3}`;
    const now = Date.now();
    for (const s of ids(55, "kc")) seed(user, s, now);
    seed(user, "zz-old", now - 3_600_000);
    // The place's command is not run and its reply is unknown: an odd shape for the read, no answer for the write.
    const hit = (command: Command) => command[0] === fail && String(command[1]).startsWith("nl:metaads:forget:");
    redis.pipeline = async (commands: Command[]) => {
      const replies = await real(commands.filter((command) => !hit(command)));
      let next = 0;
      return commands.map((command) => (hit(command) ? (fail === "GET" ? 7 : null) : replies[next++]));
    };
    try {
      await assert.rejects(() => forgetMetaUser(user, now - 60_000), `an unknown ${fail} of the place is not done`);
      await assert.rejects(() => forgetMetaUser(user, now - 60_000), `an unknown ${fail} of the place is still not done`);
    } finally {
      redis.pipeline = real;
    }
    const out = await untilDone(user, now - 60_000, 3);
    assert.equal(out.done, true, "once the replies are known again it finishes");
    assert.equal(redis.run(["EXISTS", connKey("zz-old")]), 0);
  }
});
