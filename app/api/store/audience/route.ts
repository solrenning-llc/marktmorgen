import type { NextRequest } from "next/server";
import { creatorFrom } from "@/lib/studio-route";
import { LIST_UNSENT_RECORD_BYTES_PER_CONTACT, holdListDownload } from "@/lib/list-download";
import { buyerAudience } from "@/lib/ad-audience";

/**
 * The store's buyers who agreed to hear from the creator, as a file Meta and
 * TikTok take for a customer list (lib/ad-audience.ts). Addresses, so only
 * the owner and an Admin reach it (lib/team-roles.ts, "export").
 */
export async function GET(request: NextRequest) {
  const creator = await creatorFrom(request, "export");
  if (creator instanceof Response) return creator;
  const { store } = creator;
  // The whole list is walked for its buyers, so its size is counted first and its units taken from the studio figure
  // before any of it is read (lib/list-download.ts, R31); refused, with nothing read, when either cannot be done.
  const held = await holdListDownload(store);
  if (!held.ok) return new Response(held.message, { status: held.status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  try {
    const { csv, rows } = await buyerAudience(store);
    // Settled at what was sent and at the buyers the file holds: everyone else on the list was read for it too (their
    // records only: the audience reads none of the store's fields).
    await held.settle(new TextEncoder().encode(csv).length, rows, LIST_UNSENT_RECORD_BYTES_PER_CONTACT);
    const day = new Date().toISOString().slice(0, 10);
    // No byte-order mark: the addresses are plain letters, and an upload form need not know what one is.
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${store.handle}-buyers-audience-${day}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("making the buyers audience failed", error);
    return new Response("We could not read your list right now. Try again in a moment.", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
