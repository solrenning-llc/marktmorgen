/**
 * TEAM_INDEX_OFF_TEAM (lib/team.ts) against a real Redis (Codex L-20261119-0634, #5010 row 133): run by
 * tests/closed-store-redis-run.ts, which scripts/test_closed_store_redis.py builds with the real "@/lib/redis" in front
 * of a dedicated, empty Redis database. The in-memory stand-in (lib/redis-memory.ts) cannot show this defect: it reads
 * JSON with JavaScript, where an object is never an array, while Redis's cjson turns a JSON object and an array alike
 * into a Lua table. So the v1 script, which read the record again by a rule of its own, took a team whose members and
 * invites were objects (a shape parseTeam refuses) for a team without the person, and dropped a live store's id from
 * their index. Not a *.test.ts: npm test does not run it, the product checks' Redis job does.
 */
import { createHash } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { MEMBER_STORES_READ, memberStoresExact } from "@/lib/team";

type Is = (what: string, got: unknown, want: unknown) => void;

const X = "row133-person@example.com";
const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 40);
const indexKey = `nl:team:of:${sha(`nimbus-team-of:${X}`)}`;
const teamKey = (sid: string) => `nl:team:${sid}`;
const sidOf = (seed: string) => createHash("md5").update(`row133:${seed}`).digest("hex");

/**
 * The read past (memberStoresExact past MEMBER_STORES_READ ids) reads store S's team without X; then, before its
 * removal step runs, the record changes to `swapped`. S must stay in X's index whatever the record became.
 */
async function swappedBeforeRemoval(is: Is, label: string, swapped: string | null): Promise<void> {
  const s = sidOf(label);
  const others = Array.from({ length: MEMBER_STORES_READ + 1 }, (_, i) => sidOf(`${label}:${i}`));
  await redisPipeline([
    ["DEL", indexKey, teamKey(s), ...others.map(teamKey)],
    ["SET", teamKey(s), JSON.stringify({ members: [], invites: [] })],
    ["SADD", indexKey, s, ...others],
  ]);
  // The read past's removal is the one request that carries the script: the record changes just before it is sent.
  const realFetch = globalThis.fetch;
  let swappedIn = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!swappedIn && typeof init?.body === "string" && init.body.includes("marktmorgen:team-index-off-team")) {
      swappedIn = true;
      globalThis.fetch = realFetch;
      await redisPipeline([swapped === null ? ["DEL", teamKey(s)] : ["SET", teamKey(s), swapped]]);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  let read: string;
  try {
    read = await memberStoresExact(X, sidOf("closing")).then(() => "read", (error: unknown) => (error as Error).name);
  } finally {
    globalThis.fetch = realFetch;
  }
  const [kept] = (await redisPipeline([["SISMEMBER", indexKey, s]])) as unknown[];
  is(`row 133, ${label}: the read past reached its removal and stayed unknown`, [swappedIn, read], [true, "UnknownReplyError"]);
  is(`row 133, ${label}: S is still in X's index`, Number(kept), 1);
  await redisPipeline([["DEL", indexKey, teamKey(s), ...others.map(teamKey)]]);
}

export async function runTeamIndexShapeCheck(is: Is): Promise<void> {
  await swappedBeforeRemoval(is, "members and invites now JSON objects", JSON.stringify({ members: { 0: { email: X, role: "admin", joinedAt: "" } }, invites: {} }));
  await swappedBeforeRemoval(is, "a valid record that changed, still without X", JSON.stringify({ members: [{ email: "other@example.com", role: "admin", joinedAt: "" }], invites: [] }));
  // Control: an unchanged record still leaves, so the read past makes progress on a real Redis too.
  const s = sidOf("unchanged");
  const others = Array.from({ length: MEMBER_STORES_READ + 1 }, (_, i) => sidOf(`unchanged:${i}`));
  await redisPipeline([["DEL", indexKey], ["SET", teamKey(s), JSON.stringify({ members: [], invites: [] })], ["SADD", indexKey, s, ...others]]);
  const read = await memberStoresExact(X, sidOf("closing")).then(() => "read", (error: unknown) => (error as Error).name);
  const [kept] = (await redisPipeline([["SISMEMBER", indexKey, s]])) as unknown[];
  is("row 133, control: an unchanged team without X stays unknown this time", read, "UnknownReplyError");
  is("row 133, control: and S leaves X's index, so the next read gets further", Number(kept), 0);
  await redisPipeline([["DEL", indexKey, teamKey(s), ...others.map(teamKey)]]);
}
