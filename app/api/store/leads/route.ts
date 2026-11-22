import type { NextRequest } from "next/server";
import { creatorFrom } from "@/lib/studio-route";
import { ListDownloadRefused, holdListDownload } from "@/lib/list-download";
import { ListNotWholeError, listAsCsv } from "@/lib/free";

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
    // Each read held before it is made and counted at what it moved; the file held before it is sent.
    // Contacts kept but unreadable (rule 24): the readable ones are handed over, and the file's name says it is not the
    // whole list and how many were left out ("-partial", as the sales file says it, then "-3-contacts-not-read"),
    // never a file given as the list without a word. The count is in the name, not in the file, so every email tool
    // still imports the file as it is.
    const read = await listAsCsv(store, onlyAgreed, held.read).then(
      (csv) => ({ csv, unreadable: 0 }),
      (error: unknown) => {
        if (error instanceof ListNotWholeError) return { csv: error.csv, unreadable: Math.max(1, error.unreadable) };
        throw error;
      },
    );
    const csv = read.csv;
    const day = new Date().toISOString().slice(0, 10);
    const left = read.unreadable ? `-partial-${read.unreadable}-${read.unreadable === 1 ? "contact" : "contacts"}-not-read` : "";
    const name = `${store.handle}-${onlyAgreed ? "agreed" : "everyone"}-${day}${left}.csv`;
    // The byte-order mark makes Excel read the file as UTF-8, so a name with
    // an accent arrives with its accent. Every email tool ignores it.
    const body = `\uFEFF${csv}`;
    await held.send(new TextEncoder().encode(body).length);
    await held.settle();
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
    // What was read is paid for, the rest given back; a read or the file the figure could not hold is said as such.
    await held.settle();
    if (error instanceof ListDownloadRefused) return new Response(error.message, { status: error.status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    console.error("exporting a list failed", error);
    return new Response("We could not read your list right now. Try again in a moment.", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
