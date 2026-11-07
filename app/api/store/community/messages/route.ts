import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite } from "@/lib/studio-route";
import { limited } from "@/lib/request-guard";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { CREATOR, within } from "@/lib/community";
import { communityViewer } from "@/lib/community-access";
import {
  MAX_MESSAGE_TEXT,
  accept,
  decline,
  mayMessage,
  otherIn,
  pairOf,
  send,
  unblock,
} from "@/lib/community-dm";
import { restingAway, takeBuyerAction } from "@/lib/buyer-actions";
import { DataRoomError } from "@/lib/store-data";
import { communityWords } from "@/lib/buyer-words/community";

/** How far a request got before something failed: the store's language once read, and whether a write had begun. */
type Progress = { language?: unknown; writing: boolean };

/** A member key, or the creator. */
const WHO = /^(creator|[0-9a-f]{12,64})$/;
const PAIR = /^(creator|[0-9a-f]{12,64})\.(creator|[0-9a-f]{12,64})$/;

/**
 * Private messages: writing one, and answering a request for one.
 *
 * Forms, not JSON, and a redirect back, so this works with the page exactly
 * as the rest of the community does and needs no script to send a message.
 *
 * Every rule that matters is decided here rather than on the page: whether
 * messages happen in this community at all, whether these two may write to
 * each other, whether the sender is muted, and how much they may send. A page
 * that draws no box is a courtesy; this is the door.
 */
export async function POST(request: NextRequest) {
  const progress: Progress = { writing: false };
  try {
    return await act(request, progress);
  } catch (error) {
    // Redis did not answer, or answered a count in a shape nobody knows
    // (CX-123 rule 24). Before any write, nothing changed and it is said so;
    // once a message, an answer or an unblock was being written, whether it
    // went through is not known, and the person is asked to look first.
    console.error("a community message action failed", error);
    const notices = communityWords(progress.language).notices;
    return new Response(progress.writing ? notices.unconfirmed : notices.error, {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

async function act(request: NextRequest, progress: Progress): Promise<Response> {
  const origin = originFrom(request);
  // Read only as far as 32 KB (a message's 2,000 characters, written out as a form), whether or not a length was declared (MM-SA-10).
  const form = await limited(request, 32_000).then((r) => r.formData()).catch(() => null);
  if (!form) return new Response("Bad Request", { status: 400 });
  const field = (name: string, max: number) => String(form.get(name) ?? "").trim().slice(0, max);
  const handle = normaliseHandle(field("handle", 60));
  const store = handle ? await storeForHandle(handle) : null;
  if (!store || fromAnotherSite(request)) return new Response("Not Found", { status: 404 });
  progress.language = store.language;

  const home = `${origin}/@${store.handle}/community`;
  const box = `${home}/messages`;
  const back = (to: string, notice?: string) =>
    Response.redirect(`${to}${notice ? `${to.includes("?") ? "&" : "?"}n=${notice}` : ""}`, 303);

  const viewer = await communityViewer(store, request.cookies);
  if (viewer.state !== "in" || !store.community) return back(home, "out");
  const id = store.community.id;
  const { config, owner, key } = viewer;
  const action = field("action", 20);

  // Off here means off: no page, no form and no back door.
  if (!config.dm.on) return back(home, "dmoff");
  // One of the store's buyer actions, or the creator's studio requests, before anything is written (lib/buyer-actions.ts).
  if (!(await takeBuyerAction(store, owner ? "owner" : "buyer"))) return restingAway(origin, store);

  if (action === "send") {
    const to = field("to", 70);
    if (!WHO.test(to)) return back(box, "gone");
    const allowed = mayMessage(config.dm, key, to);
    if (allowed) return back(box, allowed.reason === "between" ? "dmbetween" : "dmoff");
    // A muted member reads what was said to them and writes nothing. The
    // creator is not rate limited in their own community.
    if (!owner && !viewer.canWrite) return back(box, viewer.member?.muted ? "muted" : "full");
    if (!owner && !viewer.member?.n) return back(`${home}/you`, "name");
    if (!owner && !(await within(id, key, "dm"))) return back(box, "slow");
    const text = field("text", MAX_MESSAGE_TEXT);
    if (!text) return back(`${box}/${pairOf(key, to)}`, "empty");
    // Starting a conversation is limited harder than continuing one: the cost
    // of a stranger is in the opening, not in the tenth message of a talk
    // somebody chose to have.
    const started = await within(id, key, "dmNew");
    let sent: Awaited<ReturnType<typeof send>>;
    progress.writing = true;
    try {
      sent = await send(id, config.dm, key, to, text, store);
    } catch (error) {
      // No room in the store's data room: nothing was sent (lib/store-data.ts).
      if (error instanceof DataRoomError) return back(`${box}/${pairOf(key, to)}`, "noroom");
      throw error;
    }
    if (!sent.ok) {
      const why =
        sent.reason === "declined"
          ? "dmsent"
          : sent.reason === "full"
            ? "dmfull"
            : sent.reason === "between"
              ? "dmbetween"
              : sent.reason === "empty"
                ? "empty"
                : "dmoff";
      // "declined" answers exactly as success does, on purpose: somebody who
      // was turned down learns that their message went, and nothing else.
      // Telling them they were declined turns a quiet no into an argument.
      return back(why === "dmsent" ? box : `${box}/${pairOf(key, to)}`, why);
    }
    if (!owner && !started && sent.asked) return back(box, "slow");
    return sent.asked ? back(box, "dmasked") : back(`${box}/${pairOf(key, to)}`, "dmsent");
  }

  const pair = field("pair", 140);
  if (!PAIR.test(pair) || !otherIn(pair, key)) return back(box, "gone");

  progress.writing = true;
  if (action === "accept") {
    return (await accept(id, key, pair)) ? back(`${box}/${pair}`, "dmaccepted") : back(box, "gone");
  }
  if (action === "decline") {
    return (await decline(id, key, pair, store)) ? back(box, "dmdeclined") : back(box, "gone");
  }
  if (action === "unblock") {
    const other = otherIn(pair, key);
    if (other && other !== CREATOR) await unblock(id, key, other, store);
    return back(box, "dmunblocked");
  }
  return back(box, "gone");
}
