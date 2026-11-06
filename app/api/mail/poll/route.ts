import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { clientAddress, limited, withinLimit } from "@/lib/request-guard";
import { storeForPage } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { type Ballot, type VoteOutcome, ballotUrl, castVote, readBallot, readPollRecord, withdrawVote } from "@/lib/mail-poll-votes";

/**
 * The button on a poll's page (app/poll): keeps a reader's answer, or takes
 * it back (lib/mail-poll-votes.ts). Only a link this site signed for one
 * reader and one poll counts. Each press is one of the store's public
 * requests, taken before anything is written; whatever cannot be confirmed
 * goes back to the page as "failed", which never says it was recorded.
 */
export async function POST(request: NextRequest) {
  const ballot = readBallot(request.nextUrl.searchParams);
  if (!ballot) return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  let action: "vote" | "withdraw" = "vote";
  let outcome: VoteOutcome;
  try {
    const form = await (await limited(request, 2_000)).formData();
    action = form.get("do") === "withdraw" ? "withdraw" : "vote";
    outcome = (await withinLimit("mail-poll", clientAddress(request), 60, 3_600).catch(() => false)) ? await settle(ballot, action) : "failed";
  } catch {
    outcome = "failed";
  }
  const back = ballotUrl(ballot, `&done=${outcome}`).replace(/^https:\/\/[^/]+/, originFrom(request));
  return new Response(null, { status: 303, headers: { Location: back, "Cache-Control": "no-store" } });
}

async function settle(ballot: Ballot, action: "vote" | "withdraw"): Promise<VoteOutcome> {
  const record = await readPollRecord(ballot.listId, ballot.pollId);
  if (record === "failed") return "failed";
  if (!record) return "closed";
  const store = await storeForPage(record.handle).catch(() => null);
  if (!store || store.listId !== ballot.listId) return "closed";
  if (!(await takePublicRequest(store).catch(() => false))) return "failed";
  return action === "withdraw" ? withdrawVote(ballot, record) : castVote(ballot, record);
}
