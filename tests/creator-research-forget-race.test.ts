/**
 * An answer to the creator research form sent while, or just after, its address's answers are being deleted never
 * outlives the deletion (Codex L-20261120-0837, #5010 row 41). forgetResearchPerson (lib/creator-research-store.ts)
 * sets a mark under a hash of the address before its first walk and lifts it only once a walk found none of theirs;
 * KEEP_RESEARCH_ANSWER (lib/creator-research-room.ts) reads the mark in the same step as the write, so the form keeps
 * nothing from the address while it stands (the route answers 409 "forgetting"). A deletion that did not end confirmed
 * leaves the mark to expire (FORGET_MARK_SECONDS), and the next walk sets it again.
 * Synthetic answers only; no external request.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/creators/route";
import { KEEP_RESEARCH_ANSWER, RESEARCH_ANSWERS_PER_DAY, RESEARCH_DAY_SHARE, RESEARCH_MAX_ANSWERS, RESEARCH_RESERVED, researchAccountMark } from "@/lib/creator-research-room";
import { FORGET_MARK_SECONDS, RESPONSES_KEY, ResearchForgetIncomplete, forgetMarkKey, forgetResearchPerson } from "@/lib/creator-research-store";
import { store } from "./redis-stub";

const pipeline = store.pipeline.bind(store);
type Command = (string | number)[];
globalThis.fetch = (async () => { throw new Error("Unexpected external request"); }) as typeof fetch;
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

let made = 0;
function answer(email: string): string {
  made += 1;
  return JSON.stringify({ id: `synthetic-${made}`, createdAt: "2026-11-01T00:00:00.000Z", name: `Synthetic ${made}`, email, country: "US", problem: "Synthetic" });
}
/**
 * The form's write, as the route sends it (research-answer-keep:v4): the list, the typed address's mark and the
 * signed-in account's (the address's again when anonymous), the ceiling, the row, the day's count and caps, the
 * account's reserve mark and the row without it, in one step.
 */
const keep = async (email: string, row: string, account?: string) => {
  const mark = account ? await researchAccountMark(account) : "";
  const kept = mark ? JSON.stringify({ ...(JSON.parse(row) as object), reservedFor: mark }) : row;
  return (await pipeline([["EVAL", KEEP_RESEARCH_ANSWER, 3, RESPONSES_KEY, forgetMarkKey(email), forgetMarkKey(account ?? email), RESEARCH_MAX_ANSWERS, kept, 1, RESEARCH_DAY_SHARE, RESEARCH_ANSWERS_PER_DAY, RESEARCH_RESERVED, mark, row]]))[0];
};
const list = async () => ((await pipeline([["LRANGE", RESPONSES_KEY, 0, -1]])) as string[][])[0];
const theirs = async (email: string) => (await list()).filter((row) => (JSON.parse(row) as { email: string }).email === email);
const marked = async (email: string) => Number((await pipeline([["EXISTS", forgetMarkKey(email)]]))[0]);
const fresh = async () => { await pipeline([["DEL", RESPONSES_KEY, forgetMarkKey("ana@example.com"), forgetMarkKey("bo@example.com"), forgetMarkKey("cy@example.com")]]); };

test("control: with no deletion under way the form keeps the answer, the list's new length answered", async () => {
  await fresh();
  assert.equal(await keep("ana@example.com", answer("ana@example.com")), 1);
  assert.equal((await theirs("ana@example.com")).length, 1);
});

test("an answer sent after the deletion's last walk found none, and before it returned, is refused and never kept", async () => {
  await fresh();
  await pipeline([["LPUSH", RESPONSES_KEY, answer("ana@example.com")]]);
  let late: unknown = "not sent";
  let bo: unknown = "not sent";
  store.pipeline = async (batch) => {
    const reply = await pipeline(batch);
    // The walk that finds none of theirs: the moment an answer could slip in behind the deletion.
    if (batch[0][0] === "LRANGE" && batch[0][1] === RESPONSES_KEY && late === "not sent") {
      const rows = (reply as string[][])[0] ?? [];
      if (!rows.some((row) => (JSON.parse(row) as { email: string }).email === "ana@example.com")) {
        late = await keep("ana@example.com", answer("ana@example.com"));
        bo = await keep("bo@example.com", answer("bo@example.com"));
      }
    }
    return reply;
  };
  try {
    assert.equal(await forgetResearchPerson("ana@example.com"), 1);
  } finally {
    store.pipeline = pipeline;
  }
  assert.equal(late, -1, "the address's answer sent during the deletion is refused by the write's own check");
  assert.equal(bo, 1, "another address's answer sent at the same moment is kept (the list's new length: theirs already gone)");
  assert.deepEqual(await theirs("ana@example.com"), [], "none of theirs is left once the deletion returned");
  assert.equal(await marked("ana@example.com"), 0, "the mark lifted with the deletion done");
  assert.equal(await keep("ana@example.com", answer("ana@example.com")), 2, "after it, the address may answer again");
});

test("a signed-in account whose answers are being deleted keeps no new answer in its reserved place, whatever address it types", async () => {
  await fresh();
  // The account's answers are theirs by its reserve mark (lib/creator-research-store.ts isTheirs), so its deletion's
  // mark closes the form to the account too, not only to the address it typed.
  await pipeline([["SET", forgetMarkKey("cy@example.com"), "1", "EX", FORGET_MARK_SECONDS]]);
  assert.equal(await keep("other@example.com", answer("other@example.com"), "cy@example.com"), -1, "refused while the account's deletion runs");
  assert.equal(await keep("other@example.com", answer("other@example.com")), 1, "the same address, not signed in as that account, is kept");
  await pipeline([["DEL", forgetMarkKey("cy@example.com")]]);
  assert.equal(await keep("other@example.com", answer("other@example.com"), "cy@example.com"), 2, "after the deletion, the account answers again");
});

test("a deletion that did not end confirmed leaves the mark, so the form stays closed to the address until it expires", async () => {
  await fresh();
  await pipeline([["LPUSH", RESPONSES_KEY, answer("ana@example.com")]]);
  store.pipeline = async (batch) => (batch[0][0] === "LREM" ? [1] : pipeline(batch)); // Says removed, never removes.
  let outcome: unknown = null;
  try {
    await forgetResearchPerson("ana@example.com");
  } catch (error) {
    outcome = error;
  } finally {
    store.pipeline = pipeline;
  }
  assert.ok(outcome instanceof ResearchForgetIncomplete, "not a finished deletion");
  assert.equal(await marked("ana@example.com"), 1, "the mark stands");
  const ttl = Number((await pipeline([["TTL", forgetMarkKey("ana@example.com")]]))[0]);
  assert.ok(ttl > 0 && ttl <= FORGET_MARK_SECONDS, "for FORGET_MARK_SECONDS at the most");
  assert.equal(await keep("ana@example.com", answer("ana@example.com")), -1, "and the form keeps nothing from the address meanwhile");
});

test("the route says so: 409 \"forgetting\" while the mark stands, 201 once it is gone", async () => {
  await fresh();
  const payload = { name: "Synthetic Creator", email: "ana@example.com", platform: "Other", country: "Test country", problem: "A synthetic research answer for a regression test.", link: "", tools: "", cost: "", consentResearch: true, consentFollowUp: false, consentUpdates: false, website: "" };
  const ask = (ip: string) => POST(new NextRequest("https://marktmorgen.com/api/creators", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://marktmorgen.com", Host: "marktmorgen.com", "x-forwarded-for": ip }, body: JSON.stringify(payload) }));
  await pipeline([["SET", forgetMarkKey("ana@example.com"), "1", "EX", FORGET_MARK_SECONDS]]);
  const refused = await ask("192.0.2.41");
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { ok: false, error: "forgetting" });
  assert.deepEqual(await theirs("ana@example.com"), [], "nothing kept");
  await pipeline([["DEL", forgetMarkKey("ana@example.com")]]);
  const kept = await ask("192.0.2.42");
  assert.equal(kept.status, 201);
  assert.equal((await theirs("ana@example.com")).length, 1);
});
