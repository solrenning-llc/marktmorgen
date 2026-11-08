/**
 * A teammate's visit is never counted as a buyer's on a read that is not
 * known (rule 24; Claude 6's alert audit, LEVE on lib/visit.ts isOwner).
 *
 * Before: the team was read with `readTeam(...).catch(() => null)` and
 * parseTeam, so a Redis error, a missing reply or a reply in another shape
 * read as "nobody on the team", and a signed-in teammate's view, checkout,
 * visit or affiliate click was counted as a buyer's. The signed-in session
 * was read the same way. After: no team record is no team (a stranger still
 * counts); anything else unknown skips that count, logged, never counted as
 * a buyer's. The agreement page, which uses the same reading as a gate, says
 * it could not be done instead of letting the store's own people sign.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as visit from "@/lib/visit";
import { countHit, isStorePeople } from "@/lib/visit";
import { readStats } from "@/lib/stats";
import { SESSION_COOKIE, openSession, sessionKeyOf } from "@/lib/auth";
import { claimHandle, ensureStatsId, storeForEmail, type Store } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";

const OWNER = "synthetic-owner@example.com";
const MEMBER = "synthetic-helper@example.com";
const STRANGER = "synthetic-stranger@example.com";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

globalThis.fetch = (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

function asking(cookies: Record<string, string> = {}): never {
  const request = new Request("https://marktmorgen.com/api/store/hit", { method: "POST", headers: { "user-agent": PHONE, "x-forwarded-for": "203.0.113.9", "x-vercel-ip-country": "US" } });
  (request as unknown as { cookies: unknown }).cookies = { get: (name: string) => (cookies[name] ? { value: cookies[name] } : undefined) };
  return request as never;
}

type Setup = { store: Store; member: string; stranger: string; teamKey: string };
redis.clear();
const setup: Promise<Setup> = (async () => {
  await claimHandle(OWNER, "synthetic-harbor", "Synthetic Harbor", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const teamKey = `nl:team:${store.sid}`;
  await redisPipeline([["SET", teamKey, JSON.stringify({ members: [{ email: MEMBER, role: "editor", joinedAt: new Date().toISOString() }], invites: [] })]]);
  return { store, member: await openSession(MEMBER), stranger: await openSession(STRANGER), teamKey };
})();

const views = async (store: Store) => (await readStats(store))!.days.at(-1)!.views;

/** Answers a one-command GET of `key` with `reply` (or throws), and passes everything else through. */
async function withReplyFor<T>(key: string, reply: unknown[] | Error, work: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === key) {
      if (reply instanceof Error) throw reply;
      return [...reply];
    }
    return original.call(redis, commands);
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

const UNKNOWN_TEAM: [string, unknown[] | Error][] = [
  ["a Redis error", new Error("synthetic outage")],
  ["no reply at all", []],
  ["a number", [7]],
  ["a list", [["members"]]],
  ["text that is not a team record", ["not json"]],
  ["a record without its members", [JSON.stringify({ invites: [] })]],
];

test("controls: a buyer and a signed-in stranger count; a teammate and no-team are read as they are", async () => {
  const { store, member, stranger, teamKey } = await setup;
  const before = await views(store);
  await countHit(asking(), store, { kind: "view" });
  await countHit(asking({ [SESSION_COOKIE]: stranger }), store, { kind: "view" });
  await countHit(asking({ [SESSION_COOKIE]: member }), store, { kind: "view" });
  assert.equal((await views(store)) - before, 2);
  assert.equal(await isStorePeople(asking({ [SESSION_COOKIE]: member }), store), true);
  assert.equal(await isStorePeople(asking({ [SESSION_COOKIE]: stranger }), store), false);
  // No team record at all is confirmed: nobody is on the team, and a signed-in stranger still counts.
  const absent = await withReplyFor(teamKey, [null], async () => {
    const at = await views(store);
    await countHit(asking({ [SESSION_COOKIE]: stranger }), store, { kind: "view" });
    return [(await views(store)) - at, await isStorePeople(asking({ [SESSION_COOKIE]: stranger }), store)];
  });
  assert.deepEqual(absent, [1, false]);
});

for (const [label, reply] of UNKNOWN_TEAM) {
  test(`a teammate's view is not counted as a buyer's when the team read is ${label}`, async () => {
    const { store, member, teamKey } = await setup;
    const before = await views(store);
    const people = await withReplyFor(teamKey, reply, async () => {
      await countHit(asking({ [SESSION_COOKIE]: member }), store, { kind: "view" });
      return isStorePeople(asking({ [SESSION_COOKIE]: member }), store);
    });
    assert.equal((await views(store)) - before, 0, "no buyer view counted");
    assert.equal(people, true, "an unknown team is never \"not the store's people\" for a count");
  });
}

test("the exact reading, for a gate: a teammate yes, a stranger no, an unknown team throws", async () => {
  const { store, member, stranger, teamKey } = await setup;
  const exact = (visit as { isStorePeopleExact?: typeof visit.isStorePeople }).isStorePeopleExact;
  assert.equal(typeof exact, "function");
  assert.equal(await exact!(asking({ [SESSION_COOKIE]: member }), store), true);
  assert.equal(await exact!(asking({ [SESSION_COOKIE]: stranger }), store), false);
  assert.equal(await withReplyFor(teamKey, [null], () => exact!(asking({ [SESSION_COOKIE]: stranger }), store)), false);
  for (const [, reply] of UNKNOWN_TEAM) {
    await withReplyFor(teamKey, reply, () => assert.rejects(() => exact!(asking({ [SESSION_COOKIE]: member }), store)));
  }
});

test("a signed-in visit whose session cannot be read is not counted as a buyer's", async () => {
  const { store, member } = await setup;
  const key = await sessionKeyOf(member);
  const before = await views(store);
  const people = await withReplyFor(key, new Error("synthetic outage"), async () => {
    await countHit(asking({ [SESSION_COOKIE]: member }), store, { kind: "view" });
    return isStorePeople(asking({ [SESSION_COOKIE]: member }), store);
  });
  assert.equal((await views(store)) - before, 0);
  assert.equal(people, true);
});

test("the agreement page says it could not be done on an unknown team, never lets the store's people sign", async () => {
  const { readFileSync } = await import("node:fs");
  const route = readFileSync("app/api/store/agreement-sign/route.ts", "utf8");
  assert.match(route, /isStorePeopleExact\(request, store\)/);
  assert.match(route, /catch[\s\S]{0,200}back\("error"\)/);
  assert.doesNotMatch(route, /await isStorePeople\(request, store\)/);
});
