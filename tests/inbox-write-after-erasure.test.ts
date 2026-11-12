/**
 * #4272: opening an unread conversation (lib/inbox.ts openConversation) marks it read with write(), from a record
 * read before the person's erasure; landing after forgetInboxPerson, it must not write the conversation (their
 * address and name), its inbox index entry or the visitor's old chat token back. The same writer serves replyTo,
 * setStatus and assignTo: on a conversation erased meanwhile they answer "none" and write nothing.
 * Synthetic only (the in-memory Redis stand-in; no provider, email or payment reached).
 */
import { assignTo, fileContact, forgetInboxPerson, openConversation, readInbox, replyTo, setStatus, tokenKey } from "@/lib/inbox";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "inbox-race-owner@example.com";
const PERSON = "inbox-race-person@example.com";

type Pipeline = typeof redis.pipeline;

/** Runs the person's erasure just before the first pipeline that would write `convKey`. */
function eraseBeforeWrite(statsId: string, convKey: string): { restore: () => void; erased: () => number } {
  const original = redis.pipeline.bind(redis);
  let erased = -1;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (erased < 0 && commands.some((c) => (c[0] === "SET" || c[0] === "EVAL") && c.includes(convKey))) {
      erased = await forgetInboxPerson(statsId, PERSON);
    }
    return original(commands);
  }) as Pipeline;
  return { restore: () => { redis.pipeline = original; }, erased: () => erased };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_4272_only_a_stand_in";
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;
  await claimHandle(OWNER, "inboxrace", "Inbox Race", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_4272", subscriptionId: "sub_4272", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;

  const file = async () => {
    is("(setup) the person's message is filed", await fileContact({ store, email: PERSON, name: "Ada Person", text: "Please call me back about my order." }), true);
    const conversation = (await readInbox(statsId)).find((c) => c.email === PERSON)!;
    const convKey = `nl:inbox:${statsId}:c:${conversation.id}`;
    const kept = JSON.parse(String(redis.run(["GET", convKey]))) as { token?: string };
    return { conversation, convKey, token: kept.token ?? "" };
  };
  const gone = async (convKey: string, id: string, token: string) => {
    is("no conversation record holds their address", redis.run(["GET", convKey]), null);
    is("the inbox index does not list it", redis.run(["ZSCORE", `nl:inbox:${statsId}:all`, id]), null);
    is("no message list is written back", redis.run(["LRANGE", `nl:inbox:${statsId}:m:${id}`, 0, -1]), []);
    is("the visitor's old chat token does not open it again", token ? redis.run(["GET", tokenKey(token)]) : null, null);
    is("the inbox does not show the person", (await readInbox(statsId)).some((c) => c.email === PERSON), false);
  };

  part("control: opening an unread conversation with nothing in between marks it read");
  {
    const { conversation } = await file();
    is("(setup) it is unread", conversation.unread > 0, true);
    const thread = await openConversation(statsId, conversation.id, store);
    is("it is opened", thread?.conversation.id, conversation.id);
    is("it is marked read", thread?.conversation.unread, 0);
    is("it reads as read afterwards", (await readInbox(statsId)).find((c) => c.id === conversation.id)?.unread, 0);
    is("its message is shown", thread?.messages.length, 1);
    is("(cleanup) erased", await forgetInboxPerson(statsId, PERSON), 1);
  }

  part("control: a change made between the read and the write is kept, and the conversation is still marked read");
  {
    const { conversation, convKey } = await file();
    const original = redis.pipeline.bind(redis);
    let changed = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!changed && commands.some((c) => c[0] === "EVAL" && c.includes(convKey))) {
        changed = true;
        const current = JSON.parse(String(redis.run(["GET", convKey]))) as Record<string, unknown>;
        redis.run(["SET", convKey, JSON.stringify({ ...current, assigned: "helper@example.com", unread: 2 }), "KEEPTTL"]);
      }
      return original(commands);
    }) as Pipeline;
    const thread = await openConversation(statsId, conversation.id, store);
    redis.pipeline = original;
    is("(control) the record was changed in between", changed, true);
    is("it is marked read", thread?.conversation.unread, 0);
    is("the change made in between is kept", thread?.conversation.assigned, "helper@example.com");
    is("(cleanup) erased", await forgetInboxPerson(statsId, PERSON), 1);
  }

  part("the creator opens the unread conversation; the person's erasure completes before it is marked read");
  {
    const { conversation, convKey, token } = await file();
    const hook = eraseBeforeWrite(statsId, convKey);
    const thread = await openConversation(statsId, conversation.id, store).catch((error: unknown) => String(error));
    hook.restore();
    is("(control) the erasure deleted the person's one conversation", hook.erased(), 1);
    is("the opened conversation answers gone", thread, null);
    await gone(convKey, conversation.id, token);
  }

  part("the creator replies; the person's erasure completes before the reply is written");
  {
    const { conversation, convKey, token } = await file();
    const hook = eraseBeforeWrite(statsId, convKey);
    const reply = await replyTo(store, conversation.id, OWNER, "Thanks, we will call you tomorrow.").catch((error: unknown) => String(error));
    hook.restore();
    is("(control) the erasure deleted the person's one conversation", hook.erased(), 1);
    is("the reply answers none", reply, { ok: false, reason: "none" });
    await gone(convKey, conversation.id, token);
  }

  part("the creator closes it; the person's erasure completes before the status is written");
  {
    const { conversation, convKey, token } = await file();
    const hook = eraseBeforeWrite(statsId, convKey);
    const status = await setStatus(store, conversation.id, "closed").catch((error: unknown) => String(error));
    hook.restore();
    is("(control) the erasure deleted the person's one conversation", hook.erased(), 1);
    is("the status change answers none", status, null);
    await gone(convKey, conversation.id, token);
  }

  part("the creator gives it to nobody; the person's erasure completes before it is written");
  {
    const { conversation, convKey, token } = await file();
    const hook = eraseBeforeWrite(statsId, convKey);
    const given = await assignTo(store, conversation.id, "", []).catch((error: unknown) => String(error));
    hook.restore();
    is("(control) the erasure deleted the person's one conversation", hook.erased(), 1);
    is("the assignment answers none", given, null);
    await gone(convKey, conversation.id, token);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
