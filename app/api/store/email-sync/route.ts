import { serviceRefusedJson, withinServiceWhy } from "@/lib/metered-limits";
import { type NextRequest, after } from "next/server";
import { noticeCreator } from "@/lib/account-notice";
import { ensureStatsId } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { MAX_KEY_LENGTH, PROVIDER_NAMES } from "@/lib/email-platforms";
import { connect, disconnect, refreshTargets, saveSettings, syncView, testConnection } from "@/lib/email-sync";

/** Settings with a few tags for every product fit well inside this. */
const MAX_BODY_BYTES = 40_000;
/** Requests one store may make here in a minute: each one asks the email platform something. */
const PER_MINUTE = 20;

/**
 * The creator's email platform (lib/email-sync.ts): connect one with an API
 * key (checked with the platform, then sealed; it never comes back in any
 * answer), read its audiences again, save who is sent where, test the
 * connection, or disconnect it.
 */
export async function POST(request: NextRequest) {
  // Where buyers' details are sent is a setting: the owner and Admins (lib/team-roles.ts).
  const guarded = await guardStoreWrite(request, "settings", MAX_BODY_BYTES);
  if (!guarded.ok) return guarded.response;

  try {
    const loaded = guarded.store;
    const action = text(guarded.body.action, 20);
    // A supported legacy store may have no statistics id and therefore no
    // connection. Withdrawing an absent connection must not create that id.
    if (action === "disconnect" && !loaded.statsId) {
      return Response.json({ ok: true, view: await disconnect(loaded) });
    }
    const store = loaded.statsId ? loaded : await ensureStatsId(guarded.ref);
    if (!store || !store.statsId) return Response.json({ ok: false, error: "none" }, { status: 400 });
    // Every action but disconnecting reaches the platform, so they are counted.
    const refused = action === "disconnect" ? null : await withinServiceWhy("esync", store.statsId, PER_MINUTE, 60, store);
    if (refused) return serviceRefusedJson(refused, "limited");

    if (action === "connect") {
      const before = (await syncView(store)).connected;
      const result = await connect(store, guarded.body.provider, text(guarded.body.key, MAX_KEY_LENGTH + 1));
      if (!result.ok) return Response.json({ ok: false, error: "refused", message: result.message }, { status: 400 });
      const now = result.view.connected;
      // Buyers' details can leave through it, so a new connection is reported
      // to the creator's inbox (lib/account-notice.ts), as a webhook is.
      if (now && (!before || before.provider !== now.provider || before.last4 !== now.last4)) {
        after(() => noticeCreator(store, { kind: "email-platform-connected", name: PROVIDER_NAMES[now.provider] }));
      }
      return Response.json({ ok: true, view: result.view, targets: result.targets });
    }
    if (action === "targets") {
      const result = await refreshTargets(store);
      if (!result.ok) return Response.json({ ok: false, error: "refused", message: result.message }, { status: 400 });
      return Response.json({ ok: true, targets: result.targets });
    }
    if (action === "save") {
      const body = guarded.body;
      const result = await saveSettings(store, {
        target: text(body.target, 80),
        free: body.free,
        buyers: body.buyers,
        products: body.products,
        tags: body.tags,
      });
      if (!result.ok) return Response.json({ ok: false, error: "refused", message: result.message }, { status: 400 });
      return Response.json({ ok: true, view: result.view });
    }
    if (action === "test") {
      const result = await testConnection(store);
      return Response.json({ ok: true, working: result.ok, message: result.message, view: result.view });
    }
    if (action === "disconnect") {
      // Reading the label for the courtesy notice is not a precondition for
      // forgetting the key and stopping future buyer-data sends.
      const before = await syncView(store).then((view) => view.connected).catch(() => undefined);
      const view = await disconnect(store);
      if (before !== null) after(() => noticeCreator(store, { kind: "email-platform-removed", name: before ? PROVIDER_NAMES[before.provider] : "Your email platform" }));
      return Response.json({ ok: true, view });
    }
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    console.error("changing the email platform failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
