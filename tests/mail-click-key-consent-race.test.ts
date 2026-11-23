/**
 * Codex G (G-20261121-0033, MEDIUM, consent and erasure; #5010 row 110): a sequence reads its readers (lib/contacts.ts
 * tokensFor), then writes the key their links carry (lib/mail-clicks.ts rememberLinkKeys, nl:mail:mk:<key>, kept 400
 * days) with a plain SET. The permission taken back (stopCounting), an unsubscribe (with forgetClicksPerson after it)
 * or the person's erasure (lib/person-erasure.ts) that finished in between had already deleted the key, and the late
 * SET wrote it back with nothing left to delete it: a reader who said no could still be told apart by their links for
 * 400 days. The key is now written in one step only while the reader still allows it (MAIL_CLICK_KEY_LIVE: no deletion
 * print, the row with this token, the permission and a yes), and stopCounting takes the permission off the row before
 * it deletes the key. Each case runs the sequence's write before every Redis call the other side makes, one at a time,
 * and the key is never left behind. Synthetic data; Redis is lib/redis-memory.ts.
 */
import { tokensFor, unsubscribe, upsertContact } from "@/lib/contacts";
import { MAIL_CLICK_KEY_COMMANDS, MAIL_CLICK_KEY_LIVE, forgetClicksPerson, keyIndex, linkKeyOf, rememberLinkKeys, stopCounting } from "@/lib/mail-clicks";
import { erasePerson } from "@/lib/person-erasure";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const OWNER = "click-key-owner@example.test";
const READER = "click-key-reader@example.test";

async function setUp(): Promise<{ store: Store; listId: string; token: string }> {
  redis.clear();
  await claimHandle(OWNER, "clickkey", "Click Key Kiln", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ClickKey", subscriptionId: "sub_ClickKey", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  await upsertContact(listId, READER, { agreed: true, explicit: true, source: "free", sid: store.sid, clicks: true, title: "The Guide" }, ROOM);
  const token = (await tokensFor(listId, [READER], store.handle)).get(READER);
  if (!token) throw new Error("no unsubscribe token");
  return { store, listId, token };
}

const keyKept = (token: string) => redis.run(["EXISTS", keyIndex(linkKeyOf(token))]) === 1;

/**
 * Runs `other` with the sequence's key write (as lib/mail.ts sends it, after its read of the readers) just before its
 * Redis call number `at`. Answers whether that call was reached, and so whether the write ran.
 */
async function writeBeforeCall(at: number, listId: string, token: string, other: () => Promise<unknown>): Promise<boolean> {
  const real = redis.pipeline.bind(redis);
  let calls = 0;
  let wrote = false;
  redis.pipeline = (async (commands: Commands) => {
    if (calls++ === at && !wrote) {
      wrote = true;
      redis.pipeline = real;
      try {
        await rememberLinkKeys(listId, [{ email: READER, token }]);
      } finally {
        redis.pipeline = wrapped;
      }
    }
    return real(commands);
  }) as typeof redis.pipeline;
  const wrapped = redis.pipeline;
  try {
    await other().catch(() => undefined);
  } finally {
    redis.pipeline = real;
  }
  return wrote;
}

async function everyInterleaving(name: string, other: (s: { store: Store; listId: string; token: string }) => Promise<unknown>): Promise<void> {
  part(`${name}: the sequence's key write lands before each of its Redis calls in turn`);
  const left: number[] = [];
  let at = 0;
  for (; at < 400; at += 1) {
    const s = await setUp();
    if (!(await writeBeforeCall(at, s.listId, s.token, () => other(s)))) break;
    if (keyKept(s.token)) left.push(at);
  }
  is(`${name}: interleavings tried (more than one)`, at > 1, true);
  is(`${name}: no interleaving leaves the reader's key behind`, left, []);
}

async function main(): Promise<void> {
  console.error = () => {};

  part("Control: a reader who allows it gets a key, and their links carry it");
  {
    const { listId, token } = await setUp();
    const keys = await rememberLinkKeys(listId, [{ email: READER, token }]);
    is("the key is handed back", keys.get(token), linkKeyOf(token));
    is("and kept, leading back to their token", redis.run(["GET", keyIndex(linkKeyOf(token))]), token);
    // What it costs, as Upstash bills a script (tests/plan-cost-registry.ts, "mail-click-keys").
    const real = redis.pipeline.bind(redis);
    const sent: Commands = [];
    redis.pipeline = (async (commands: Commands) => {
      sent.push(...commands);
      return real(commands);
    }) as typeof redis.pipeline;
    try {
      await rememberLinkKeys(listId, [{ email: READER, token }]);
    } finally {
      redis.pipeline = real;
    }
    const inside = MAIL_CLICK_KEY_LIVE.match(/redis\.call\(/g)?.length ?? 0;
    is("one script a reader, billed with the calls inside it, as the registry prices", [sent.length, sent[0]?.[0], sent.length + inside], [1, "EVAL", MAIL_CLICK_KEY_COMMANDS]);
  }

  part("Each condition alone writes no key");
  {
    const { store, listId, token } = await setUp();
    await stopCounting(token);
    is("the permission taken back", [(await rememberLinkKeys(listId, [{ email: READER, token }])).size, keyKept(token)], [0, false]);
    const again = await setUp();
    await unsubscribe(again.token);
    is("unsubscribed", [(await rememberLinkKeys(again.listId, [{ email: READER, token: again.token }])).size, keyKept(again.token)], [0, false]);
    const erased = await setUp();
    await erasePerson(erased.store, READER, { kind: "person" });
    is("erased", [(await rememberLinkKeys(erased.listId, [{ email: READER, token: erased.token }])).size, keyKept(erased.token)], [0, false]);
    is("another token than the row's", (await rememberLinkKeys(listId, [{ email: READER, token: "b".repeat(40) }])).size, 0);
    void store;
  }

  await everyInterleaving("Stop counting", ({ token }) => stopCounting(token));
  await everyInterleaving("Unsubscribe", async ({ token }) => {
    const left = await unsubscribe(token);
    if (left) await forgetClicksPerson(left.listId, left.email);
  });
  await everyInterleaving("The person's erasure", ({ store }) => erasePerson(store, READER, { kind: "person" }));

  done();
}

void main().catch((error) => {
  console.error = globalThis.console.log;
  console.log(error);
  process.exit(1);
});
