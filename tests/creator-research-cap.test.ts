/**
 * MR: the creator research form is public, so the list its answers go to
 * (nl:creators:responses) has a ceiling of its own, not only the per-address
 * rate (5 an hour), which many addresses pass together. At the ceiling an
 * answer is not kept: the request is refused (503) and the list stays at the
 * ceiling, never above it. Below it, an answer is kept as before.
 *
 * Synthetic answers only, no external call.
 */
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/creators/route";
import { MAX_RESEARCH_ANSWERS, RESPONSES_KEY } from "@/lib/creator-research-store";
import { store } from "./redis-stub";

async function main() {
  globalThis.fetch = (async () => { throw new Error("Unexpected external request"); }) as typeof fetch;
  const payload = {
    name: "Synthetic Creator", email: "creator@example.test", platform: "Other",
    country: "Test country", problem: "A synthetic research answer for a ceiling test.",
    link: "", tools: "", cost: "", consentResearch: true,
    consentFollowUp: false, consentUpdates: false, website: "",
  };
  const ask = (ip: string) => POST(
    new NextRequest("https://marktmorgen.com/api/creators", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://marktmorgen.com", Host: "marktmorgen.com", "x-forwarded-for": ip },
      body: JSON.stringify(payload),
    }),
  );
  const length = async () => (await store.pipeline([["LLEN", RESPONSES_KEY]]))[0];

  assert.ok(Number.isSafeInteger(MAX_RESEARCH_ANSWERS) && MAX_RESEARCH_ANSWERS > 0 && MAX_RESEARCH_ANSWERS <= 5_000, "a finite ceiling, at most 5,000 answers of at most 20 KB");

  // One below the ceiling: the next answer is kept.
  const filler = JSON.stringify({ id: "filler", createdAt: new Date().toISOString() });
  for (let i = 0; i < MAX_RESEARCH_ANSWERS - 1; i += 500) {
    const n = Math.min(500, MAX_RESEARCH_ANSWERS - 1 - i);
    await store.pipeline([["LPUSH", RESPONSES_KEY, ...Array.from({ length: n }, () => filler)]]);
  }
  assert.equal(await length(), MAX_RESEARCH_ANSWERS - 1);
  assert.equal((await ask("198.51.100.1")).status, 201, "below the ceiling, kept");
  assert.equal(await length(), MAX_RESEARCH_ANSWERS);

  // At the ceiling, from many addresses: refused, and the list never grows.
  for (let i = 2; i < 8; i += 1) {
    const answer = await ask(`198.51.100.${i}`);
    assert.equal(answer.status, 503, `at the ceiling, refused (address ${i})`);
    assert.equal(await length(), MAX_RESEARCH_ANSWERS, "the list stays at its ceiling");
  }
  const [newest] = await store.pipeline([["LINDEX", RESPONSES_KEY, 0]]);
  assert.equal(JSON.parse(String(newest)).problem, payload.problem, "the answer kept last is the one under the ceiling");
  console.log("Creator research: the public list has a ceiling, and an answer over it is refused, never kept.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
