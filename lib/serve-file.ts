/**
 * Handing a stored file to whoever has earned it.
 *
 * Two doors lead here — a paid order and a free copy asked for by email — and
 * both decide for themselves whether the person in front of them may have the
 * file. What happens after that decision is the same for both, so it lives in
 * one place: a door that serves files its own way is a door that one day
 * serves them differently.
 */
import { get } from "@/lib/blob";
import { fileUrl } from "@/lib/file-store";
import { isFileHeld } from "@/lib/held-files";
import { isVaultPath } from "@/lib/vault-rules";
import {
  DOWNLOAD_URL_SECONDS,
  REDIRECT_ABOVE_BYTES,
  type ProductFile,
} from "@/lib/product-file";
import { folderFromPathname, freeDeliveryPause, recordDelivery } from "@/lib/delivery";
import { fileHeaders } from "@/lib/request-guard";

/** A short answer in plain text, never cached and never indexed. */
export function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

/** A free copy whose month's count could not be read or written: refused, and said so truthfully. */
function notChecked(): Response {
  return plain(503, "We couldn't check this download right now. Please try again in a few minutes.");
}

/**
 * A short-lived URL the browser can fetch straight from storage.
 *
 * Used for large files only. It keeps the bytes out of this function, which
 * halves what delivery costs and removes the time limit a long download on a
 * slow line would otherwise hit. The URL expires in minutes and is signed for
 * one pathname, so forwarding it buys very little.
 */
async function signedDownload(file: ProductFile): Promise<string | null> {
  return fileUrl(file.pathname, DOWNLOAD_URL_SECONDS, file.name);
}

/**
 * Sends the file, or the answer that says why it could not be sent.
 *
 * Big files go straight from storage. Small ones come through here, because
 * that is what lets us set the name it saves as and force a download rather
 * than opening in a tab. Either way the delivery is counted against the
 * store's month, since that is the one cost that grows with use.
 */
export async function serveFile(
  file: ProductFile,
  { paid = true }: { paid?: boolean } = {},
): Promise<Response> {
  // A file kept for a child-safety report goes to nobody, paid or not, and the answer does not say why
  // (lib/held-files.ts); a mark that cannot be read hands nothing out.
  const held = await isFileHeld(file.pathname).catch(() => null);
  if (held === null) return notChecked();
  if (held) return plain(404, "This file is not available.");
  /*
    The one place a delivery is ever refused, and it is never a paid one.

    A file somebody bought goes out at any number: taking the money and then
    not completing the sale is the thing this company is supposed to be the
    opposite of. A free copy is different — nobody paid for it, so a free
    file that finds its way somewhere it was not meant to go can run up
    thousands of dollars against a $29 subscription with no sale anywhere in
    it. Those pause by themselves, far above the published allowance, and
    start again when the month turns.

    `paid` defaults to true so that a new door added later errs toward
    serving the file rather than toward refusing somebody who paid.
  */
  if (!paid) {
    const folder = folderFromPathname(file.pathname);
    const pause = folder ? await freeDeliveryPause(folder) : "open";
    if (pause === "over") {
      return plain(
        429,
        // Only what is true at this moment: free copies pause past FREE_PAUSE_ABOVE_BYTES, while the creator is
        // written to only past the larger delivery allowance (app/api/cron/usage), so the page never says they were told.
        "This free download is paused until next month. This store has reached its free download allowance for this month. Anything you have bought is unaffected. Please try again next month or contact the creator.",
      );
    }
    // The counter could not be read (CX-123 rule 24): a free copy is not handed out on an unknown count, and the
    // buyer is told only what is true. Nothing was decided about the store, and nobody was told.
    if (pause === "unknown") return notChecked();
  }

  // A file in the store that charges nothing to send goes straight from it
  // whatever its size: that store saves it under the creator's own name by
  // itself, and a byte that never passes through here costs nothing twice.
  if (file.bytes > REDIRECT_ABOVE_BYTES || isVaultPath(file.pathname)) {
    const url = await signedDownload(file);
    if (!url) return plain(502, "We could not fetch the file right now.");
    // A free copy goes out only counted; a paid one goes out whatever the counter says.
    if (!(await recordDelivery(file.pathname, file.bytes)) && !paid) return notChecked();
    return new Response(null, {
      status: 302,
      headers: { Location: url, "Cache-Control": "private, no-store" },
    });
  }

  try {
    const result = await get(file.pathname, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return plain(404, "The file is not there anymore.");
    }

    if (!(await recordDelivery(file.pathname, file.bytes)) && !paid) {
      await result.stream.cancel().catch(() => {});
      return notChecked();
    }
    // Saved, never opened as a page of ours: the name is encoded so any
    // character survives, and the file may run nothing (lib/request-guard.ts).
    return new Response(result.stream, { headers: fileHeaders(file.contentType, file.name) });
  } catch (error) {
    console.error("serving a file failed", error);
    return plain(502, "We could not fetch the file right now.");
  }
}
