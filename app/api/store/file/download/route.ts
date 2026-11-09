import type { NextRequest } from "next/server";
import { get } from "@/lib/blob";
import { fileUrl } from "@/lib/file-store";
import { isVaultPath } from "@/lib/vault-rules";
import { type Refusal, studioAccess } from "@/lib/studio-route";
import { productFile } from "@/lib/store";
import {
  DOWNLOAD_URL_SECONDS,
  REDIRECT_ABOVE_BYTES,
} from "@/lib/product-file";
import { recordDelivery } from "@/lib/delivery";
import { isRedisConfigured } from "@/lib/redis";
import { fileHeaders } from "@/lib/request-guard";
import { holdState } from "@/lib/child-safety";

/**
 * Gives the creator back the file they uploaded.
 *
 * A creator who cannot open what they just uploaded has no way of knowing
 * whether their buyers will get the right thing, so this exists before any
 * buyer does. It is the same path a sale will take later: the file is fetched
 * from the private store by us, after we have decided the asker is allowed it,
 * and streamed on. The blob's own URL is never handed out, because a URL that
 * works is a URL that can be forwarded.
 */

/**
 * A short-lived URL the buyer's browser can fetch straight from storage.
 *
 * Used for large files only. It keeps the bytes out of this function, which
 * halves what delivery costs and removes the time limit a long download on a
 * slow line would otherwise hit. The URL expires in minutes and is signed for
 * one pathname, so forwarding it buys very little.
 */
async function signedDownload(pathname: string, name: string): Promise<string | null> {
  return fileUrl(pathname, DOWNLOAD_URL_SECONDS, name);
}

export async function GET(request: NextRequest) {
  if (!isRedisConfigured()) {
    return new Response("Stores are not switched on yet.", { status: 503 });
  }

  const access = await studioAccess(request, "products");
  if (!access.ok) {
    // Every refusal has its words, so none of them can turn into a server error.
    const words: Record<Refusal, [string, number]> = {
      signed_out: ["Log in first.", 401],
      no_store: ["There is no store here yet.", 404],
      forbidden: ["Your role on this store does not include its files.", 403],
      gone: ["That store is not one you can open.", 403],
      used: [access.message || "This store's studio requests for now are used. Try again later.", 429],
      locked: ["You got in without your second step, so this waits until two-step login turns off. The date is at the top of your studio.", 403],
      two_step: ["This store asks everyone on its team to turn on two-step login first.", 403],
    };
    const [text, status] = words[access.reason];
    return new Response(text, { status });
  }
  const ref = access.access.ref;

  const id = request.nextUrl.searchParams.get("id") ?? "";
  if (!id) return new Response("Which file?", { status: 400 });

  // The file of a product held for a child-safety report (lib/child-safety.ts) is the store's owner's only:
  // nobody else on the team downloads it. A hold that cannot be read is not a yes.
  if (access.access.role !== "owner") {
    const hold = await holdState(access.access.store, id);
    if (hold === "held") return new Response("This product is on hold, so only the store's owner can download its file.", { status: 403, headers: { "Cache-Control": "private, no-store" } });
    if (hold === "unknown") return new Response("We could not check this file right now. Try again in a moment.", { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }

  const found = await productFile(ref, id);
  if (!found) return new Response("No file on that product.", { status: 404 });

  if (found.file.bytes > REDIRECT_ABOVE_BYTES || isVaultPath(found.file.pathname)) {
    const url = await signedDownload(found.file.pathname, found.file.name);
    if (!url) {
      return new Response("We could not fetch the file right now.", {
        status: 502,
      });
    }
    // A creator pulling their own file costs exactly what a buyer pulling it
    // costs, so it is counted the same way rather than quietly excused.
    await recordDelivery(found.file.pathname, found.file.bytes);
    return new Response(null, {
      status: 302,
      headers: { Location: url, "Cache-Control": "private, no-store" },
    });
  }

  try {
    const result = await get(found.file.pathname, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return new Response("The file is not there anymore.", { status: 404 });
    }

    await recordDelivery(found.file.pathname, found.file.bytes);
    return new Response(result.stream, { headers: fileHeaders(found.file.contentType, found.file.name) });
  } catch (error) {
    console.error("reading a file failed", error);
    return new Response("We could not fetch the file right now.", {
      status: 502,
    });
  }
}
