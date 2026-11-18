/**
 * Codex N4's MEDIUM on #4831 (N4-20261116-2304, cited by Codex P in 6937765174): a removed membership's invitation
 * is the only way back to its link (nl:mv:link:<token>, which holds the store and the address's field). The page's
 * deletion sent HDEL, ZREM and DEL in one pipeline, which Redis does not run as one: when the link's DEL is not
 * known done while the HDEL went through, the field is gone and the link is left with nothing that leads to it,
 * until it expires. The link is now deleted, and its deletion read, before the field and the reminder are taken off,
 * so a failure at any step leaves the invitation for the next try to find again.
 *
 * Synthetic store and people; Redis is the in-memory stand-in (tests/redis-stub.ts).
 */
import { type Invite, dropProductInvites, inviteField, linkKey } from "@/lib/move-members";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "link-first@example.com";
  await claimHandle(OWNER, "linkfirst", "Link First", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const club = "k".repeat(12);
  const key = `nl:mv:${store.statsId}`;
  const who = "member@example.com";
  const token = "ab".repeat(20);
  const field = inviteField(who, club);
  const write = async () => {
    const value = JSON.stringify({ e: who, p: club, o: "", r: 1_900_000_000, job: "a".repeat(24), at: 1_790_000_000_000, t: token, kept: 0 } satisfies Invite);
    await redis.pipeline([["HSET", key, field, value], ["SET", linkKey(token), JSON.stringify({ s: store.statsId, f: field })]]);
  };
  const original = redis.pipeline.bind(redis);

  part("The link's DEL fails after the HDEL went through: the invitation is kept, so the link is found again");
  await write();
  redis.pipeline = (async (batch: Command[]) => {
    const linkDel = batch.findIndex((c) => c[0] === "DEL" && String(c[1]).startsWith("nl:mv:link:"));
    if (linkDel === -1) return original(batch);
    // Every other command of the batch runs; the link's DEL answers in no known shape (a reply lost on the way).
    const replies = await original(batch.filter((_, i) => i !== linkDel));
    replies.splice(linkDel, 0, "lost");
    return replies;
  }) as typeof redis.pipeline;
  let thrown: unknown = null;
  try {
    await dropProductInvites(store, club, async () => true);
  } catch (error) {
    thrown = error;
  } finally {
    redis.pipeline = original;
  }
  is("the removal says it is not known done", thrown instanceof UnknownReplyError, true);
  const [still, link] = await redis.pipeline([["HEXISTS", key, field], ["EXISTS", linkKey(token)]]);
  is("the link is still there, and so is the invitation that leads to it", [link, still], [1, 1]);
  is("the next try deletes both", [await dropProductInvites(store, club, async () => true), ...(await redis.pipeline([["HEXISTS", key, field], ["EXISTS", linkKey(token)]]))], [1, 0, 0]);

  part("Control: nothing fails, both go in one removal");
  await write();
  is("one invitation dropped, its link with it", [await dropProductInvites(store, club, async () => true), ...(await redis.pipeline([["HEXISTS", key, field], ["EXISTS", linkKey(token)]]))], [1, 0, 0]);

  for (const [operation, answer] of [["DEL", 2], ["ZREM", "lost"]] as const) {
    part(`An unconfirmed ${operation} leaves the invitation available for retry`);
    await write();
    const dueKey = "nl:mv:due";
    const member = `${store.sid}|${field}`;
    await original([["ZADD", dueKey, 1_900_000_000, member]]);
    redis.pipeline = (async (batch: Command[]) => {
      const failed = batch.findIndex((command) => command[0] === operation && command[1] === (operation === "DEL" ? linkKey(token) : dueKey));
      if (failed === -1) return original(batch);
      const replies = await original(batch.filter((_, index) => index !== failed));
      replies.splice(failed, 0, answer);
      return replies;
    }) as typeof redis.pipeline;
    let unconfirmed = false;
    try {
      await dropProductInvites(store, club, async () => true);
    } catch (error) {
      unconfirmed = error instanceof UnknownReplyError;
    } finally {
      redis.pipeline = original;
    }
    is("the cleanup is unconfirmed and keeps the invitation",
      [unconfirmed, (await original([["HEXISTS", key, field]]))[0]], [true, 1]);
    is("an exact retry removes the invitation, its link and its reminder",
      [await dropProductInvites(store, club, async () => true), ...await original([["HEXISTS", key, field], ["EXISTS", linkKey(token)], ["ZSCORE", dueKey, member]])],
      [1, 0, 0, null]);
  }

  done();
}

void main();
