/**
 * Two readers behind the person's data copy (lib/person-copy.ts, GDPR art. 15)
 * read exactly (rule 24): an unreadable reply is unknown, never "nothing".
 *
 *   - readInbox (lib/inbox.ts): a kept conversation whose record does not
 *     read was dropped from the list, so the copy left out the person's
 *     conversation with the store in silence and the studio did not show it.
 *   - votesOf (lib/community-polls.ts): a reply of another shape (a number,
 *     an empty string, a pipeline of another length) was read as "did not
 *     vote", so the copy left out the person's poll votes.
 *
 * Now each throws UnknownReplyError, and the copy fails whole instead of
 * being handed over with a part missing. Only an exact null is no vote, and
 * only a conversation that expired leaves the inbox.
 *
 * Synthetic only: the Redis stand-in with one reply at a time made malformed.
 */
import { claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { fileContact, readInbox } from "@/lib/inbox";
import { votesOf } from "@/lib/community-polls";
import { erasureScope } from "@/lib/person-erasure";
import { COPIERS, copyPerson } from "@/lib/person-copy";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "exact-readers@example.com";
const PERSON = "ada@example.com";
const COMMUNITY = "c".repeat(32);
const WHO = "a".repeat(32);
const POST_A = "p".repeat(12);
const POST_B = "q".repeat(12);
const votesKey = (post: string) => `nl:cm:${COMMUNITY}:pv:${post}`;

type Command = (string | number)[];
const original: typeof redis.pipeline = redis.pipeline.bind(redis);

/** Answers the first pipeline whose first command is `name` on a key matching `key` with `reply`; the rest as kept. */
function swap(name: string, key: (k: string) => boolean, reply: unknown): void {
  let hit = false;
  redis.pipeline = (async (batch: Command[]) => {
    if (!hit && batch[0]?.[0] === name && key(String(batch[0]?.[1]))) {
      hit = true;
      return reply as unknown[];
    }
    return original(batch);
  }) as typeof redis.pipeline;
}
const restore = () => {
  redis.pipeline = original;
};

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  } finally {
    restore();
  }
}

async function main(): Promise<void> {
  part("The inbox: a kept conversation that does not read is unknown, never left out");
  {
    redis.clear();
    await claimHandle(OWNER, "exactreaders", "Exact Readers", "");
    await ensureStatsId(OWNER);
    await ensureListId(OWNER);
    const store = (await storeForEmail(OWNER))!;
    await fileContact({ store, email: PERSON, name: "Ada", text: "Is the course still open?" });
    const scope = (await erasureScope(store, PERSON))!;
    const healthy = (await COPIERS["lib/inbox.ts"](scope)) as { messages: { text: string }[] }[];
    is("healthy: the copy holds the person's conversation", healthy[0]?.messages[0]?.text, "Is the course still open?");

    const isConversation = (k: string) => k.startsWith(`nl:inbox:${store.statsId}:c:`);
    swap("MGET", isConversation, [["{not json"]]);
    is("the studio's list says it could not read, never shows the inbox without it", await outcome(() => readInbox(store.statsId)), "unknown");
    swap("MGET", isConversation, [[JSON.stringify({ id: "x", email: PERSON })]]);
    is("a record of another shape is unknown too", await outcome(() => readInbox(store.statsId)), "unknown");
    swap("MGET", isConversation, [["{not json"]]);
    is("the inbox part of the copy fails", await outcome(() => COPIERS["lib/inbox.ts"](scope)), "unknown");
    swap("MGET", isConversation, [["{not json"]]);
    is("and so does the whole copy, never handed over without the conversation", await outcome(() => copyPerson(scope)), "unknown");
    is("with the record as kept, the inbox reads again", (await readInbox(store.statsId)).length, 1);
  }

  part("Poll votes: only an exact null is no vote");
  {
    redis.clear();
    await redis.pipeline([["HSET", votesKey(POST_A), WHO, "0,2"]]);
    is("healthy: a vote reads, a post with none is not listed", await votesOf(COMMUNITY, WHO, [POST_A, POST_B]), [{ post: POST_A, picked: ["0", "2"] }]);
    const isVotes = (k: string) => k.startsWith(`nl:cm:${COMMUNITY}:pv:`);
    swap("HGET", isVotes, ["0,2", 42]);
    is("a number for a vote is unknown, never no vote", await outcome(() => votesOf(COMMUNITY, WHO, [POST_A, POST_B])), "unknown");
    swap("HGET", isVotes, ["0,2", ""]);
    is("an empty string is unknown: a vote with no choice is never kept", await outcome(() => votesOf(COMMUNITY, WHO, [POST_A, POST_B])), "unknown");
    swap("HGET", isVotes, ["0,2"]);
    is("a pipeline with a reply missing is unknown", await outcome(() => votesOf(COMMUNITY, WHO, [POST_A, POST_B])), "unknown");
    swap("HGET", isVotes, { 0: "0,2", 1: null });
    is("a reply that is not a list is unknown", await outcome(() => votesOf(COMMUNITY, WHO, [POST_A, POST_B])), "unknown");
    is("with the replies as kept, the votes read again", await votesOf(COMMUNITY, WHO, [POST_A, POST_B]), [{ post: POST_A, picked: ["0", "2"] }]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
