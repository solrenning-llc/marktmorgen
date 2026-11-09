/**
 * Deleting one person from a store's community (added 17 October 2026, for
 * lib/person-erasure.ts): everything the community keeps under their member
 * key, gathered from the modules that keep it, each through its own
 * function.
 *
 *   - their record: address, name, handle, answers to the creator's
 *     questions, the directory and the search index of members;
 *   - their points, rewards and places on the boards;
 *   - what they were told, the devices they let us notify, their private
 *     conversations and requests, what they said in the room and the leave
 *     they held there;
 *   - their answers to whether they are coming to each live event, and the
 *     answers kept about whether they may come in;
 *   - the record behind the unsubscribe link in the announcements they got.
 *
 * What they wrote in the feed — posts, comments, likes, poll votes, reports
 * — is kept by post, not by member, and is not reached from here yet; the
 * registry lists it as open (lib/person-data.ts), and the confirmation says
 * so before anyone deletes.
 */
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { traceKey } from "@/lib/community-trace";
import { DamagedConfigError, forgetMemberRecord, readConfigExact, readMember } from "@/lib/community";
import { forgetHandle } from "@/lib/community-mentions";
import { forgetCommunityUnsub } from "@/lib/community-mail";
import { forgetPointsPerson } from "@/lib/community-points";
import { forgetNoticesPerson } from "@/lib/community-notify";
import { forgetPushPerson } from "@/lib/community-push";
import { forgetDmPerson } from "@/lib/community-dm";
import { forgetChatPerson } from "@/lib/community-chat";
import { forgetGrantPerson } from "@/lib/chat-grant";
import { forgetRsvpsPerson } from "@/lib/community-events";
import { forgetAccessPerson } from "@/lib/community-access";
import { unindexMember } from "@/lib/community-index";

/**
 * Deletes one person from one community. Answers how many records went.
 *
 * Every step runs, whatever an earlier one answered: one step whose answer
 * came back in an unknown shape (CX-123 rule 24) does not leave the steps after
 * it undone in this pass. Then, if any step could not finish, this throws the
 * first such error, so the erasure is said as not finished (lib/person-erasure.ts)
 * and a retry, keyed by the same member, reaches what is left.
 */
export async function forgetCommunityPerson(id: string, who: string, email: string, productIds: string[]): Promise<number> {
  const failures: unknown[] = [];
  let records = 0;
  const step = async (run: () => Promise<number | void>) => {
    try {
      const gone = await run();
      if (typeof gone === "number") records += gone;
    } catch (error) {
      failures.push(error);
    }
  };
  // Read before anything is deleted, and not swallowed (CX-123 rule 24): read as none, every space's record of the
  // person would be skipped while the erasure said it was done, so a lost or unknown answer refuses the whole pass
  // here and the retry starts over. Except a setup stored damaged (review of #3091 by Claude 2), which asking again
  // never mends: while it cannot be read the community is off for everyone (communityViewer), so no space's answer
  // about them is read or written, and those written before expire on their own within five minutes
  // (lib/community-access.ts, OPEN_SECONDS). Everything else goes now.
  const config = await readConfigExact(id).catch((error: unknown) => {
    if (error instanceof DamagedConfigError) return null;
    throw error;
  });
  // Their record is the only place that names their handle and their unsubscribe token: it is read first and
  // deleted last, and only once what it names is gone, so a step that fails leaves it for the retry (Claude 6 on #2957).
  const named = await readMember(id, who).then(
    (member) => ({ member }),
    (error: unknown) => {
      failures.push(error);
      return null;
    },
  );
  const beforeNamed = failures.length;
  const handle = named?.member?.h;
  const unsub = named?.member?.t;
  if (handle) await step(() => forgetHandle(id, handle, who));
  if (unsub) await step(() => forgetCommunityUnsub(unsub));
  const namedGone = named !== null && failures.length === beforeNamed;
  await step(() => unindexMember(id, who));
  // Their trace (lib/community-trace.ts): what they wrote and did, by reference. DEL's own count only (CX-123 rule 24).
  await step(async () => {
    const traced = countOf(repliesFor(await redisPipeline([["DEL", traceKey(id, who)]]), 1)?.[0]);
    if (traced === null) throw new UnknownReplyError("a member's trace deleted");
    return traced;
  });
  await step(() => forgetPointsPerson(id, who));
  await step(() => forgetNoticesPerson(id, who));
  await step(() => forgetPushPerson(id, who));
  await step(() => forgetDmPerson(id, who));
  await step(() => forgetChatPerson(id, who));
  await step(() => forgetGrantPerson(id, who));
  await step(() => forgetRsvpsPerson(id, who, email));
  await step(() => forgetAccessPerson(id, email, (config?.spaces ?? []).map((s) => s.id), productIds));
  if (namedGone) {
    await step(async () => ((await forgetMemberRecord(id, who)) ? 1 : 0));
  }
  if (failures.length) throw failures[0];
  return records;
}
