/**
 * Codex X5 on #2924 at 12f9aaec3f: with Redis not configured, lib/ad-spend.ts readSpendLines answered an empty,
 * complete list of spend lines, so the studio, the numbers answers, the Meta route and the weekly email took the
 * ad spend for $0 and showed the profit after ads as if nothing were spent. Unknown is never zero (rule 24): with
 * Redis not configured the read is unknown, and each caller then says so or leaves the ad figures out. A store with
 * no stats id has no lines at all, as before. Synthetic world, no provider.
 */
import { readSpendLines, spendsForReport, spendsForStudio } from "@/lib/ad-spend";
import { UnknownReplyError } from "@/lib/redis-reply";
import { setRedisConfigured } from "./redis-off-world";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No provider in this test");
}) as typeof fetch;

const STATS = "adspendoff01";
const outcome = (work: Promise<unknown>) =>
  work.then(
    (value) => value,
    (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`),
  );

async function main() {
  part("Controls: a store with no stats id has no lines; a configured Redis with no lines has none, all known");
  is("no stats id", await readSpendLines(null), { spends: [], metaUnread: false });
  is("configured, no lines", await outcome(readSpendLines(STATS)), { spends: [], metaUnread: false });
  is("configured, the studio reads it known", await spendsForStudio(STATS), { spends: [], unread: null });

  part("Redis not configured: the spend is unknown, never an empty list taken for all of it");
  setRedisConfigured(false);
  is("readSpendLines throws as unknown", await outcome(readSpendLines(STATS)), "unknown");
  is("the studio says the typed lines are unread", await spendsForStudio(STATS), { spends: [], unread: "typed" });
  is("the weekly email gets no lines, so its ad figures are left out", await spendsForReport(STATS), []);
  is("no stats id is still no lines", await readSpendLines(null), { spends: [], metaUnread: false });
  setRedisConfigured(true);
}

main().then(done);
