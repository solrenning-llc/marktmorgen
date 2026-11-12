import type { NextRequest } from "next/server";
import { StoreFullError } from "@/lib/store-full";
import { guardStoreWrite } from "@/lib/store-request";
import { setInboxSetting } from "@/lib/store";
import { readTeam } from "@/lib/team";
import { can } from "@/lib/team-roles";
import { assignTo, conversationOf, openConversation, readInbox, replyTo, setStatus, suggestReply } from "@/lib/inbox";
import { blockPerson, blockedState, unblockPerson } from "@/lib/buyer-block";
import { REFUND_HISTORY_PER_DAY, REFUND_HISTORY_UNITS, refundHistory } from "@/lib/buyer-history";
import { withinLimit } from "@/lib/request-guard";
import { countStudio } from "@/lib/studio-route";
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
 *   { action: "blocked", id }              whether the person of a conversation is blocked, and why (567 [GD1] (f))
 *   { action: "block", id, reason }        blocks them in the store's messages, the reason kept for the creator alone
 *   { action: "unblock", id }              lets them write again
 *   { action: "history", id }              their past refunds and disputes in this store, read now from
 *                                          the creator's own Stripe account (567 [GD1] (f), unit 3)
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
        return result.ok ? answer({ ok: true, thread: result.thread, emailed: result.emailed }) : refuse(result.reason, result.reason === "none" ? 404 : 400);
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
      case "blocked":
      case "block":
      case "unblock": {
        const conversation = id ? await conversationOf(store.statsId, id) : null;
        if (!conversation) return refuse("none", 404);
        if (body.action === "blocked") {
          const state = await blockedState(store, conversation.email);
          return state === "unknown" ? refuse("unknown", 503) : answer({ ok: true, ...state });
        }
        if (body.action === "block") {
          const outcome = await blockPerson(store, conversation.email, body.reason);
          if (outcome === "blocked" || outcome === "already") return answer({ ok: true, blocked: true });
          return refuse(outcome === "full" ? "store_full" : outcome, outcome === "full" ? 409 : outcome === "many" ? 400 : 503);
        }
        const removed = await unblockPerson(store, conversation.email);
        return removed === "error" ? refuse("error", 503) : answer({ ok: true, blocked: false });
      }
      case "history": {
        const conversation = id ? await conversationOf(store.statsId, id) : null;
        if (!conversation) return refuse("none", 404);
        // Nothing to read, so none of the day's checks or the studio's requests is spent on it.
        if (!store.stripeAccountId) return answer({ ok: true, history: { state: "none" } });
        // Bounded before Stripe is asked: each check is at most two reads (lib/buyer-history.ts).
        if (!(await withinLimit("refund-history", store.statsId, REFUND_HISTORY_PER_DAY, 86_400))) return refuse("limited", 429);
        const paid = await countStudio(store, null, REFUND_HISTORY_UNITS);
        if (!paid.ok) return refuse("studio_used", 429);
        const history = await refundHistory(store, conversation.email);
        return history.state === "unknown" ? refuse("unknown", 503) : answer({ ok: true, history });
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
