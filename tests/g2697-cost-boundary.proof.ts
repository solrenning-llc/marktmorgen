/** G cost-evidence audit. Real route and minute limiter; auth/startPitch are existing synthetic route boundaries. */
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/store/outreach/route";
import { AI_PER_MINUTE } from "@/lib/ai-rules";
import { redis, reset, state } from "./outreach-counter-admission-world";
import { done, is, part } from "./check";

const DAY = Date.parse("2026-11-06T00:00:00Z");
const ask = () => POST(new Request("https://example.com/api/store/outreach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "draft", goal: "sponsor", country: "US", notes: "Synthetic draft" }) }) as NextRequest);
async function main(): Promise<void> {
  part("A first-use minute window crosses UTC midnight");
  reset();
  let now = DAY - 59_000;
  redis.now = () => now;
  assert.equal((await ask()).status, 200); // One legitimate preceding-day use, creating the sixty-second key.
  now = DAY;
  let withinDay = 0;
  for (let i = 1; i < AI_PER_MINUTE; i += 1) { assert.equal((await ask()).status, 200); withinDay += 1; }
  is("old window still enforces its six admitted calls", (await ask()).status, 429);
  // Each subsequent window has exactly its actual sixty-second TTL, never a reset or key deletion.
  for (let minute = 0; minute < 1440; minute += 1) {
    now = DAY + 1_000 + minute * 60_000;
    assert.ok(now >= DAY && now < DAY + 86_400_000);
    for (let i = 0; i < AI_PER_MINUTE; i += 1) { assert.equal((await ask()).status, 200); withinDay += 1; }
    assert.equal((await ask()).status, 429);
  }
  is("real route admitted exactly five residual plus 1,440 full windows", withinDay, 8645);
  is("one previous-day call is excluded from the day count", state.drafts, withinDay + 1);
  console.log(JSON.stringify({ withinDay, proposedAttemptCeiling: AI_PER_MINUTE * 1440, proposedExtraCommandCeiling: 43200, admittedTimesFive: withinDay * 5, scope: "route admission only; no provider or real startPitch work" }));
  is("AI minute limiter alone proves at most 8,640 UTC-day draft admissions", withinDay <= AI_PER_MINUTE * 1440, true);
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
