/**
 * Claude 3's LOW 1 on #3584 (6914041209), refused at queue time by Claude 1: with rotating connections, 40 answers a
 * day filled the 320-answer list in 8 days, and from then on every real creator got 503 full until answers aged out at
 * 24 months. The list must never be filled by days of such answers: each day takes at most a share of the room still
 * free, and at least one answer, so a real creator can always answer. The owner is told before the list is nearly
 * full. Since the coordinator's (A): 64 places are kept for signed-in accounts, one each, so a flood of anonymous
 * answers can never shut out a creator with an account. app/api/creators/route.ts with lib/creator-research-room.ts; synthetic answers, the in-memory database.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/creators/route";
import { RESPONSES_KEY } from "@/lib/creator-research-store";
import { RESEARCH_ANSWERS_PER_DAY, RESEARCH_MAX_ANSWERS, RESEARCH_RESERVED, researchDayCap } from "@/lib/creator-research-room";
import { SESSION_COOKIE, endSession, openSession } from "@/lib/auth";
import { store } from "./redis-stub";
import { done, is, part } from "./check";

const payload = {
  name: "Synthetic Creator", email: "creator@example.test", platform: "Other",
  country: "Test country", problem: "A synthetic research answer for a regression test.",
  link: "", tools: "", cost: "", consentResearch: true,
  consentFollowUp: false, consentUpdates: false, website: "",
};
async function ask(from: string, session?: string, email = payload.email): Promise<[number, string]> {
  const cookie: Record<string, string> = session ? { Cookie: `${SESSION_COOKIE}=${session}` } : {};
  const response = await POST(
    new NextRequest("https://marktmorgen.com/api/creators", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://marktmorgen.com", Host: "marktmorgen.com", "x-forwarded-for": from, ...cookie },
      body: JSON.stringify({ ...payload, email }),
    }),
  );
  const json = (await response.json()) as { error?: string; saved?: boolean };
  return [response.status, json.error ?? (json.saved === true ? "saved" : "?")];
}
const length = async () => Number((await store.pipeline([["LLEN", RESPONSES_KEY]]))[0]);
/** A new UTC day for the day's count: its key goes, as it would at midnight. */
const nextDay = async () => {
  await store.pipeline([["DEL", `nl:rl:creators:day:${new Date().toISOString().slice(0, 10)}`]]);
};

async function main() {
  const original = console.error;
  const warned: string[] = [];
  console.error = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    part("365 days of swapped connections, each day's cap answered in full (the coordinator's rule 4)");
    store.clear();
    for (let day = 0; day < 365; day += 1) {
      await nextDay();
      for (let n = 0; n < RESEARCH_ANSWERS_PER_DAY + 2; n += 1) await ask(`198.${18 + (day >> 8)}.${day & 255}.${n + 1}`);
    }
    is("the anonymous answers never take the reserved places", await length(), RESEARCH_MAX_ANSWERS - RESEARCH_RESERVED);
    await nextDay();
    is("an answer with no account is crowded out by such a flood (option B is the named follow-up)", await ask("203.0.113.76"), [503, "full"]);
    const signedIn = await openSession("real.creator@example.test");
    is("a signed-in creator still saves, in a reserved place", await ask("203.0.113.77", signedIn, "real.creator@example.test"), [201, "saved"]);
    is("a second answer from the same account is refused, never a second reserved place", await ask("203.0.113.78", signedIn, "other@example.test"), [409, "already"]);
    const again = await openSession("real.creator@example.test");
    is("and so is one from another session of the same account", await ask("203.0.113.79", again), [409, "already"]);
    await endSession(again);
    is("an ended session counts as anonymous", await ask("203.0.113.80", again), [503, "full"]);
    is("a made-up session counts as anonymous", await ask("203.0.113.81", "f".repeat(64)), [503, "full"]);
    const others = [];
    for (let n = 0; n < RESEARCH_RESERVED - 1; n += 1) others.push(await ask(`203.0.114.${n + 1}`, await openSession(`creator${n}@example.test`), `creator${n}@example.test`));
    is("each other account takes one reserved place", others.every(([status]) => status === 201), true);
    is("the list stays at its ceiling", await length(), RESEARCH_MAX_ANSWERS);
    is("past the reserve, an account is told the list is full", await ask("203.0.114.200", await openSession("late@example.test"), "late@example.test"), [503, "full"]);
    is("the owner was told before the list was nearly full", warned.some((line) => /creator research: the list is .*% full/.test(line)), true);

    part("Control: a reserved place is never refused because a flood took the day");
    store.clear();
    await nextDay();
    for (let n = 0; n < RESEARCH_ANSWERS_PER_DAY + 2; n += 1) await ask(`198.20.0.${n + 1}`);
    is("the day is taken", await ask("198.20.1.1"), [429, "busy"]);
    is("a signed-in creator still saves the same day", await ask("198.20.1.2", await openSession("same.day@example.test"), "same.day@example.test"), [201, "saved"]);

    part("Control: a fresh list takes its whole day's share");
    store.clear();
    await nextDay();
    let saved = 0;
    for (let n = 0; n < RESEARCH_ANSWERS_PER_DAY; n += 1) if ((await ask(`198.19.0.${n + 1}`))[0] === 201) saved += 1;
    // Counted against the room free at each answer: the day stops when its count passes the share of what is left.
    let share = 0;
    while (share + 1 <= researchDayCap(share)) share += 1;
    is("the day's share of an empty list is kept, and no more", saved, share);
    is("and it is a real day's worth, never more than the fixed cap", share >= 10 && share <= RESEARCH_ANSWERS_PER_DAY, true);
  } finally {
    console.error = original;
  }
  done();
}
main().catch((error: unknown) => {
  process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
  process.exit(1);
});
