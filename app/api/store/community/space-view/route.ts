import type { NextRequest } from "next/server";
import { storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { type Space, readConfigExactRaw, saveConfigIfSame } from "@/lib/community";

/** How many times the setup is read again when another save lands between the read and the write. */
const VIEW_TRIES = 3;

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
    if (!id) return fail("not_set_up");
    const spaceId = text(body.id, 12);
    const viewed = (space: Space): Space => {
      const rest: Space = { ...space };
      delete rest.shown;
      return view === "locked" ? { ...rest, shown: true } : rest;
    };
    // Written only over the setup as read (Codex X5's review of #3007): an edit saved meanwhile (another space, a
    // level, access) is read again and kept, with only this space's view changed on it, a few times at most.
    for (let attempt = 0; attempt < VIEW_TRIES; attempt += 1) {
      const read = await readConfigExactRaw(id);
      if (!read) return fail("not_set_up");
      const config = read.config;
      if (!config.spaces.some((s) => s.id === spaceId)) return fail("unknown", 404);
      const next = { ...config, spaces: config.spaces.map((s) => (s.id === spaceId ? viewed(s) : s)) };
      if (await saveConfigIfSame(id, read.raw, next)) return Response.json({ ok: true, config: next });
    }
    return fail("busy", 409);
  } catch (error) {
    console.error("changing how a community space is shown failed", error);
    return fail("server_error", 500);
  }
}
