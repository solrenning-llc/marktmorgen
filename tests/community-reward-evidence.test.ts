import { earnedCourses, saveRewards } from "@/lib/community-points";
import { addProduct, claimHandle, setCommunity, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { memberKey, touchMember } from "@/lib/community";
import { paidCourses } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main() {
  const id = "a".repeat(32), member = "b".repeat(32), product = "course123";
  const now = 1_800_000_000_000;
  const rewards = JSON.stringify([{ level: 2, product }]);
  const active = JSON.stringify({ k: member, removed: false });
  const original = redis.pipeline.bind(redis);
  let writes = 0;
  let read: unknown[] = [];
  let ack: unknown[] = [1];
  redis.pipeline = async (commands) => {
    if (commands.length === 4 && commands[0][0] === "GET" && commands[1][0] === "ZSCORE") return read as never;
    writes += commands.length;
    return ack as never;
  };
  async function run(input: unknown[], answer: unknown[] = [1], at = now, grant = true) {
    read = input; ack = answer; writes = 0;
    try { return await earnedCourses(id, member, at, grant); }
    catch { return new Map<string, number>(); }
  }
  try {
    part("Only confirmed reward evidence creates course access");
    is("a confirmed new grant has its real start", [...await run([rewards, "5", active, []])], [[product, now / 1000]]);
    is("one write for the new reward", writes, 1);
    for (const score of [undefined, true, [5], { valueOf: () => 5 }, NaN, Infinity, "Infinity", 5.5, "5.5", -1, Number.MAX_SAFE_INTEGER + 1, "9007199254740992"]) {
      const got = await run([rewards, score, active, []]);
      is(`invalid score ${String(score)} grants and writes nothing`, [got.size, writes], [0, 0]);
    }
    for (const record of [undefined, null, "{}", "[]", "42", '"member"', "null", JSON.stringify({ k: member }), JSON.stringify({ k: member, removed: "false" }), JSON.stringify({ k: "c".repeat(32), removed: false }), JSON.stringify({ k: member, removed: true })]) {
      const got = await run([rewards, 5, record, []]);
      is(`invalid membership ${String(record)} grants and writes nothing`, [got.size, writes], [0, 0]);
    }
    for (const held of [undefined, null, {}, [product], [product, "0"], [product, "bad"], [product, "1", product, "2"], ["bad/key", "1"]]) {
      const got = await run([rewards, 5, active, held]);
      is(`unconfirmed retained grants ${String(held)} cannot create access`, [got.size, writes], [0, 0]);
    }
    for (const envelope of [[rewards, 5, active], [rewards, 5, active, [], "extra"]]) {
      const got = await run(envelope);
      is("a partial or surplus read envelope never grants", [got.size, writes], [0, 0]);
    }
    for (const config of [[{ level: 2, product }], JSON.stringify([{ level: 2, product }, { level: 2, product: "other123" }]), JSON.stringify([{ level: 2, product }, {}])]) {
      const got = await run([config, 5, active, []]);
      is("an unconfirmed reward configuration cannot partly grant", [got.size, writes], [0, 0]);
    }
    part("A grant is not confirmed by merely attempting HSETNX");
    for (const answer of [[], [null], [undefined], [true], ["1"], [2], [1, 1], [0]]) {
      const got = await run([rewards, 5, active, []], answer);
      is(`unconfirmed or concurrent grant ${String(answer)} is not invented`, [got.size, writes], [0, 1]);
    }
    const two = JSON.stringify([{ level: 2, product }, { level: 3, product: "second123" }]);
    is("a partial grant batch exposes neither attempted grant", (await run([two, 20, active, []], [1])).size, 0);
    is("a malformed answer in a complete batch exposes neither attempted grant", (await run([two, 20, active, []], [1, null])).size, 0);
    is("mixed new and concurrent acknowledgements expose only this writer's grant", [...await run([two, 20, active, []], [1, 0])], [[product, now / 1000]]);
    const held = [product, "123"];
    is("a retained reward keeps its original date despite lost points", [...await run([rewards, null, active, held])], [[product, 123]]);
    is("a corrupt current score never erases a confirmed previous reward", [...await run([rewards, Infinity, active, held])], [[product, 123]]);
    is("an off community keeps previous rewards without new writes", [[...await run([rewards, 5, active, held], [1], now, false)], writes], [[[product, 123]], 0]);
    is("an invalid clock cannot write a new grant", [(await run([rewards, 5, active, []], [1], NaN)).size, writes], [0, 0]);
  } finally { redis.pipeline = original; }

  part("Two real writers never replace the winner's course start date");
  redis.clear();
  await original([["SET", `nl:cm:${id}:rw`, rewards], ["ZADD", `nl:cm:${id}:pts`, 5, member], ["HSET", `nl:cm:${id}:m`, member, active]]);
  let readers = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  redis.pipeline = async (commands) => {
    const answer = await original(commands);
    if (commands.length === 4 && commands[1][0] === "ZSCORE") {
      readers += 1;
      if (readers === 2) release();
      if (readers <= 2) await barrier;
    }
    return answer;
  };
  try {
    const raced = await Promise.all([earnedCourses(id, member, now), earnedCourses(id, member, now + 10_000)]);
    const [stored] = await original([["HGET", `nl:cm:${id}:unl:${member}`, product]]);
    is("one newly confirmed grant, one deferred concurrent grant", raced.map((r) => r.size).sort(), [0, 1]);
    is("the confirmed writer returns the actual stored date", raced.find((r) => r.size)?.get(product), Number(stored));
    is("a later ordinary read retains that date", (await earnedCourses(id, member, now + 20_000)).get(product), Number(stored));
  } finally { redis.pipeline = original; }

  part("The actual paid-course reader does not bypass reward evidence");
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_points_only_a_stand_in";
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;
  const owner = "reward-owner@example.com", email = "reward-member@example.com";
  await claimHandle(owner, "rewardproof", "Reward proof", "");
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  const community = await setCommunity(owner, true);
  const communityId = community!.community!.id;
  const made = await addProduct(owner, "A reward course", "", "49");
  if (!made.ok) throw Error("synthetic product setup failed");
  await setProductCourse(owner, made.product.id, { id: "c".repeat(32), lessons: 1 });
  await saveRewards(communityId, [{ level: 2, product: made.product.id }]);
  await touchMember(communityId, email, null, { sid: "reward-proof" });
  const key = memberKey(email), store = (await storeForEmail(owner))!;
  await original([["ZADD", `nl:cm:${communityId}:pts`, 5, key]]);
  let mode: "bad-member" | "bad-ack" | "normal" = "bad-member";
  let grantAttempts = 0;
  redis.pipeline = async (commands) => {
    const result = await original(commands);
    if (commands.length === 4 && commands[1][0] === "ZSCORE" && mode === "bad-member") {
      const changed = [...result]; changed[2] = "[]"; return changed;
    }
    if (mode === "bad-ack" && commands[0]?.[0] === "EVAL" && String(commands[0][1]).includes("order-write")) {
      grantAttempts += 1;
      const reply = result[0];
      if (Array.isArray(reply) && reply.length === 2) return [[reply[0], null]] as never;
    }
    return result;
  };
  try {
    is("malformed membership cannot open a paid course through paidCourses", (await paidCourses(store, email)).has(made.product.id), false);
    await original([["DEL", `nl:cm:${communityId}:unl:${key}`]]);
    mode = "bad-ack";
    is("applied write with an unconfirmed ACK does not open a course on that call", (await paidCourses(store, email)).has(made.product.id), false);
    is("the real charged grant path was exercised", grantAttempts > 0, true);
    mode = "normal";
    is("a later confirmed read recovers the real grant without another start date", (await paidCourses(store, email)).has(made.product.id), true);
  } finally { redis.pipeline = original; }
  done();
}
void main();
