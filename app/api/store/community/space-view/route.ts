import type { NextRequest } from "next/server";
import { storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { type Space, readConfig, saveConfig } from "@/lib/community";

/**
 * How a space kept for some buyers looks to a member without one of its
 * products (542 [CM1]): `{ id, view: "hidden" }`, no sign of it (the default),
 * or `{ id, view: "locked" }`, its name and one line, locked, with the way to
 * buy in (lib/community-locked.ts). Who may come in does not change: that is
 * still the products the space is kept for, asked by maySeeSpace.
 *
 * Setting the community up, so the store's settings permission, as the rest
 * of the space's form (app/api/store/community/manage). Found through the
 * creator's own store; a setup that could not be read is never written over.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 1_000);
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  const view = text(body.view, 10);
  if (view !== "hidden" && view !== "locked") return fail("invalid");
  try {
    const store = await storeForEmail(ref);
    if (!store) return fail("none");
    const id = store.community?.id;
    const config = id ? await readConfig(id) : null;
    if (!id || !config) return fail("not_set_up");
    const spaceId = text(body.id, 12);
    if (!config.spaces.some((s) => s.id === spaceId)) return fail("unknown", 404);
    const viewed = (space: Space): Space => {
      const rest: Space = { ...space };
      delete rest.shown;
      return view === "locked" ? { ...rest, shown: true } : rest;
    };
    const next = { ...config, spaces: config.spaces.map((s) => (s.id === spaceId ? viewed(s) : s)) };
    await saveConfig(id, next);
    return Response.json({ ok: true, config: next });
  } catch (error) {
    console.error("changing how a community space is shown failed", error);
    return fail("server_error", 500);
  }
}
