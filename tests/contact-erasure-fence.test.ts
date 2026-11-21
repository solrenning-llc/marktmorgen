/**
 * A contact message or a chat admitted on an old Store cannot recreate a conversation, nor email the creator, once
 * the store's erasure has begun (Codex L-20261120-1945, MEDIUM, lib/store-contact.ts sendContact and lib/inbox.ts).
 *
 * sendContact and startChat admit a visitor on the Store they were handed, then wait on their limits. Meanwhile the
 * closing walk can write the store's erasing mark, delete its identity and empty its nl:inbox:<statsId>:* family. A
 * new conversation is written with expected = "", so INBOX_WRITE, which only checks that the record does not exist
 * yet, took the absence the erasure left as leave to write: the visitor's name, address and text came back, with the
 * chat token, after the erasure. The form also emailed the old address of the creator first.
 *
 * Checked with the real sendContact and startChat on the in-memory Redis, the closing write done either before the
 * request (an old Store) or just before the conversation's write; synthetic store and addresses, Resend stubbed.
 */
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, ownerKey, setContact, setInboxSetting, setSubscription, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { sendContact } from "@/lib/store-contact";
import { startChat } from "@/lib/inbox";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    sent.push(String((JSON.parse(String(init?.body)) as { to?: unknown }).to));
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

const OWNER = "owner@contact-fence.example";
const MESSAGE = "Hello! Could we work together on a cookbook for a magazine next spring?";
let ip = 0;

/** Every key of the store's inbox family that holds a conversation, its messages or a visitor's chat token. */
const inboxKeys = (statsId: string) => redis.keys().filter((key) => key.startsWith(`nl:inbox:${statsId}:c:`) || key.startsWith(`nl:inbox:${statsId}:m:`));

/** Runs `then` once, just before the first write of a new inbox conversation. */
function beforeInboxWrite(then: () => Promise<unknown>): () => void {
  const original = redis.pipeline.bind(redis);
  let fired = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!fired && commands.some((command) => command[0] === "EVAL" && /^-- marktmorgen:inbox-/.test(String(command[1])))) {
      fired = true;
      await then();
    }
    return original(commands);
  }) as typeof redis.pipeline;
  return () => { redis.pipeline = original; };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_contact_only";
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  await claimHandle(OWNER, "contactfence", "Contact Fence", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ContactFence1", subscriptionId: "sub_ContactFence1", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await setContact(OWNER, { on: true });
  await setInboxSetting(OWNER, { chat: true, saved: [] });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const ref = storeRef(store);
  const erasing = await erasingField(ref);
  const [, idKey] = storeIdCommand(store.sid);
  const idValue = String(redis.run(["GET", idKey]));
  const contact = (s = store) => sendContact({ store: s, name: "Dana", email: `dana${++ip}@example.com`, message: `${MESSAGE} ${ip}`, ip: `198.18.3.${ip}` });
  const chat = (s = store) => startChat({ store: s, name: "Eli", email: `eli${++ip}@example.com`, text: `${MESSAGE} ${ip}`, ip: `198.18.4.${ip}` });
  const startErasure = () => redis.pipeline([["HSET", ERASING_KEY, erasing, String(Date.now())]]);
  const endErasure = () => redis.pipeline([["HDEL", ERASING_KEY, erasing]]);

  part("A live store: the message is emailed and filed, the chat is kept");
  let mailed = sent.length;
  is("the contact message is sent", await contact(), "sent");
  is("one email to the creator", sent.length - mailed, 1);
  is("filed in the inbox", inboxKeys(statsId).length > 0, true);
  const chatted = await chat();
  is("the chat is started", chatted.ok, true);

  part("Erasing began before an old Store's contact message: no email, no conversation");
  // As the closing walk leaves it: the store's inbox family emptied (its identity is taken in the next parts).
  const clearInbox = () => redis.pipeline([["DEL", ...redis.keys().filter((key) => key.startsWith(`nl:inbox:${statsId}:`))]]);
  await clearInbox();
  await startErasure();
  mailed = sent.length;
  is("refused as closed", await contact(), "closed");
  is("no email to the creator's old address", sent.length - mailed, 0);
  is("no conversation is recreated", inboxKeys(statsId), []);
  await endErasure();

  part("Erasing begins just before the conversation's write: no conversation, for the form and the chat");
  let undo = beforeInboxWrite(startErasure);
  await contact();
  undo();
  is("the contact message recreates no conversation", inboxKeys(statsId), []);
  await endErasure();
  undo = beforeInboxWrite(startErasure);
  const late = await chat();
  undo();
  is("the chat is refused as closed", late.ok ? "ok" : late.reason, "closed");
  is("and recreates no conversation", inboxKeys(statsId), []);
  await endErasure();

  part("The store's identity is gone (its record closed) just before the write");
  undo = beforeInboxWrite(() => redis.pipeline([["DEL", idKey]]));
  const gone = await chat();
  undo();
  is("the chat is refused as closed", gone.ok ? "ok" : gone.reason, "closed");
  is("and recreates no conversation", inboxKeys(statsId), []);
  await redis.pipeline([["SET", idKey, idValue]]);

  part("A store from before ids: its owner's record must still be its own");
  const old = { ...store, sid: "", extra: false };
  const ownerRecord = await ownerKey(storeRef(old));
  const before = String(redis.run(["GET", ownerRecord]));
  undo = beforeInboxWrite(() => redis.pipeline([["SET", ownerRecord, JSON.stringify({ ...JSON.parse(before), statsId: "zzzzzzzzzzzz" })]]));
  const other = await chat(old);
  undo();
  is("a record that is now another store's refuses the chat", other.ok ? "ok" : other.reason, "closed");
  is("and recreates no conversation", inboxKeys(statsId), []);
  await redis.pipeline([["SET", ownerRecord, before]]);
  const kept = await chat(old);
  is("while its record is its own, the chat is kept", kept.ok, true);

  done();
}

main();
