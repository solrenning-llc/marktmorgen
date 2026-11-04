import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { addNumbersLink, removeNumbersLink } from "@/lib/store";
import { LINK_ID, indexLink, linkStore, makeLink, unindexLink } from "@/lib/numbers-links";
import { readVerified, refreshVerified } from "@/lib/verified-numbers";
import { SITE_URL } from "@/lib/site-url";

/**
 * Read-only links to the store's counted numbers (lib/numbers-links.ts):
 * `{ action: "create", label, password, days, money }` or
 * `{ action: "remove", id }`. For whoever may change settings.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings");
  if (!guarded.ok) return guarded.response;
  const { ref, body, store } = guarded;
  try {
    if (body.action === "remove") {
      const id = typeof body.id === "string" && LINK_ID.test(body.id) ? body.id : "";
      if (!id) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      // The public index is let go only for this store's own link: one in its
      // record as read for this request, or one the index already names it
      // for. Another store's id changes nothing and answers as an unknown one
      // does (the list is filtered by an id it does not hold).
      const own = (store.numbersLinks ?? []).some((link) => link.id === id) || (Boolean(store.sid) && (await linkStore(id)) === store.sid);
      const done = await removeNumbersLink(ref, id);
      if (own) await unindexLink(id);
      if (!done.ok) return Response.json({ ok: false, error: done.reason }, { status: 404 });
      return Response.json({ ok: true, id });
    }
    if (body.action !== "create") return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    if (!store.sid) return Response.json({ ok: false, error: "none" }, { status: 404 });
    const now = Date.now();
    const made = makeLink({ label: body.label, password: body.password, days: body.days, money: body.money }, now);
    if (!made.ok) return Response.json({ ok: false, error: made.reason }, { status: 400 });
    const added = await addNumbersLink(ref, made.link, now);
    if (!added.ok) return Response.json({ ok: false, error: added.reason }, { status: 400 });
    await indexLink(store.sid, made.link, now);
    // The numbers it shows: read now the first time, then once a day (lib/verified-numbers.ts).
    if (!(await readVerified(added.store).catch(() => null))) await refreshVerified(added.store).catch((error) => console.error("reading the counted numbers failed", error));
    const { id, label, expires, money, made: created } = made.link;
    return Response.json({ ok: true, link: { id, label, expires, money, made: created, url: `${SITE_URL}/numbers/${id}` } });
  } catch (error) {
    console.error("saving a numbers link failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
