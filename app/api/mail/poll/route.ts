import { limited } from "@/lib/request-guard";
import { type PollVoteAnswer, votePoll } from "@/lib/email-poll-vote";

/**
 * A press of Confirm (or of "Take back my answer") on a poll's page (125
 * [F2-EMAIL-POLLS], unit 4; lib/email-poll-vote.ts). Only a POST counts:
 * opening a link in the email never reaches here. `b` is the broadcast, `k`
 * the recipient's signed place, the form's `a` the answer's index, or "none"
 * to take the answer back.
 *
 * Nothing sends a poll yet, so no link leads here; the page that asks for
 * the press comes with the next unit.
 */
const WORDS: Record<PollVoteAnswer, { status: number; text: string }> = {
  recorded: { status: 200, text: "Your answer is counted. You can change it or take it back from the same link while the poll is open." },
  withdrawn: { status: 200, text: "Your answer is taken back. Nothing of yours is counted in this poll." },
  closed: { status: 410, text: "This poll has closed, so answers can no longer be changed." },
  invalid: { status: 404, text: "This poll link is not one we know. Nothing was counted." },
  resting: { status: 503, text: "This store cannot take answers this month. Nothing was counted." },
  unknown: { status: 503, text: "We could not save that just now. Nothing was counted. Please try again in a minute." },
};

export async function POST(request: Request) {
  const query = new URL(request.url).searchParams;
  const broadcastId = (query.get("b") ?? "").slice(0, 32);
  const link = (query.get("k") ?? "").slice(0, 48);
  let answer: string | null = null;
  try {
    const form = await (await limited(request, 2_000)).formData();
    const a = form.get("a");
    answer = typeof a === "string" ? a : null;
  } catch {
    answer = null;
  }
  const option = answer === "none" ? null : answer !== null && /^\d$/.test(answer) ? Number(answer) : undefined;
  const result: PollVoteAnswer = option === undefined ? "invalid" : await votePoll({ broadcastId, link, option, now: Date.now() });
  const { status, text } = WORDS[result];
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...(result === "unknown" ? { "Retry-After": "60" } : {}) },
  });
}
