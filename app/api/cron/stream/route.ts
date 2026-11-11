import { sweepAutoCaptions } from "@/lib/auto-captions";
import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { withCutoff } from "@/lib/fetch-timeout";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { isStreamConfigured, sweep } from "@/lib/stream";
import { measureDue } from "@/lib/watch";

export const maxDuration = 60;

/**
 * Run every five minutes by Vercel, at minutes 4, 9, … 59, so it does not
 * start with the email job or the imports: asks the video service about each
 * lesson video that is still being prepared, takes away the ones whose
 * upload was started and never finished, and tries again to delete the ones
 * a creator removed while the service could not be reached (lib/stream.ts).
 * Then it reads, for each store whose lessons are being watched, how long
 * its video has been watched, about once an hour a store (lib/watch.ts).
 *
 * Does nothing, and says so, until the service is set up.
 */
export async function GET(request: NextRequest) {
  return withCutoff(Date.now() + 57_000, () => run(request));
}

async function run(request: NextRequest): Promise<Response> {
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured()) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  if (!isStreamConfigured()) return Response.json({ ok: true, off: true }, { headers: { "Cache-Control": "no-store" } });
  const lockReceipt = await redisPipeline([["SET", "nl:stream:lock", "1", "NX", "EX", 90]]);
  if (Array.isArray(lockReceipt) && lockReceipt.length === 1 && lockReceipt[0] === null) return Response.json({ ok: true, busy: true });
  if (!Array.isArray(lockReceipt) || lockReceipt.length !== 1 || lockReceipt[0] !== "OK") return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  try {
    const counts = await sweep(Date.now() + 35_000);
    if (counts.looked || counts.deleted) {
      console.log(`stream: looked at ${counts.looked}, ${counts.ready} ready, ${counts.failed} failed, ${counts.deleted} deleted`);
    }
    // Captions being written by AI, asked after until they are all there (lib/auto-captions.ts).
    const captions = await sweepAutoCaptions(Date.now() + 8_000);
    if (captions.done) console.log(`captions: ${captions.done} request(s) settled`);
    const watched = await measureDue(Date.now() + 15_000);
    if (watched.read) console.log(`watch: read ${watched.read} store(s), ${watched.seconds} second(s) of video watched since the reading before`);
    return Response.json({ ok: true, ...counts, captions, watched }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("the video job failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  } finally {
    await redisPipeline([["DEL", "nl:stream:lock"]]).catch(() => {});
  }
}
