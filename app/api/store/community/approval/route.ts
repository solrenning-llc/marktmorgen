import type { NextRequest } from "next/server";
import { storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { readComment, readConfig, readMember } from "@/lib/community";
import { approveHeld, removeHeld, setApproval } from "@/lib/community-approval";
import { mentionsIn, whoIs } from "@/lib/community-mentions";
import { tell } from "@/lib/community-notify";
import { communityWords } from "@/lib/buyer-words/community";
import { MAX_WHY } from "@/lib/community-approval-rules";
import { DataRoomError } from "@/lib/store-data";
import { UnknownReplyError } from "@/lib/redis-reply";

const ACTIONS = new Set(["approve", "remove", "setting"]);

/**
 * What the creator does with posts and comments that wait for approval
 * (543 [CM2], lib/community-approval.ts), from the studio:
 *
 *   { action: "setting", space, posts: { mode, n }, comments: { mode, n } }
 *       a space's rule: "off" (publish right away), "first" with n from 1
 *       to 5, or "all"; setting the community up, so "settings";
 *   { action: "approve", item }   publishes it, and tells whom it concerns
 *       the way a post or comment sent straight away would have;
 *   { action: "remove", item, why? }  never published; its author is told,
 *       with the creator's sentence when there is one.
 *
 * Approving and removing are moderation ("community"), which Editors and
 * Support do too, as with the reports. The community is always found
 * through the creator's own store, so nothing here reaches anyone else's.
 */
export async function POST(request: NextRequest) {
  // Not publishing what waits deletes it for good, so a session let in
  // without its second step may not (lib/two-step.ts, "held-remove").
  const guarded = await guardStoreWrite(
    request,
    (body) => (text(body.action, 20) === "setting" ? "settings" : "community"),
    4_000,
    (body) => (text(body.action, 20) === "remove" ? "held-remove" : text(body.action, 20)),
  );
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;
  const action = text(body.action, 20);
  if (!ACTIONS.has(action)) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

  try {
    const store = await storeForEmail(ref);
    const id = store?.community?.id;
    const config = id ? await readConfig(id) : null;
    if (!store || !id || !config) return fail("not_set_up");

    if (action === "setting") {
      const asRule = (raw: unknown) => {
        const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        return { mode: v.mode, n: v.n };
      };
      try {
        const approval = await setApproval(id, text(body.space, 12), { posts: asRule(body.posts), comments: asRule(body.comments) }, config.spaces.map((s) => s.id));
        return Response.json({ ok: true, approval });
      } catch (error) {
        if (error instanceof RangeError) return fail(error.message === "unknown space" ? "unknown" : "approval_rule", error.message === "unknown space" ? 404 : 400);
        throw error;
      }
    }

    const item = text(body.item, 12);
    if (action === "remove") {
      const removed = await removeHeld(id, item, text(body.why, MAX_WHY * 2));
      return removed.ok ? Response.json({ ok: true }) : fail("gone", 404);
    }

    if (action !== "approve") return fail("invalid");
    const approved = await approveHeld(id, item, store);
    if (!approved.ok) return fail(approved.reason === "full" ? "held_full" : approved.reason === "post" ? "held_post_gone" : "gone", approved.reason === "full" ? 409 : 404);
    // Whom it concerns hears of it now, as they would have when it was sent
    // straight away (lib/community-notify.ts): never a hidden post's readers.
    const { held, post, comment } = approved;
    if (!post.hid) {
      const member = await readMember(id, held.a).catch(() => null);
      const phone = { handle: store.handle, who: member?.n || communityWords(store.language).somebody, language: store.language };
      try {
        if (comment) {
          const named = await whoIs(id, mentionsIn(comment.text));
          const above = comment.parent ? await readComment(id, post.id, comment.parent) : null;
          await tell(id, [post.a], { kind: "reply", post: post.id, comment: comment.id, by: held.a, words: comment.text }, store, phone);
          if (above && above.a !== post.a) await tell(id, [above.a], { kind: "answer", post: post.id, comment: comment.id, by: held.a, words: comment.text }, store, phone);
          const others = [...named.values()].filter((one) => one !== post.a && one !== above?.a);
          await tell(id, others, { kind: "mention", post: post.id, comment: comment.id, by: held.a, words: comment.text }, store, phone);
        } else {
          const named = await whoIs(id, mentionsIn(`${post.title}\n${post.text}`));
          await tell(id, [...named.values()], { kind: "mention", post: post.id, comment: "", by: held.a, words: post.title || post.text }, store, phone);
        }
      } catch (error) {
        // Published all the same: a notice that did not go is the smaller loss.
        console.error("telling members of an approved community item failed", error);
      }
    }
    return Response.json({ ok: true, post: post.id, comment: comment?.id ?? "" });
  } catch (error) {
    if (error instanceof DataRoomError) return fail("store_full", 409);
    if (error instanceof UnknownReplyError) return fail("unknown_reply", 503);
    console.error("a community approval failed", action, error);
    return fail("server_error", 500);
  }
}
