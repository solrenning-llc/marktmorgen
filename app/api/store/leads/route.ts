import type { NextRequest } from "next/server";
import { creatorFrom } from "@/lib/studio-route";
import { holdListDownload } from "@/lib/list-download";
import { listAsCsv } from "@/lib/free";

/**
 * The creator's list, as a file they can take anywhere.
 *
 * Theirs at any time, in a format every email tool imports, with nothing to
 * ask for and nobody to wait on. A list a creator cannot take with them is a
 * list that keeps them here, and that is the kind of lock this company does
 * not build.
 *
 * Only the owner, and an Admin, reach it (lib/team-roles.ts, "export"): the
 * list id is read from the store's own record, and nothing in the request
 * names which list to read.
 */
export async function GET(request: NextRequest) {
  const creator = await creatorFrom(request, "export");
  if (creator instanceof Response) return creator;
  const { store } = creator;

  const onlyAgreed = request.nextUrl.searchParams.get("who") === "agreed";

  // The whole list is read and sent, so its size is counted first and its units taken from the studio figure
  // before any of it is read (lib/list-download.ts, R31); refused, with nothing read, when either cannot be done.
  const held = await holdListDownload(store);
  if (!held.ok) return new Response(held.message, { status: held.status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

  try {
    const csv = await listAsCsv(store, onlyAgreed);
    const day = new Date().toISOString().slice(0, 10);
    const name = `${store.handle}-${onlyAgreed ? "agreed" : "everyone"}-${day}.csv`;
    // The byte-order mark makes Excel read the file as UTF-8, so a name with
    // an accent arrives with its accent. Every email tool ignores it.
    const body = `\uFEFF${csv}`;
    await held.settle(new TextEncoder().encode(body).length);
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("exporting a list failed", error);
    return new Response("We could not read your list right now. Try again in a moment.", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
