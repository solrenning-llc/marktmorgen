/**
 * A conversation's messages (lib/inbox.ts) are read exactly (CX-123 rule 24): the visitor's chat (visitorThread) and the
 * studio's conversation (openConversation) read the list in its own shape. A reply out of shape is unknown and throws,
 * so the page says it could not load, never an empty conversation, as if nothing had been written.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openConversation, readInbox, startChat, visitorThread } from "@/lib/inbox";
import { claimHandle, ensureStatsId, setInboxSetting, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_inbox_exact_stand_in";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

const OWNER = "inbox-exact@example.com";

async function fixture() {
  redis.clear();
  await claimHandle(OWNER, "inboxexact", "Inbox Exact", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_InboxExact01", subscriptionId: "sub_InboxExact01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  assert.ok((await setInboxSetting(OWNER, { chat: true, saved: [] })).ok);
  const store = (await storeForEmail(OWNER))!;
  const started = await startChat({ store, email: "ana@example.com", name: "Ana", text: "How many lessons does the course have?", ip: "10.0.0.9" });
  assert.ok(started.ok);
  const [conversation] = await readInbox(store.statsId);
  return { store, token: started.thread.token, id: conversation.id };
}

async function withOddList<T>(run: () => Promise<T>): Promise<T | Error> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (batch) => {
    const replies = (await original(batch)) as unknown[];
    return batch.map((c, i) => (c[0] === "LRANGE" ? "OK" : replies[i])) as never;
  };
  try { return await run(); } catch (error) { return error as Error; } finally { redis.pipeline = original; }
}

test("control: the visitor and the studio read the conversation's message", async () => {
  const { store, token, id } = await fixture();
  assert.equal((await visitorThread(token))?.messages.length, 1);
  assert.equal((await openConversation(store.statsId!, id))?.messages.length, 1);
});

test("the visitor's chat: a list out of shape is unknown, never an empty conversation", async () => {
  const { token } = await fixture();
  const seen = await withOddList(() => visitorThread(token));
  assert.ok(seen instanceof Error, `shown as ${JSON.stringify(seen)}`);
});

test("the studio's conversation: a list out of shape is unknown, never an empty conversation", async () => {
  const { store, id } = await fixture();
  const seen = await withOddList(() => openConversation(store.statsId!, id));
  assert.ok(seen instanceof Error, `shown as ${JSON.stringify(seen)}`);
});
