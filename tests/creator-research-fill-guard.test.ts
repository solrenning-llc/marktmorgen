/**
 * Claude 3's LOW 1 on #3584 (6914041209), refused at queue time by Claude 1: with rotating connections, 40 answers a
 * day filled the 320-answer list in 8 days, and from then on every real creator got 503 full until answers aged out at
 * 24 months. The list must never be filled by days of such answers: each day takes at most a share of the room still
 * free, and at least one answer, so a real creator can always answer. The owner is told before the list is nearly
 * full. app/api/creators/route.ts with lib/creator-research-room.ts; synthetic answers, the in-memory database.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/creators/route";
import { RESPONSES_KEY } from "@/lib/creator-research-store";
import { RESEARCH_ANSWERS_PER_DAY, RESEARCH_MAX_ANSWERS, researchDayCap } from "@/lib/creator-research-room";
import { store } from "./redis-stub";
import { done, is, part } from "./check";

const payload = {
  name: "Synthetic Creator", email: "creator@example.test", platform: "Other",
  country: "Test country", problem: "A synthetic research answer for a regression test.",
  link: "", tools: "", cost: "", consentResearch: true,
  consentFollowUp: false, consentUpdates: false, website: "",
};
async function ask(from: string): Promise<[number, string]> {
  const response = await POST(
    new NextRequest("https://marktmorgen.com/api/creators", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://marktmorgen.com", Host: "marktmorgen.com", "x-forwarded-for": from },
      body: JSON.stringify(payload),
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
    part("Sixty days of rotating connections, each day's cap answered in full");
    store.clear();
    let worstDay = 0;
    for (let day = 0; day < 60; day += 1) {
      await nextDay();
      for (let n = 0; n < RESEARCH_ANSWERS_PER_DAY + 2; n += 1) await ask(`198.18.${day}.${n + 1}`);
      worstDay = Math.max(worstDay, await length());
    }
    is("the list is never filled", worstDay < RESEARCH_MAX_ANSWERS, true);
    await nextDay();
    is("a real creator the next day still saves", await ask("203.0.113.77"), [201, "saved"]);
    is("the owner was told before the list was nearly full", warned.some((line) => /creator research: the list is .*% full/.test(line)), true);

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
