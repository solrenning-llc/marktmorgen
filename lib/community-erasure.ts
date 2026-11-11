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
import { DamagedConfigError, forgetMemberRecord, readConfigExact } from "@/lib/community";
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

/** Deletes one person from one community. Answers how many records went. */
export async function forgetCommunityPerson(id: string, who: string, email: string, productIds: string[]): Promise<number> {
  // Not swallowed (CX-123 rule 24): read as none, every space's record of
  // the person below would be skipped while the erasure said it was done.
  // Except a setup stored damaged (review of #3091 by Claude 2), which asking
  // again never mends: while it cannot be read the community is off for
  // everyone (communityViewer), so no space's answer about them is read or
  // written, and those written before expire on their own within five
  // minutes (lib/community-access.ts, OPEN_SECONDS). Everything else goes now.
  const config = await readConfigExact(id).catch((error: unknown) => {
    if (error instanceof DamagedConfigError) return null;
    throw error;
  });
  const member = await forgetMemberRecord(id, who);
  let records = member ? 1 : 0;
  if (member?.h) records += await forgetHandle(id, member.h, who);
  if (member?.t) records += await forgetCommunityUnsub(member.t);
  await unindexMember(id, who);
  // Their trace (lib/community-trace.ts): what they wrote and did, by reference.
  // Confirmed exactly (rule 24): an unknown reply is not "nothing to delete", and the erasure is not said done.
  const traced = countOf(repliesFor(await redisPipeline([["DEL", traceKey(id, who)]]), 1)?.[0]);
  if (traced === null) throw new UnknownReplyError("a member's community trace, deleted");
  records += traced;
  records += await forgetPointsPerson(id, who);
  records += await forgetNoticesPerson(id, who);
  records += await forgetPushPerson(id, who);
  records += await forgetDmPerson(id, who);
  records += await forgetChatPerson(id, who);
  records += await forgetGrantPerson(id, who);
  records += await forgetRsvpsPerson(id, who, email);
  records += await forgetAccessPerson(id, email, (config?.spaces ?? []).map((s) => s.id), productIds);
  return records;
}
