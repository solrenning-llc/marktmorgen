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
import type { DataStore } from "@/lib/store-data";
import { TRACE_ENTRY, traceKey } from "@/lib/community-trace";
import { SET_TAKE_COUNT } from "@/lib/redis-take";
import { UnknownReply, exactReplies, replyCount } from "@/lib/redis-exact";
import { giveData } from "@/lib/store-data";
import { forgetMemberRecord, readConfig, readMemberRecord } from "@/lib/community";
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
 * `room` is the store's data room: their record, their trace, their
 * devices, private conversations, the people they declined and their places
 * at live events give back what they took there.
 */
export async function forgetCommunityPerson(id: string, who: string, email: string, productIds: string[], room?: DataStore): Promise<number> {
  const config = await readConfig(id).catch(() => null);
  // The record is read first and taken last: what it names elsewhere (their handle, their unsubscribe token, whose
  // record holds their address) goes while it can still be found by it, so a step that fails leaves the record for
  // the next try (Claude 5 on #2576).
  let records = 0;
  let gone = false;
  for (let tries = 0; tries < 3 && !gone; tries += 1) {
    const read = await readMemberRecord(id, who);
    const member = read?.member ?? null;
    if (member?.h) records += await forgetHandle(id, member.h, who);
    if (member?.t) records += await forgetCommunityUnsub(member.t);
    gone = await forgetMemberRecord(id, who, read?.raw ?? null, room);
    if (gone && read) records += 1;
  }
  if (!gone) throw new UnknownReply("a member's record that kept changing while it was deleted");
  await unindexMember(id, who);
  // Their trace (lib/community-trace.ts): what they wrote and did, by
  // reference; counted and deleted in one step, each entry's room given back once.
  // Read exactly (Claude 6's note on #2576): a reply that is not one whole count is unknown, never "nothing was
  // there", so the person is not reported deleted with the trace maybe kept, and no room is given back for it.
  const [traced] = exactReplies(await redisPipeline([["EVAL", SET_TAKE_COUNT, 1, traceKey(id, who)]]), 1, "a member's trace deletion");
  const entries = replyCount(traced, "a member's trace deletion");
  records += entries ? 1 : 0;
  if (room && entries > 0) await giveData(room, [{ ...TRACE_ENTRY, bytes: entries * TRACE_ENTRY.bytes }]);
  records += await forgetPointsPerson(id, who);
  records += await forgetNoticesPerson(id, who);
  records += await forgetPushPerson(id, who, room);
  records += await forgetDmPerson(id, who, room);
  records += await forgetChatPerson(id, who);
  records += await forgetGrantPerson(id, who);
  records += await forgetRsvpsPerson(id, who, email, room);
  records += await forgetAccessPerson(id, email, (config?.spaces ?? []).map((s) => s.id), productIds);
  return records;
}
