import type { NextRequest } from "next/server";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { startChat, tokenHandle, visitorSend, visitorThread } from "@/lib/inbox";
import { takePublicRequest } from "@/lib/traffic";

const MAX_BODY_BYTES = 8_000;

/**
 * The chat on a store's pages (lib/inbox.ts), for visitors:
 * `{ action: "start", handle, email, name, text }` begins a conversation,
 * `{ action: "send", token, text }` writes in it again, and
 * `{ action: "read", token }` is what the open chat asks every so often for
 * the store's answer. The token is the visitor's alone; nothing else opens a
 * conversation from here.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await (await limited(request, MAX_BODY_BYTES)).json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  const answer = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  try {
    if (body.action === "read") {
      // Each read the open chat makes is one of its store's public requests (lib/traffic.ts).
      const handle = await tokenHandle(body.token);
      const store = handle ? await storeForHandle(handle) : null;
      if (!store) return answer({ ok: false, error: "gone" }, 404);
      if (!(await takePublicRequest(store, "buyer"))) return answer({ ok: false, error: "limited" }, 429);
      const thread = await visitorThread(body.token);
      return thread ? answer({ ok: true, thread }) : answer({ ok: false, error: "gone" }, 404);
    }
    if (body.action === "start") {
      // A field no person can see: whatever filled it in is told it worked, and nothing is kept.
      if (typeof body.website === "string" && body.website.trim()) return answer({ ok: false, error: "closed" }, 400);
      const handle = normaliseHandle(typeof body.handle === "string" ? body.handle : "");
      const store = handle ? await storeForHandle(handle) : null;
      if (!store) return answer({ ok: false, error: "closed" }, 404);
      const result = await startChat({ store, email: body.email, name: body.name, text: body.text, ip: clientAddress(request) });
      return result.ok ? answer({ ok: true, thread: result.thread }) : answer({ ok: false, error: result.reason }, result.reason === "limited" ? 429 : result.reason === "error" ? 503 : 400);
    }
    if (body.action === "send") {
      const result = await visitorSend(body.token, body.text, (handle) => storeForHandle(handle));
      return result.ok ? answer({ ok: true, thread: result.thread }) : answer({ ok: false, error: result.reason }, result.reason === "limited" ? 429 : result.reason === "error" ? 503 : 400);
    }
    return answer({ ok: false, error: "invalid" }, 400);
  } catch (error) {
    console.error("the store chat failed", error);
    return answer({ ok: false, error: "error" }, 500);
  }
}
