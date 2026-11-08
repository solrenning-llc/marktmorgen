import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { ensureStatsId } from "@/lib/store";
import { readTitles } from "@/lib/catalog";
import { addLink, removeLink, retarget } from "@/lib/short-links";

/**
 * The store's short links for posts (lib/short-links.ts), for whoever may
 * work on its pages: `{ action: "add", name, place, target }` makes one,
 * `{ action: "target", code, target }` changes where it goes, and
 * `{ action: "remove", code }` ends it. A target is `{ kind: "store" }` or
 * `{ kind: "product", id }` or a ready cart, `{ kind: "cart", ids, code? }`
 * (624 [SZ8](23)). Answers the list as it is after.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "page", 1_000);
  if (!guarded.ok) return guarded.response;
  const { body } = guarded;
  try {
    const store = guarded.store.statsId ? guarded.store : await ensureStatsId(guarded.store.email);
    if (!store?.statsId || !store.sid) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    const titles = body.action === "remove" ? new Map<string, string>() : await readTitles(store);
    const isProduct = (id: string) => titles.has(id);
    const answer = (links: unknown) => Response.json({ ok: true, links }, { headers: { "Cache-Control": "no-store" } });
    if (body.action === "add") {
      const added = await addLink({ sid: store.sid, statsId: store.statsId }, { name: body.name, place: body.place, target: body.target }, isProduct);
      if (!added.ok) return Response.json({ ok: false, error: added.reason }, { status: added.reason === "unavailable" ? 503 : 400 });
      return answer(added.links);
    }
    if (body.action === "target") {
      const links = await retarget(store.statsId, body.code, body.target, isProduct);
      return links ? answer(links) : Response.json({ ok: false, error: "target" }, { status: 400 });
    }
    if (body.action === "remove") return answer(await removeLink(store.statsId, body.code));
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    console.error("changing a short link failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
