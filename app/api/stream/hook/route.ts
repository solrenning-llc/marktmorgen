import type { NextRequest } from "next/server";
import { clientAddress, limited, withinEssentialLimit } from "@/lib/request-guard";
import { believed, heard, isStreamConfigured, streamConfig } from "@/lib/stream";
import { syncAutoCaptions } from "@/lib/auto-captions";

/** An announcement is three short fields. Anything bigger is not one. */
const MAX_BODY_BYTES = 4_000;
/** Announcements one address may make in a minute: a course uploaded at once makes several per video. */
const PER_MINUTE = 600;

export const maxDuration = 30;

/**
 * The video service's announcement that something happened to a lesson's
 * video: its file arrived, a size of it is ready, it could not be read
 * (lib/stream.ts).
 *
 * Not found until the service is set up with the key it signs these with.
 * An announcement is believed only when that signature is right, and even
 * then nothing in it is taken as fact: it names a video, and the service is
 * asked about that video. So one sent twice, or late, or out of order, does
 * what one sent once does. The five-minute job asks about every video that
 * is waiting in any case (app/api/cron/stream), so one that never arrives
 * costs a few minutes and nothing else.
 */
export async function POST(request: NextRequest) {
  const config = streamConfig();
  if (!config || !config.readKey || !isStreamConfigured()) return new Response("Not found.", { status: 404 });
  if (!(await withinEssentialLimit("stream-hook", clientAddress(request), PER_MINUTE, 60))) {
    return Response.json({ ok: false }, { status: 429 });
  }
  let body: string;
  try {
    body = await (await limited(request, MAX_BODY_BYTES)).text();
  } catch {
    return Response.json({ ok: false }, { status: 413 });
  }
  const signed = believed(
    body,
    {
      version: request.headers.get("x-bunnystream-signature-version"),
      algorithm: request.headers.get("x-bunnystream-signature-algorithm"),
      signature: request.headers.get("x-bunnystream-signature"),
    },
    config.readKey,
  );
  if (!signed) return Response.json({ ok: false }, { status: 401 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  try {
    const result = await heard(parsed);
    // Captions the service was asked to write are listed the moment it says so (lib/auto-captions.ts).
    const guid = (parsed as { VideoGuid?: unknown } | null)?.VideoGuid;
    if (result === "looked" && typeof guid === "string") await syncAutoCaptions(guid.toLowerCase());
    return Response.json({ ok: true, result });
  } catch (error) {
    // Answered as a failure, so the service sends it again.
    console.error("acting on a video announcement failed", error);
    return Response.json({ ok: false }, { status: 500 });
  }
}
