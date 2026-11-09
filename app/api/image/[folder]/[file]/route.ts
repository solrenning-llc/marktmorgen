import { get } from "@/lib/blob";
import { isFileHeld } from "@/lib/held-files";
import { canonicalPicture, connectionRefusal, readRefusal } from "@/lib/picture-pace";
import { IMAGE_FILE_PATTERN, IMAGE_FOLDER_PATTERN, imageType } from "@/lib/product-image";

/**
 * Serves a product picture.
 *
 * A picture's name is fresh every time one is uploaded and nothing may be
 * written over it, so what is behind one address never changes and may be
 * cached everywhere for a year. That keeps the requests every visitor makes
 * out of this function almost entirely.
 *
 * The type it is served as comes from its own name, which the upload was
 * held to and whose first bytes were checked when it was attached; the
 * browser is told not to guess, and the picture may not run, frame or fetch.
 *
 * An address with a query string is sent to the plain one before anything is
 * read, and what a function answers is paced (lib/picture-pace.ts): a query
 * string or a made-up name was a read every time, counted by nothing.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ folder: string; file: string }> },
) {
  const { folder, file } = await params;
  const missing = () =>
    new Response("Not found.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  if (!IMAGE_FOLDER_PATTERN.test(folder) || !IMAGE_FILE_PATTERN.test(file)) return missing();
  const refused = connectionRefusal(request) ?? canonicalPicture(request) ?? readRefusal(`image:${folder}/${file}`);
  if (refused) return refused;

  // A picture kept for a child-safety report is shown to nobody, and never cached (lib/held-files.ts).
  const held = await isFileHeld(`images/${folder}/${file}`).catch(() => null);
  if (held === null)
    return new Response("Try again in a moment.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  if (held) return missing();

  try {
    const found = await get(`images/${folder}/${file}`, { access: "private" });
    if (!found || found.statusCode !== 200 || !found.stream) return missing();
    return new Response(found.stream, {
      headers: {
        "Content-Type": imageType(file),
        ...(found.blob.size ? { "Content-Length": String(found.blob.size) } : {}),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  } catch (error) {
    console.error("serving a product picture failed", error);
    return new Response("Try again in a moment.", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
