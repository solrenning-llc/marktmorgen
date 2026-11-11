/**
 * 567 [GD1] (f), unit 1: a creator blocks a person in their own store's
 * messages (lib/buyer-block.ts). The chat, a question the store assistant
 * hands over and the contact form refuse a blocked person, and refuse when
 * the list cannot be read; a buyer's report of a problem with an order and
 * the withdrawal notice still reach the creator; only an HMAC of the address
 * is kept, per store; the studio's inbox route blocks, says why and unblocks;
 * deleting the person removes their entry. Synthetic stores, in-memory Redis.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, setContact, setInboxSetting, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { BLOCK_ENTRY_BYTES, BLOCK_REASON_MAX, MAX_BLOCKED, blockKey, blockPerson, blockedState, forgetBlockedPerson, mayWrite, personMark, unblockPerson } from "@/lib/buyer-block";
import { fileContact, handOver, readInbox, startChat, visitorSend } from "@/lib/inbox";
import { sendContact } from "@/lib/store-contact";
import { dataUsed } from "@/lib/store-data";
import { POST as inboxRoute } from "@/app/api/store/inbox/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_inbox_only_a_stand_in";
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000000" }), { status: 200 })) as typeof fetch;

const OWNER = "mara@example.com";
const OTHER = "lee@example.com";
const RUDE = "rude@example.com";
const KIND = "kind@example.com";

async function shop(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, `${handle} shop`, "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await setInboxSetting(owner, { chat: true, saved: [] });
  return (await storeForEmail(owner))!;
}

const route = async (owner: string, body: Record<string, unknown>) => {
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const response = await inboxRoute(new NextRequest("https://marktmorgen.com/api/store/inbox", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

async function main(): Promise<void> {
  redis.clear();
  const store = await shop(OWNER, "mara");
  const other = await shop(OTHER, "lee");

  part("Nobody blocked");
  is("a store with no list blocks nobody", await blockedState(store, RUDE), { blocked: false });
  is("so a chat starts", (await startChat({ store, email: RUDE, name: "", text: "Hello there", ip: "10.0.0.1" })).ok, true);

  part("The studio blocks the person of a conversation");
  const [conversation] = await readInbox(store.statsId!);
  const before = (await dataUsed(store))?.used ?? 0;
  const blocked = await route(OWNER, { action: "block", id: conversation.id, reason: "Insults in every message.\nAgain." });
  is("blocked", blocked, { status: 200, body: { ok: true, blocked: true } });
  is("its room counted in the store's data room", ((await dataUsed(store))?.used ?? 0) - before, BLOCK_ENTRY_BYTES);
  const said = await route(OWNER, { action: "blocked", id: conversation.id });
  is("the studio is told why, in one line", [said.status, said.body.blocked, said.body.reason], [200, true, "Insults in every message. Again."]);
  is("blocking twice is the same", (await route(OWNER, { action: "block", id: conversation.id, reason: "x" })).body, { ok: true, blocked: true });
  is("an unknown conversation", (await route(OWNER, { action: "block", id: "zzzzzzzzzzzz" })).status, 404);

  part("Only an HMAC of the address is kept, in this store alone");
  const raw = JSON.stringify(await redis.pipeline([["HGETALL", blockKey(store.sid!)]]));
  is("not the address", raw.includes("rude"), false);
  is("its HMAC", raw.includes(personMark(RUDE)!), true);
  is("the same in any case and spacing", personMark(" Rude@Example.COM "), personMark(RUDE));
  is("another store does not block them", await blockedState(other, RUDE), { blocked: false });

  part("What a blocked person can no longer do");
  is("start a chat", await startChat({ store, email: "RUDE@example.com", name: "", text: "Hello again", ip: "10.0.0.2" }), { ok: false, reason: "closed" });
  is("hand a question over through the assistant", await handOver({ store, email: RUDE, name: "", text: "Why no answer?" }), { ok: false, reason: "closed" });
  const [kept] = await redis.pipeline([["GET", `nl:inbox:${store.statsId}:c:${conversation.id}`]]);
  const token = (JSON.parse(String(kept)) as { token: string }).token;
  is("write again in the chat they had", await visitorSend(token, "Still here", async () => store), { ok: false, reason: "closed" });
  await setContact(OWNER, { on: true, heading: "Contact", line: "" });
  const contactStore = (await storeForEmail(OWNER))!;
  is("use the contact form", await sendContact({ store: contactStore, name: "R", email: RUDE, message: "Answer me now please", ip: "10.0.0.3" }), "closed");
  is("someone else still can", (await startChat({ store, email: KIND, name: "", text: "Hello there", ip: "10.0.0.4" })).ok, true);

  part("What is never stopped: the buyer's protections");
  is("the withdrawal notice and the order-problem report are filed (fileContact and fileOrderProblem do not read the list)", await fileContact({ store, email: RUDE, name: "", text: "I withdraw from order cs_test_x." }), true);

  part("The list cannot be read: nobody is let in");
  const realPipeline = redis.pipeline.bind(redis);
  (redis as { pipeline: typeof redis.pipeline }).pipeline = async (commands) => (commands.some((c) => c[0] === "EXISTS" && String(c[1]).startsWith("nl:blk:")) ? [{ odd: true }, null] : realPipeline(commands));
  is("unknown", await blockedState(store, KIND), "unknown");
  is("so no message", await mayWrite(store, KIND), false);
  is("the studio is told it is not known", (await route(OWNER, { action: "blocked", id: conversation.id })).status, 503);
  (redis as { pipeline: typeof redis.pipeline }).pipeline = realPipeline;

  part("Unblocking");
  is("unblocked", (await route(OWNER, { action: "unblock", id: conversation.id })).body, { ok: true, blocked: false });
  is("their room given back", (await dataUsed(store))?.used ?? 0, before);
  is("they may write again", await mayWrite(store, RUDE), true);
  is("unblocking someone not blocked", await unblockPerson(store, RUDE), false);

  part("Limits");
  is("a reason is at most BLOCK_REASON_MAX characters", (await blockPerson(store, "long@example.com", "y".repeat(500)), (await blockedState(store, "long@example.com")) as { reason?: string }).reason?.length, BLOCK_REASON_MAX);
  for (let i = 0; i < MAX_BLOCKED - 1; i++) await redis.pipeline([["HSET", blockKey(store.sid!), `fill${i}`, JSON.stringify({ r: "", at: 1 })]]);
  is("at most MAX_BLOCKED a store", await blockPerson(store, "one-more@example.com", ""), "many");

  part("Deleting the person");
  await redis.pipeline([["DEL", blockKey(store.sid!)]]);
  await blockPerson(store, RUDE, "");
  is("their entry is removed", [await forgetBlockedPerson(store, RUDE), await blockedState(store, RUDE)], [1, { blocked: false }]);
  is("nothing left to remove", await forgetBlockedPerson(store, RUDE), 0);

  done();
}

main();
