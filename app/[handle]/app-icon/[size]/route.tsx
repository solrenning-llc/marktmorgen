import { ImageResponse } from "next/og";
import { normaliseHandle, storeForVisitor } from "@/lib/store";
import { readPhoto } from "@/lib/store-photo";
import { lookColours } from "@/lib/store-look";
import { connectionRefusal, readRefusal } from "@/lib/picture-pace";
import { type IconSize, iconUrl, iconVersion, isIconSize, monogram } from "@/lib/store-app";

/**
 * A store's icon on a home screen, as a PNG at 180, 192 or 512 pixels.
 *
 * The creator's photo when there is one, cropped square and scaled; without
 * one, or when the photo cannot be scaled here, the first letter of the
 * store's name on the store's own colour. Either way it is drawn from what
 * the store already has, and its address carries a fingerprint of that
 * (lib/store-app.ts), so a browser may keep it for a year.
 *
 * It is drawn only at that address: any other query string, an old
 * fingerprint or none, is sent to it first, and what a function answers is
 * paced (lib/picture-pace.ts). Until 18 October 2026 every query string was
 * a photo read and a drawing, counted by nothing.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ handle: string; size: string }> },
) {
  const { handle: raw, size: file } = await params;
  const decoded = decodeURIComponent(raw);
  const match = /^(\d{3})\.png$/.exec(file);
  const size = match ? Number(match[1]) : 0;
  if (!decoded.startsWith("@") || !isIconSize(size)) return missing();
  const refused = connectionRefusal(request);
  if (refused) return refused;

  try {
    const store = await storeForVisitor(normaliseHandle(decoded));
    if (!store) return missing();
    // Drawn only at the address with today's fingerprint and nothing else, which
    // may be kept for good; any other is sent there, briefly, before anything
    // is read or drawn.
    if (new URL(request.url).search !== `?v=${iconVersion(store)}`) {
      return new Response(null, { status: 307, headers: { Location: iconUrl(store, size), "Cache-Control": "public, max-age=3600" } });
    }
    const busy = readRefusal(`icon:${store.handle}/${size}`);
    if (busy) return busy;
    const cache = "public, max-age=31536000, immutable";

    const photo = store.photoId ? await readPhoto(store.photoId).catch(() => null) : null;
    const drawn = photo ? await scaled(photo.bytes, size) : null;
    if (drawn) return png(drawn, cache);

    const colours = lookColours(store.look);
    const art = new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundImage: `linear-gradient(135deg, ${colours.accent}, ${colours.accent2})`,
            color: colours.onAccent,
            fontSize: Math.round(size * 0.5),
            lineHeight: 1,
          }}
        >
          {monogram(store)}
        </div>
      ),
      { width: size, height: size },
    );
    return png(new Uint8Array(await art.arrayBuffer()), cache);
  } catch (error) {
    console.error("drawing a store icon failed", error);
    return new Response("Try again in a moment.", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

/**
 * The photo, square and at the size asked. Photos are kept as WebP, which the
 * drawing library cannot read, so this uses the image library Next.js
 * installs alongside itself, and returns null where it is missing — the
 * caller then draws the letter instead of failing.
 */
async function scaled(bytes: Uint8Array, size: IconSize): Promise<Uint8Array | null> {
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(bytes).resize(size, size, { fit: "cover" }).png().toBuffer();
    return new Uint8Array(out);
  } catch (error) {
    console.error("scaling a store photo for its icon failed", error);
    return null;
  }
}

function png(bytes: Uint8Array, cache: string): Response {
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.length),
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function missing(): Response {
  return new Response("Not found.", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
