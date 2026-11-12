/**
 * A booking's move is kept until well after the call it moved to
 * (lib/call-records.ts writeMove). It was kept a flat 200 days, but a dated
 * session has no limit on how far ahead it may be: a move to one 250 days
 * ahead expired first, and the booking then read as never moved (its old
 * time shown, MAX_MOVES bypassed, an affiliate lead's end read early).
 * Synthetic sessions on the in-memory store only.
 */
import { readMoves, writeMove } from "@/lib/call-records";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const H = 3_600_000;

async function main(): Promise<void> {
part("a move to a time far ahead outlives the call");
{
  const start = Math.floor((Date.now() + 250 * DAY) / 60_000) * 60_000;
  await writeMove("cs_test_far", { s: start, e: start + H, n: 1 });
  const [ttl] = await redis.pipeline([["TTL", "nl:call:moved:cs_test_far"]]);
  is("kept at least until the call it moved to has ended", Number(ttl) * 1000 >= start + H - Date.now(), true);
  is("kept 200 days past the call's end", Number(ttl) * 1000 >= start + H - Date.now() + 199 * DAY, true);
  is("read back as moved", (await readMoves(["cs_test_far"])).get("cs_test_far")?.s, start);
}

part("a move to a time soon keeps the flat 200 days");
{
  const start = Math.floor((Date.now() + 3 * DAY) / 60_000) * 60_000;
  await writeMove("cs_test_near", { s: start, e: start + H, n: 1 });
  const [ttl] = await redis.pipeline([["TTL", "nl:call:moved:cs_test_near"]]);
  is("kept at least 200 days", Number(ttl) >= 200 * 86_400 - 5, true);
  is("not kept past 200 days after the call's end", Number(ttl) * 1000 <= start + H - Date.now() + 200 * DAY + 5_000, true);
}

done();
}

void main();
