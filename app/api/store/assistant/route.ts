import type { NextRequest } from "next/server";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited, withinEssentialLimit } from "@/lib/request-guard";
import { withinStore } from "@/lib/metered-limits";
import { askAssistant, assistantShown, deleteThread, handToCreator, readThread } from "@/lib/store-assistant";
import { ASSISTANT_LABEL, ASSISTANT_PER_DAY, ASSISTANT_PER_TEN_MINUTES, ASSISTANT_STORE_PER_MINUTE } from "@/lib/store-assistant-rules";

/** The model is given twenty seconds; the route a little more. */
export const maxDuration = 30;

const MAX_BODY_BYTES = 4_000;

/**
 * The Store assistant's chat on a store's pages (lib/store-assistant.ts).
 * `{ handle, action, token?, text?, email?, name? }`:
 *
 *   ask      one message to the assistant; one public request of the store,
 *            and one reply of the month's pool, reserved before its facts are read
 *   read     the conversation this browser holds the token of
 *   delete   deletes it, at the buyer's word
 *   handoff  leaves the question, and the conversation, for the creator in
 *            the store's inbox, with the address typed to be answered; no AI
 *
 * Public, and `ask` reaches a model that costs money, so everything that can
 * stand in front of it does: another site is refused; one visitor gets a
 * few questions in ten minutes and a ceiling a day; one store only so many a
 * minute; and the month's pool is reserved before the model is asked. The
 * other actions are public requests of the store's window (lib/metered-limits.ts).
 * Nothing about the visitor is kept or sent on: the network address is used
 * for the counting above and no more.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const parsed = (await (await limited(request, MAX_BODY_BYTES)).json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  const handle = normaliseHandle(typeof body.handle === "string" ? body.handle : "");
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  if (!assistantShown(store)) return Response.json({ ok: false, error: "off" }, { status: 400 });

  const who = `${clientAddress(request)}|${store.handle}`;
  const slow = () => Response.json({ ok: false, error: "slow" }, { status: 429 });
  const noStore = { headers: { "Cache-Control": "no-store" } };
  try {
    switch (body.action) {
      case "ask": {
        if (
          !(await withinEssentialLimit("assist", who, ASSISTANT_PER_TEN_MINUTES, 600)) ||
          !(await withinEssentialLimit("assist-day", who, ASSISTANT_PER_DAY, 86_400)) ||
          !(await withinEssentialLimit("assist-store", store.handle, ASSISTANT_STORE_PER_MINUTE, 60)) ||
          // And one of the store's public requests (lib/metered-limits.ts), so a question refused for a spent pool, or
          // handed over without the model, is a request of the plan's own figure, never one no price holds.
          !(await withinStore("assist-ask", who, ASSISTANT_PER_TEN_MINUTES, 600, store))
        ) {
          return slow();
        }
        const result = await askAssistant({ store, token: body.token, text: body.text });
        if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: result.reason === "failed" ? 502 : 400 });
        return Response.json({ ok: true, thread: result.thread, reply: result.reply }, noStore);
      }
      case "read": {
        if (!(await withinStore("assist-read", who, 60, 600, store))) return slow();
        const thread = await readThread(store, body.token);
        return thread ? Response.json({ ok: true, thread, label: ASSISTANT_LABEL }, noStore) : Response.json({ ok: false, error: "gone" }, { status: 404 });
      }
      case "delete": {
        if (!(await withinStore("assist-read", who, 60, 600, store))) return slow();
        await deleteThread(store, body.token);
        return Response.json({ ok: true }, noStore);
      }
      case "handoff": {
        if (!(await withinStore("assist-handoff", who, 5, 3_600, store))) return slow();
        const result = await handToCreator({ store, token: body.token, email: body.email, name: body.name, text: body.text });
        if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: result.reason === "limited" ? 429 : 400 });
        return Response.json({ ok: true, thread: result.thread }, noStore);
      }
      default:
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    }
  } catch (error) {
    console.error("the store assistant failed", error);
    return Response.json({ ok: false, error: "failed" }, { status: 502 });
  }
}
