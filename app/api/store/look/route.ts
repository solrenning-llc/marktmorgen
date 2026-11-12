import type { NextRequest } from "next/server";
import { updateLook } from "@/lib/store";
import { isFont, isBackdrop, isTheme, normaliseHex } from "@/lib/store-look";
import { canUse } from "@/lib/plan";
import { guardStoreWrite } from "@/lib/store-request";

/** Changes the theme, the colour, the letters, the footer badge and the bought count of the creator's public page. */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "page");
  if (!guarded.ok) return guarded.response;

  const theme = guarded.body.theme;
  const accent = normaliseHex(guarded.body.accent);
  if (!isTheme(theme)) {
    return Response.json({ ok: false, error: "theme" }, { status: 400 });
  }
  if (!accent) {
    return Response.json({ ok: false, error: "accent" }, { status: 400 });
  }

  /*
   * Taking our name off the page is the one thing here that is sold.
   *
   * The public page asks the plan again every time it is drawn, so a store
   * that is not on Pro would show the badge whatever this field said — but
   * a setting that can be written and then silently ignored is a setting
   * that lies to the creator who set it. A store without the feature is
   * told so here, and nothing is saved.
   */
  const badge = guarded.body.badge !== false;
  if (!badge && !canUse(guarded.store, "branding")) {
    return Response.json({ ok: false, error: "plan" }, { status: 403 });
  }

  try {
    // Left unsaid, the letters stay as they are.
    const font = isFont(guarded.body.font) ? guarded.body.font : guarded.store.look.font;
    // And the backdrop too.
    const backdrop = isBackdrop(guarded.body.backdrop) ? guarded.body.backdrop : guarded.store.look.backdrop;
    // The store-age line (lib/store-trust.ts): left unsaid, it stays as it is.
    const since = typeof guarded.body.since === "boolean" ? guarded.body.since : guarded.store.look.since === true;
    const result = await updateLook(guarded.ref, { theme, accent, badge, sold: guarded.body.sold === true, since, font, backdrop });
    if (!result.ok) {
      return Response.json({ ok: false, error: result.reason }, { status: 400 });
    }
    return Response.json({ ok: true, look: result.store.look });
  } catch (error) {
    console.error("saving the store look failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
