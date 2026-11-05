import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { MAX_KEY_NAME, listKeys, makeKey, revokeKey } from "@/lib/api-keys";
import { can } from "@/lib/team-roles";

/**
 * Making and revoking the keys a creator's own tools read the store with.
 *
 * `{ action: "make", name }` returns the key — the only time it is ever sent
 * whole. `{ action: "revoke", id }` takes one away at once.
 *
 * The same permission as taking the list away as a file ("export",
 * lib/team-roles.ts): the owner and an Admin. A key reads the same things an
 * export does, so it is handed out by the same people. A key that may also
 * write (`write: true`) gives products and adds people to the list, as an
 * import does, so it also needs the permission to import.
 */
/**
 * The list after a change that was made: a list that cannot be read is sent
 * as null, and the studio says it could not read the keys (audit SG2,
 * finding 23). The change itself is never answered as failed for it.
 */
const listAfter = (sid: string) =>
  listKeys(sid).catch((error: unknown) => {
    console.error("reading the API keys after a change failed", error);
    return null;
  });

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "export");
  if (!guarded.ok) return guarded.response;
  const { store, body, role } = guarded;
  const action = text(body.action, 10);

  try {
    if (action === "make") {
      const write = body.write === true;
      if (write && !can(role, "import")) return Response.json({ ok: false, error: "role" }, { status: 403 });
      const made = await makeKey(store.sid, text(body.name, MAX_KEY_NAME * 2), Date.now(), write);
      if (!made.ok) return Response.json({ ok: false, error: made.reason }, { status: made.reason === "unavailable" ? 503 : 400 });
      return Response.json(
        { ok: true, key: made.key, made: made.made, keys: await listAfter(store.sid) },
        // A key in a cached response is a key in somebody's cache.
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (action === "revoke") {
      const gone = await revokeKey(store.sid, text(body.id, 20));
      if (!gone) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
      return Response.json({ ok: true, keys: await listAfter(store.sid) }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    console.error("changing an API key failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
