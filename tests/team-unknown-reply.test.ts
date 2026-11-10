/**
 * CX-123 rule 24 (Claude 6, sweep of lib/[s-z]*.ts; proof tests/team-unknown-reply.proof.ts on PR #2943):
 * lib/team.ts read the team record and the activity log in an unknown reply shape as an empty team and
 * an empty log. Each of those decides access, a write, a deletion or a sweep:
 *   1. teamTwoStepBlocks let a member in without the owner's required second step;
 *   2. inviteMember wrote the team back with no members and the requirement off;
 *   3. memberStores took the store off the member's index (SREM) for good;
 *   4. readLog said "never removed before", so a repeated removal did not sweep the API keys again;
 *   5. lib/api-keys.ts read the team through parseTeam the same way (rule 30), so an owner-made key
 *      opened the store with the team's rule read as off.
 * Now only null is "no team" or "no log"; any other shape throws UnknownReplyError, and what depends
 * on it refuses: entry is not let through, nothing is written or removed, and the route answers 503.
 * Synthetic records only: the in-memory Redis stand-in with one reply changed, and no email leaves.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as teamRoute } from "@/app/api/store/team/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { makeKey, resolveKey } from "@/lib/api-keys";
import { inviteMember, memberStores, parseTeam, putMember, readLog, readTeam, setRequireTwoStep, teamTwoStepBlocks } from "@/lib/team";
import { claimHandle, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[] };
    sent.push(Array.isArray(body.to) ? String(body.to[0]) : String(body.to ?? ""));
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ORIGIN = "https://marktmorgen.com";
const OWNER = "owner-unknown-team@example.test";
const ANA = "ana-unknown-team@example.test";
const BEN = "ben-unknown-team@example.test";
const indexKey = (email: string) => `nl:team:of:${sha(`nimbus-team-of:${email}`).slice(0, 40)}`;

async function fixture(): Promise<Store> {
  redis.clear();
  sent.length = 0;
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "unknownteam", "Synthetic team shop", "");
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_unknownteam", subscriptionId: "sub_unknownteam", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  assert.ok(store.sid);
  assert.equal(await putMember(store, ANA, "editor"), true);
  assert.equal(await setRequireTwoStep(store, true, OWNER), true);
  return store;
}

/** Answers `shape` for one command on one key; every other command goes to the stand-in. */
async function withReply<T>(command: string, key: string, shape: unknown, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    const replies = await original(commands);
    return commands.map((c, i) => (c[0] === command && c[1] === key ? shape : replies[i]));
  };
  try { return await run(); } finally { redis.pipeline = original; }
}

/** The studio's Team route, as the owner's own session calls it. */
async function team(store: Store, body: unknown): Promise<{ status: number; body: { ok: boolean; error?: string; already?: boolean } }> {
  const session = await openSession(OWNER);
  const response = await teamRoute(
    new NextRequest(`${ORIGIN}/api/store/team?store=${store.sid}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN, host: "marktmorgen.com" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string; already?: boolean } };
}

const SHAPES: [string, unknown][] = [["a number", 7], ["a list", ["x"]], ["an object", { members: [] }], ["broken JSON", "{"]];

test("control: the real records answer as written", async () => {
  const store = await fixture();
  assert.equal(await teamTwoStepBlocks(store, ANA, "editor"), true);
  assert.deepEqual((await readTeam(store.sid)).members.map((m) => m.email), [ANA]);
  assert.equal((await readTeam(store.sid)).requireTwoStep, true);
  assert.deepEqual((await memberStores(ANA)).map((s) => s.store.sid), [store.sid]);
  assert.deepEqual((await readLog(store.sid)).map((line) => line.what), ["Required two-step sign-in for the team"]);
});

test("control: a store with no team record yet is an empty team, and no log is an empty log", async () => {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle("solo-unknown-team@example.test", "unknownsolo", "Synthetic solo shop", "");
  const solo = (await ensureStoreId("solo-unknown-team@example.test"))!;
  assert.deepEqual(await readTeam(solo.sid), { members: [], invites: [] });
  assert.deepEqual(await readLog(solo.sid), []);
  assert.equal(await teamTwoStepBlocks(solo, ANA, "editor"), false);
  assert.deepEqual(parseTeam(null), { members: [], invites: [] });
});

test("control: an invitation on a readable team is sent and keeps the team and its rule", async () => {
  const store = await fixture();
  const invited = await inviteMember(store, BEN, "support", ORIGIN);
  assert.equal(invited.ok, true);
  const after = await readTeam(store.sid);
  assert.deepEqual(after.members.map((m) => m.email), [ANA]);
  assert.deepEqual(after.invites.map((i) => i.email), [BEN]);
  assert.equal(after.requireTwoStep, true);
  assert.deepEqual(sent, [BEN]);
});

test("control: the owner removes a member, and pressing Remove again is known for a repeat", async () => {
  const store = await fixture();
  assert.deepEqual(await team(store, { action: "remove", email: ANA }), { status: 200, body: { ok: true } });
  assert.deepEqual((await readTeam(store.sid)).members, []);
  assert.deepEqual(await team(store, { action: "remove", email: ANA }), { status: 200, body: { ok: true, already: true } });
  assert.deepEqual(await team(store, { action: "remove", email: BEN }), { status: 404, body: { ok: false, error: "not_found" } });
});

for (const [label, shape] of SHAPES) {
  test(`access: a team record read as ${label} never lets a member past the required second step`, async () => {
    const store = await fixture();
    // Main's reading (0dd864a79): taken as requiring the step, so the step is asked for (true), never skipped.
    assert.equal(await withReply("GET", `nl:team:${store.sid}`, shape, () => teamTwoStepBlocks(store, ANA, "editor")), true);
  });

  test(`write: an invitation sent while the team reads as ${label} writes nothing and emails nobody`, async () => {
    const store = await fixture();
    await assert.rejects(() => withReply("GET", `nl:team:${store.sid}`, shape, () => inviteMember(store, BEN, "support", ORIGIN)), { name: "UnknownReplyError" });
    const after = await readTeam(store.sid);
    assert.deepEqual(after.members.map((m) => m.email), [ANA]);
    assert.deepEqual(after.invites, []);
    assert.equal(after.requireTwoStep, true);
    assert.deepEqual(sent, []);
  });

  test(`write: the Team route answers 503 for an invitation while the team reads as ${label}`, async () => {
    const store = await fixture();
    const answer = await withReply("GET", `nl:team:${store.sid}`, shape, () => team(store, { action: "invite", email: BEN, role: "support" }));
    assert.deepEqual(answer, { status: 503, body: { ok: false, error: "unread" } });
    assert.deepEqual((await readTeam(store.sid)).members.map((m) => m.email), [ANA]);
    assert.equal((await readTeam(store.sid)).requireTwoStep, true);
    assert.deepEqual(sent, []);
  });

  test(`deletion: a team record read as ${label} never takes the store off the member's index`, async () => {
    const store = await fixture();
    // Main's reading (0dd864a79): the store is left out of the member's list and kept in the index, neither "on it" nor "gone".
    assert.deepEqual(await withReply("GET", `nl:team:${store.sid}`, shape, () => memberStores(ANA)), []);
    const [members] = await redis.pipeline([["SMEMBERS", indexKey(ANA)]]);
    assert.deepEqual(members, [store.sid]);
  });

  test(`API keys (rule 30): a team record read as ${label} never opens the store with an owner's key`, async () => {
    const store = await fixture();
    const made = await makeKey(store.sid, "Owner key", Date.now(), false, "none", { owner: true, by: "", step: true });
    assert.equal(made.ok, true);
    const key = made.ok ? made.key : "";
    assert.equal((await resolveKey(key))?.paused, false);
    // Main's reading: the key is held paused for an unknown reason, read-only, never opened as the owner's.
    const held = await withReply("GET", `nl:team:${store.sid}`, shape, () => resolveKey(key));
    assert.deepEqual([held?.paused, held?.why, held?.write], [true, "unknown", false]);
  });
}

test("parseTeam: only null is no team; any other shape is unknown, never an empty team", () => {
  for (const raw of [undefined, 0, 7, true, ["x"], { members: [] }, "", "{", "{}", '{"members":[]}', '{"invites":[]}', "null", "[]", "7", '"team"', '{"members":5}', '{"invites":{}}', '{"members":[null]}', '{"members":["ana@example.test"]}', '{"invites":[7]}', '{"requireTwoStep":"yes"}']) {
    assert.throws(() => parseTeam(raw), { name: "UnknownReplyError" }, `parseTeam(${JSON.stringify(raw)})`);
  }
  // A record without both lists ("{}" among them) is unknown too: every team ever written carries both (Codex G on #2036).
  // The healthy shapes read as before: members and invitations the studio does not accept are left out.
  assert.deepEqual(parseTeam(JSON.stringify({ members: [], invites: [] })), { members: [], invites: [] });
  assert.deepEqual(
    parseTeam(JSON.stringify({ members: [{ email: "Ana@Example.test", role: "editor", joinedAt: "2026-11-01" }, { email: "not an address", role: "editor" }, { email: "cy@example.test", role: "king" }], invites: [], requireTwoStep: true })),
    { members: [{ email: "ana@example.test", role: "editor", joinedAt: "2026-11-01" }], invites: [], requireTwoStep: true },
  );
  assert.deepEqual(parseTeam(JSON.stringify({ members: [], invites: [], requireTwoStep: false })), { members: [], invites: [] });
});

for (const [label, shape] of [["a number", 3], ["an object", { 0: "x" }], ["a string", "rows"], ["a list holding a number", [7]]] as [string, unknown][]) {
  test(`removal repeat: the activity log read as ${label} is unknown, never "nobody was removed"`, async () => {
    const store = await fixture();
    await assert.rejects(() => withReply("LRANGE", `nl:team:log:${store.sid}`, shape, () => readLog(store.sid)), { name: "UnknownReplyError" });
  });

  test(`removal repeat: pressing Remove again while the log reads as ${label} answers 503, never "not on the team"`, async () => {
    const store = await fixture();
    assert.deepEqual(await team(store, { action: "remove", email: ANA }), { status: 200, body: { ok: true } });
    const answer = await withReply("LRANGE", `nl:team:log:${store.sid}`, shape, () => team(store, { action: "remove", email: ANA }));
    assert.deepEqual(answer, { status: 503, body: { ok: false, error: "unread" } });
  });

  test(`removal: a member still on the team is taken off, and swept, while the log reads as ${label}`, async () => {
    const store = await fixture();
    const answer = await withReply("LRANGE", `nl:team:log:${store.sid}`, shape, () => team(store, { action: "remove", email: ANA }));
    assert.deepEqual(answer, { status: 200, body: { ok: true } });
    assert.deepEqual((await readTeam(store.sid)).members, []);
    assert.equal((await readTeam(store.sid)).requireTwoStep, true);
  });
}
