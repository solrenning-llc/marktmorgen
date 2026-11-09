import type { NextRequest } from "next/server";
import { creatorFrom } from "@/lib/studio-route";
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

  try {
    // Contacts kept but unreadable (rule 24): the readable ones are handed over, and the file's name says it is not the
    // whole list ("-partial", as the sales file says it), never a file given as the list without a word.
    const read = await listAsCsv(store, onlyAgreed).then(
      (csv) => ({ csv, partial: false }),
      (error: unknown) => {
        if (error instanceof ListNotWholeError) return { csv: error.csv, partial: true };
        throw error;
      },
    );
    const csv = read.csv;
    const day = new Date().toISOString().slice(0, 10);
    const name = `${store.handle}-${onlyAgreed ? "agreed" : "everyone"}-${day}${read.partial ? "-partial" : ""}.csv`;
    // The byte-order mark makes Excel read the file as UTF-8, so a name with
    // an accent arrives with its accent. Every email tool ignores it.
    return new Response(`\uFEFF${csv}`, {
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
