import type { NextRequest } from "next/server";
import { BROADCAST_ID } from "@/lib/broadcasts";
import { originFrom } from "@/lib/request-origin";
import { limited } from "@/lib/request-guard";
import { POLL_ROUTE_WORDS as WORDS, type PollVoteAnswer, votePoll } from "@/lib/email-poll-vote";

/**
 * A press of Confirm (or of "Take back my answer") on a poll's page (125
 * [F2-EMAIL-POLLS], unit 4; lib/email-poll-vote.ts). Only a POST counts:
 * opening a link in the email never reaches here. `b` is the broadcast, `k`
 * the recipient's signed place, the form's `a` the answer's index, or "none"
 * to take the answer back.
 *
 * A press from the page (form `from=page`, app/poll/page.tsx) goes back to
 * it with what happened (`done`); anything else gets the words alone.
 * Nothing sends a poll yet, so no link leads here.
 */

export async function POST(request: NextRequest) {
  const query = new URL(request.url).searchParams;
  const broadcastId = (query.get("b") ?? "").slice(0, 32);
  const link = (query.get("k") ?? "").slice(0, 48);
  let answer: string | null = null;
  let fromPage = false;
  try {
    const form = await (await limited(request, 2_000)).formData();
    const a = form.get("a");
    answer = typeof a === "string" ? a : null;
    fromPage = form.get("from") === "page";
  } catch {
    answer = null;
  }
  const option = answer === "none" ? null : answer !== null && /^\d$/.test(answer) ? Number(answer) : undefined;
  const result: PollVoteAnswer = option === undefined ? "invalid" : await votePoll({ broadcastId, link, option, now: Date.now() });
  if (fromPage) {
    const back = BROADCAST_ID.test(broadcastId) ? `b=${broadcastId}&k=${encodeURIComponent(link)}&` : "";
    return new Response(null, { status: 303, headers: { Location: `${originFrom(request)}/poll?${back}done=${result}`, "Cache-Control": "no-store" } });
  }
  const { status, text } = WORDS[result];
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...(result === "unknown" ? { "Retry-After": "60" } : {}) },
  });
}
