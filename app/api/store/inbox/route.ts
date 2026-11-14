import type { NextRequest } from "next/server";
import { StoreFullError } from "@/lib/store-full";
import { guardStoreWrite } from "@/lib/store-request";
import { setInboxSetting } from "@/lib/store";
import { readTeam } from "@/lib/team";
import { can } from "@/lib/team-roles";
import { assignTo, openConversation, readInbox, replyTo, setStatus, suggestReply } from "@/lib/inbox";
import { CONVERSATION_ID, parseInboxSetting } from "@/lib/inbox-rules";

/**
 * The studio's inbox (lib/inbox.ts), for whoever may answer buyers
 * ("orders": the owner, an Admin, Support):
 *
 *   { action: "list" }                     the conversations
 *   { action: "open", id }                 one, with its messages, marked read
 *   { action: "reply", id, text }          the answer: kept, and emailed to the visitor
 *   { action: "status", id, status }       "open" or "closed"
 *   { action: "assign", id, email }        given to one who may answer, or "" for nobody
 *   { action: "suggest", id }              a suggested answer (one of the month's writing jobs)
 *   { action: "saved", saved }             the saved replies
 *   { action: "chat", on }                 the chat on the store's pages, on or off ("settings")
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, (body) => (body.action === "chat" ? "settings" : "orders"), 40_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const answer = (value: Record<string, unknown>, status = 200) => Response.json({ ...value }, { status, headers: { "Cache-Control": "no-store" } });
  const refuse = (error: string, status = 400) => answer({ ok: false, error }, status);
  if (!store.statsId) return refuse("unavailable", 503);
  const id = typeof body.id === "string" && CONVERSATION_ID.test(body.id) ? body.id : "";
  try {
    switch (body.action) {
      case "list":
        return answer({ ok: true, conversations: await readInbox(store.statsId) });
      case "open": {
        const thread = id ? await openConversation(store.statsId, id, store) : null;
        return thread ? answer({ ok: true, thread }) : refuse("none", 404);
      }
      case "reply": {
        if (!id) return refuse("none", 404);
        const result = await replyTo(store, id, guarded.email, body.text);
        return result.ok ? answer({ ok: true, thread: result.thread, emailed: result.emailed }) : refuse(result.reason, result.reason === "none" ? 404 : result.reason === "error" ? 503 : result.reason === "limited" ? 429 : 400);
      }
      case "status": {
        const conversation = id ? await setStatus(store, id, body.status) : null;
        return conversation ? answer({ ok: true, conversation }) : refuse("none", 404);
      }
      case "assign": {
        const team = store.sid ? await readTeam(store.sid) : { members: [] };
        const allowed = [store.email, ...team.members.filter((m) => can(m.role, "orders")).map((m) => m.email)];
        const conversation = id ? await assignTo(store, id, body.email, allowed) : null;
        return conversation ? answer({ ok: true, conversation }) : refuse("assign");
      }
      case "suggest": {
        if (!id) return refuse("none", 404);
        const result = await suggestReply(store, id);
        return result.ok ? answer({ ok: true, text: result.value, left: result.left }) : refuse(result.reason, result.reason === "used" ? 429 : 400);
      }
      case "saved": {
        const next = parseInboxSetting({ ...store.inbox, saved: body.saved });
        const saved = await setInboxSetting(store.email, { ...store.inbox, saved: next.saved });
        return saved.ok ? answer({ ok: true, inbox: saved.store.inbox }) : refuse("none", 404);
      }
      case "chat": {
        const saved = await setInboxSetting(store.email, { ...store.inbox, chat: body.on === true });
        return saved.ok ? answer({ ok: true, inbox: saved.store.inbox }) : refuse("none", 404);
      }
      default:
        return refuse("invalid");
    }
  } catch (error) {
    // What does not fit in the store's data room is not written (lib/store-data.ts).
    if (error instanceof StoreFullError) return refuse("store_full", 409);
    console.error("the inbox failed", error);
    return refuse("server_error", 500);
  }
}
