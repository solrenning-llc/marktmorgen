import type { NextRequest } from "next/server";
import { after } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { fromAnotherSite } from "@/lib/studio-route";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { passCookieName } from "@/lib/learn";
import { lockedFor } from "@/lib/two-step";
import { MAX_ALT_LENGTH } from "@/lib/product-image";
import {
  CREATOR,
  type CommunityImage,
  addComment,
  createPost,
  deleteComment,
  deletePost,
  editComment,
  editPost,
  moderateMember,
  readComment,
  readPost,
  report,
  saveConfig,
  setCommentHidden,
  setPostHidden,
  setProfile,
  toggleCommentLike,
  toggleLike,
  within,
  withPin,
} from "@/lib/community";
import { communityViewer, maySeeSpace } from "@/lib/community-access";
import { MAX_POLL_DAYS, parsePoll, vote } from "@/lib/community-polls";
import { mentionsIn, whoIs } from "@/lib/community-mentions";
import { tell } from "@/lib/community-notify";
import { communityWords } from "@/lib/buyer-words/community";
import { checkCommunityImage } from "@/lib/community-image";
import { blobImages, dropCommunityImage, noteCommunityUpload, takeCommunityUpload } from "@/lib/community-files";
import { advanceAnnouncement, queueAnnouncement } from "@/lib/community-mail";
import {
  ITEM_ID,
  MAX_COMMENT_TEXT,
  MAX_DISPLAY_NAME,
  MAX_LINKS_IN_COMMENT,
  MAX_LINKS_IN_POST,
  MAX_POST_TEXT,
  MAX_POST_TITLE,
  cleanLine,
  cleanText,
  linkCount,
} from "@/lib/community-text";
import { limited } from "@/lib/request-guard";
import { alertCreator } from "@/lib/phone-alerts";
import { award, levelOf, pointsOf } from "@/lib/community-points";
import { restingAway, takeBuyerAction } from "@/lib/buyer-actions";
import { DataRoomError } from "@/lib/store-data";

/** The most a form here may weigh: a full post with its picture's details. */
const MAX_FORM_BYTES = 40_000;

const OWNER_ONLY = new Set(["hide", "unhide", "hide-comment", "unhide-comment", "pin", "unpin", "start", "unstart", "mute", "unmute"]);
/** Acts that are not counted: taking away what was counted when it was made. */
const UNCOUNTED = new Set(["delete", "delete-comment"]);

/**
 * Everything a member, or the creator, does inside a community: plain forms
 * that work without a script, each answered with a move back to the page it
 * came from and a word about what happened.
 *
 * Who is asking is worked out again here, whatever the page showed: the
 * store's pass or the creator's session, a ticket still held (lib/
 * community-access.ts), not taken out, not muted. What they send is cleaned
 * and measured (lib/community-text.ts) and each kind of act is counted
 * against its limit before anything is written.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_FORM_BYTES) {
    return new Response("Too large.", { status: 413 });
  }

  let form: FormData;
  try {
    form = await (await limited(request, MAX_FORM_BYTES)).formData();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const field = (name: string, max = 200) => String(form.get(name) ?? "").slice(0, max);
  const handle = normaliseHandle(field("handle", 40));
  const store = handle ? await storeForHandle(handle) : null;
  if (!store?.community) return new Response("Not found.", { status: 404 });
  const home = `/@${store.handle}/community`;

  const action = field("action", 20);
  const postId = field("post", 12);
  const back = (path: string, word: string, anchor = "") => {
    const url = `${origin}${path}${path.includes("?") ? "&" : "?"}n=${word}${anchor ? `#${anchor}` : ""}`;
    return new Response(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store" } });
  };
  const postPage = ITEM_ID.test(postId) ? `${home}/post/${postId}` : home;
  // Where the member was: the feed, a space of it, or a post's own page.
  const from = field("from", 20);
  const space = field("space", 12);
  const fromPage = from === "post" && ITEM_ID.test(postId) ? postPage : from === "you" ? `${home}/you` : ITEM_ID.test(space) && from === "space" ? `${home}?space=${space}` : home;

  if (action === "signout") {
    const headers = new Headers({ Location: `${origin}/@${store.handle}`, "Cache-Control": "no-store" });
    const secure = origin.startsWith("https://") ? "; Secure" : "";
    headers.append("Set-Cookie", `${passCookieName(store)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
    return new Response(null, { status: 303, headers });
  }

  let viewer;
  try {
    viewer = await communityViewer(store, request.cookies);
  } catch (error) {
    console.error("reading who is in a community failed", error);
    return back(fromPage, "error");
  }
  if (viewer.state !== "in") return back(home, viewer.state === "off" ? "off" : "out");
  const id = store.community.id;
  const { config, owner, key } = viewer;
  if (OWNER_ONLY.has(action) && !owner) return back(fromPage, "forbidden");
  // The creator is known here by the address, not by studioAccess: a session let in without its
  // second step (lib/two-step.ts) may not email every member nor delete for good, until it is over.
  const lockedAct = action === "post" && form.get("kind") === "announcement" && form.get("email") === "1" ? "email" : action;
  if (owner && (await lockedFor(request, "community", lockedAct))) return back(fromPage, "locked");
  // Each act is one of the store's buyer actions, or the creator's studio
  // requests, taken before anything is written (lib/buyer-actions.ts).
  // Deleting what one wrote is not: it can only follow an act that was.
  if (!UNCOUNTED.has(action) && !(await takeBuyerAction(store, owner ? "owner" : "buyer"))) return restingAway(origin, store);

  try {
    // ------------------------------------------------------------ your choices
    if (action === "profile") {
      if (!viewer.member) return back(`${home}/you`, "full");
      const name = cleanLine(form.get("name"), MAX_DISPLAY_NAME);
      await setProfile(id, viewer.member, {
        name,
        dir: form.get("dir") === "1",
        mail: form.get("mail") === "1",
        // The creator's questions, when there are any (the page sends one field per question).
        ...(config.questions.length ? { answers: form.getAll("answer").map(String), questions: config.questions } : {}),
      }, store);
      return back(`${home}/you`, "saved");
    }

    if (!viewer.canWrite) return back(fromPage, viewer.member?.muted ? "muted" : "full");

    // ------------------------------------------------------------ a new post
    if (action === "post") {
      const chosen = config.spaces.find((s) => s.id === space) ?? config.spaces[0];
      if (!chosen) return back(home, "nospace");
      if (chosen.creatorOnly && !owner) return back(fromPage, "creatoronly");
      // A space kept for the buyers of some products: the same gate the feed
      // asks, asked again here, because a form can be sent from anywhere.
      if (!(await maySeeSpace(store, config, chosen, { owner, email: viewer.email }))) return back(home, "spacelocked");
      // A space that opens for posting at a level (lib/community-points.ts).
      // Reading and commenting stay open to every member.
      if (!owner && chosen.level >= 2) {
        const points = (await pointsOf(id, [key])).get(key) ?? 0;
        if (levelOf(points) < chosen.level) return back(fromPage, "level");
      }
      const title = cleanLine(form.get("title"), MAX_POST_TITLE);
      const text = cleanText(form.get("text"), MAX_POST_TEXT);
      const path = field("img", 120);
      // A poll, if this post is one: its options come as repeated fields, and
      // a poll with fewer than two answers is not a poll and parses as none.
      const days = Number(field("poll_days", 4));
      const poll =
        form.get("poll") === "1"
          ? parsePoll({
              options: form.getAll("poll_option").map((one) => String(one)),
              multi: form.get("poll_multi") === "1",
              ends:
                Number.isInteger(days) && days > 0 && days <= MAX_POLL_DAYS
                  ? Math.floor(Date.now() / 1000) + days * 86_400
                  : 0,
              quiet: form.get("poll_quiet") === "1",
            })
          : null;
      if (form.get("poll") === "1" && !poll) return back(fromPage, "polloptions");
      // A poll stands on its own: its question is the title and its answers
      // are the post, so it does not also need words or a picture.
      if (!text && !path && !poll) return back(fromPage, "empty");
      if (poll && !title) return back(fromPage, "polltitle");
      if (linkCount(`${title}\n${text}`) > MAX_LINKS_IN_POST) return back(fromPage, "links");
      if (!owner && !viewer.member?.n) return back(`${home}/you`, "name");
      if (!owner && config.questions.length && !viewer.member?.qa) return back(`${home}/you`, "questions");
      if (!owner && (!(await within(id, key, "post")) || !(await within(id, key, "postDay")))) return back(fromPage, "slow");
      // Who the @s name is read before anything is written or a picture taken (rules 24 and 30): a reply that does
      // not read throws, and the member is told nothing was changed, instead of a post going up whose people named
      // are never told.
      const named = await whoIs(id, mentionsIn(`${title}\n${text}`));
      let img: CommunityImage | null = null;
      if (path) {
        const side = (raw: string) => {
          const n = Number(raw);
          return Number.isInteger(n) && n > 0 && n <= 10_000 ? n : 0;
        };
        const w = side(field("img_w", 6));
        const h = side(field("img_h", 6));
        if (!(await takeCommunityUpload(path, key))) return back(fromPage, "image");
        let checked: Awaited<ReturnType<typeof checkCommunityImage>>;
        try {
          checked = await checkCommunityImage(path, id, blobImages);
        } catch (error) {
          // Still this member's, for when they send the form again.
          await noteCommunityUpload(path, key).catch(() => {});
          throw error;
        }
        if (checked === "missing") await noteCommunityUpload(path, key).catch(() => {});
        if (checked !== "ok" || !w || !h) {
          // A picture refused here was deleted by the check, or is deleted now: its place goes back.
          if (checked !== "missing" && checked !== "path") await dropCommunityImage(path);
          return back(fromPage, "image");
        }
        img = { path, w, h, alt: cleanLine(form.get("img_alt"), MAX_ALT_LENGTH) };
      }
      const announce = owner && form.get("kind") === "announcement";
      // Not given back if this fails: the post may have been written anyway,
      // and a picture must never end up in two posts.
      let made: Awaited<ReturnType<typeof createPost>>;
      try {
        made = await createPost(id, { space: chosen.id, author: key, title, text, img, kind: announce ? "announcement" : "post", poll }, store);
      } catch (error) {
        // No room in the store's data room: nothing was written, and the picture goes back.
        if (error instanceof DataRoomError && img) await dropCommunityImage(img.path);
        throw error;
      }
      if (!made.ok) {
        if (img) await dropCommunityImage(img.path);
        return back(fromPage, "fullposts");
      }
      if (!made.post.hid) {
        await tell(
          id,
          [...named.values()],
          { kind: "mention", post: made.post.id, comment: "", by: key, words: title || text },
          store,
          { handle: store.handle, who: owner ? store.name : viewer.member?.n || communityWords(store.language).somebody, language: store.language },
        );
      }
      if (announce && form.get("email") === "1") {
        const queued = await queueAnnouncement(store, config, made.post);
        if (queued.ok) {
          const jobId = queued.job.id;
          after(() => advanceAnnouncement(jobId, storeForHandle, Date.now() + 25_000).then(() => undefined, (error) => console.error("sending an announcement failed", error)));
          return back(`${home}/post/${made.post.id}`, "announced");
        }
        return back(`${home}/post/${made.post.id}`, queued.reason === "plan" ? "noemail" : "noreaders");
      }
      return back(`${home}/post/${made.post.id}`, "posted");
    }

    // Everything else acts on a post that is there, and that this viewer can
    // see — including the space it sits in, so a gated space cannot be
    // reached by sending a form with one of its post ids.
    const post = await readPost(id, postId);
    if (!post || (post.hid && !owner)) return back(home, "gone");
    const itsSpace = config.spaces.find((s) => s.id === post.sp);
    if (itsSpace && !(await maySeeSpace(store, config, itsSpace, { owner, email: viewer.email }))) {
      return back(home, "spacelocked");
    }

    if (action === "comment") {
      const text = cleanText(form.get("text"), MAX_COMMENT_TEXT);
      if (!text) return back(postPage, "empty", "reply");
      if (linkCount(text) > MAX_LINKS_IN_COMMENT) return back(postPage, "links", "reply");
      if (!owner && !viewer.member?.n) return back(`${home}/you`, "name");
      if (!owner && config.questions.length && !viewer.member?.qa) return back(`${home}/you`, "questions");
      if (!owner && !(await within(id, key, "comment"))) return back(postPage, "slow", "reply");
      // Read before the comment is written, as for a post (rules 24 and 30); a hidden post tells nobody, so asks nothing.
      const named = post.hid ? new Map<string, string>() : await whoIs(id, mentionsIn(text));
      const parent = field("parent", 12);
      const made = await addComment(id, post.id, { parent: ITEM_ID.test(parent) ? parent : "", author: key, text }, store);
      if (!made.ok) return back(postPage, made.reason === "full" ? "fullcomments" : "gone");
      // Who hears about it: the post's author, the author of the comment this
      // answers, and anybody named in it. A hidden post reaches nobody — one
      // the creator took down should not keep arriving in somebody's day.
      if (!post.hid) {
        const above = made.comment.parent ? await readComment(id, post.id, made.comment.parent) : null;
        // The name a phone shows: the creator's store name, or the name this
        // member chose. Never an address, and never "a member" on a phone —
        // a notification nobody can place is a notification nobody opens.
        const doer = owner ? store.name : viewer.member?.n || communityWords(store.language).somebody;
        const phone = { handle: store.handle, who: doer, language: store.language };
        await tell(id, [post.a], { kind: "reply", post: post.id, comment: made.comment.id, by: key, words: text }, store, phone);
        if (above && above.a !== post.a) {
          await tell(id, [above.a], { kind: "answer", post: post.id, comment: made.comment.id, by: key, words: text }, store, phone);
        }
        const others = [...named.values()].filter((one) => one !== post.a && one !== above?.a);
        await tell(id, others, { kind: "mention", post: post.id, comment: made.comment.id, by: key, words: text }, store, phone);
      }
      return back(postPage, "commented", `comment-${made.comment.id}`);
    }

    // ---------------------------------------------------- rewriting your own
    // Only the author, and only the words. The creator moderates with hide
    // and delete, which are their own actions and say so; nobody rewrites
    // what somebody else is on record as having said.
    if (action === "edit") {
      // `key` is CREATOR for the creator (lib/community-access.ts), so this
      // one test is the author test for both.
      if (post.a !== key) return back(postPage, "notyours", `post-${post.id}`);
      const title = cleanLine(form.get("title"), MAX_POST_TITLE);
      const text = cleanText(form.get("text"), MAX_POST_TEXT);
      if (!text && !post.img) return back(postPage, "empty", `post-${post.id}`);
      if (linkCount(`${title}\n${text}`) > MAX_LINKS_IN_POST) return back(postPage, "links", `post-${post.id}`);
      if (!owner && !(await within(id, key, "post"))) return back(postPage, "slow", `post-${post.id}`);
      await editPost(id, post, { title, text }, store);
      return back(postPage, "edited", `post-${post.id}`);
    }

    if (action === "edit-comment") {
      const comment = await readComment(id, post.id, field("comment", 12));
      if (!comment || (comment.hid && !owner)) return back(postPage, "gone");
      if (comment.a !== key) return back(postPage, "notyours", `comment-${comment.id}`);
      const text = cleanText(form.get("text"), MAX_COMMENT_TEXT);
      if (!text) return back(postPage, "empty", `comment-${comment.id}`);
      if (linkCount(text) > MAX_LINKS_IN_COMMENT) return back(postPage, "links", `comment-${comment.id}`);
      if (!owner && !(await within(id, key, "comment"))) return back(postPage, "slow", `comment-${comment.id}`);
      await editComment(id, post.id, comment, text, store);
      return back(postPage, "edited", `comment-${comment.id}`);
    }

    // Casting, changing or taking back a vote. An empty choice takes it back,
    // which is the one thing none of the platforms we checked allow.
    if (action === "vote") {
      if (!post.poll) return back(fromPage, "gone", `post-${post.id}`);
      if (!owner && !(await within(id, key, "like"))) return back(fromPage, "slow", `post-${post.id}`);
      const picked = form.getAll("choice").map((one) => String(one));
      const cast = await vote(id, post.id, post.poll, key, picked, store);
      return back(fromPage, cast ? "voted" : "pollclosed", `post-${post.id}`);
    }

    // A like is a point to the author (lib/community-points.ts), never to
    // the one who gives it: liking your own post is allowed and earns nothing.
    if (action === "like") {
      if (!owner && !(await within(id, key, "like"))) return back(fromPage, "slow", `post-${post.id}`);
      const added = await toggleLike(id, post.id, key, store);
      if (post.a !== key) await award(id, post.a, added ? 1 : -1, store);
      return back(fromPage, "liked", `post-${post.id}`);
    }

    if (action === "like-comment") {
      const comment = await readComment(id, post.id, field("comment", 12));
      if (!comment || (comment.hid && !owner)) return back(postPage, "gone");
      if (!owner && !(await within(id, key, "like"))) return back(postPage, "slow", `comment-${comment.id}`);
      const added = await toggleCommentLike(id, post.id, comment.id, key, store);
      if (comment.a !== key) await award(id, comment.a, added ? 1 : -1, store);
      return back(postPage, "liked", `comment-${comment.id}`);
    }

    if (action === "report") {
      if (owner) return back(fromPage, "forbidden");
      const commentId = field("comment", 12);
      if (commentId && !(await readComment(id, post.id, commentId))) return back(postPage, "gone");
      if (!(await within(id, key, "report"))) return back(fromPage, "slow");
      const target = commentId ? ({ kind: "comment", post: post.id, comment: commentId } as const) : ({ kind: "post", post: post.id } as const);
      const added = await report(id, target, key, store);
      // The creator's phone hears of an item's first report, never of what
      // it says or who sent it (lib/phone-alerts.ts), after this answer.
      if (added === "added") {
        await alertCreator(
          store,
          "report",
          {
            title: "New report in your community",
            body: commentId ? "A member reported a comment. It is waiting in your moderation queue." : "A member reported a post. It is waiting in your moderation queue.",
            url: store.sid ? `/studio/community?store=${store.sid}` : "/studio/community",
          },
          { seed: commentId ? `c:${post.id}:${commentId}` : `p:${post.id}` },
        ).catch((error) => console.error("a report notification failed", error));
      }
      return back(fromPage, "reported", commentId ? `comment-${commentId}` : `post-${post.id}`);
    }

    if (action === "delete") {
      if (!owner && post.a !== key) return back(fromPage, "forbidden");
      await deletePost(id, post, store);
      await dropCommunityImage(post.img?.path);
      let next = config;
      if (config.pinned.includes(post.id)) next = withPin(next, post.id, false) ?? next;
      if (config.start === post.id) next = { ...next, start: null };
      if (next !== config) await saveConfig(id, next);
      return back(from === "post" ? home : fromPage, "deleted");
    }

    if (action === "delete-comment" || action === "hide-comment" || action === "unhide-comment") {
      const comment = await readComment(id, post.id, field("comment", 12));
      if (!comment) return back(postPage, "gone");
      if (action === "delete-comment") {
        if (!owner && comment.a !== key) return back(postPage, "forbidden");
        await deleteComment(id, post.id, comment, store);
        return back(postPage, "deleted", "comments");
      }
      await setCommentHidden(id, post.id, comment, action === "hide-comment");
      return back(postPage, action === "hide-comment" ? "hidden" : "shown", `comment-${comment.id}`);
    }

    // ------------------------------------------------------------ the creator's
    if (action === "hide" || action === "unhide") {
      await setPostHidden(id, post, action === "hide");
      return back(fromPage, action === "hide" ? "hidden" : "shown", `post-${post.id}`);
    }
    if (action === "pin" || action === "unpin") {
      const next = withPin(config, post.id, action === "pin");
      if (!next) return back(fromPage, "pinfull");
      await saveConfig(id, next);
      return back(fromPage, action === "pin" ? "pinned" : "unpinned");
    }
    if (action === "start" || action === "unstart") {
      await saveConfig(id, { ...config, start: action === "start" ? post.id : config.start === post.id ? null : config.start });
      return back(fromPage, action === "start" ? "start" : "unstart");
    }
    if (action === "mute" || action === "unmute") {
      if (post.a === CREATOR) return back(fromPage, "forbidden");
      await moderateMember(id, post.a, { muted: action === "mute" });
      return back(fromPage, action === "mute" ? "muted-member" : "unmuted-member");
    }
    return back(fromPage, "error");
  } catch (error) {
    // What did not fit in the store's data room was not written (lib/store-data.ts).
    if (error instanceof DataRoomError) return back(fromPage, "noroom");
    console.error("a community action failed", action, error);
    return back(fromPage, "error");
  }
}
