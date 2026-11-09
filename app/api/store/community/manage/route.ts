import type { NextRequest } from "next/server";
import { hasProduct, readKind } from "@/lib/catalog";
import { MAX_LEVEL, parseRewards, saveRewards } from "@/lib/community-points";
import { StoreFullError, setCommunity, storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { UnknownReplyError } from "@/lib/redis-reply";
import {
  type CommunityConfig,
  deleteComment,
  deletePost,
  dismissReport,
  dropSpace,
  freshConfig,
  ReportQueueReadError,
  moderateMember,
  newItemId,
  parseTarget,
  readConfig,
  readConfigExact,
  readReportedTarget,
  saveConfig,
  setCommentHidden,
  setPostHidden,
  withPin,
} from "@/lib/community";
import { parseDmSetting } from "@/lib/community-dm";
import { parseChatSetting } from "@/lib/community-chat";
import { forgetTicket } from "@/lib/community-access";
import { dropCommunityImage } from "@/lib/community-files";
import {
  MAX_COMMUNITY_ABOUT,
  MAX_COMMUNITY_NAME,
  MAX_SPACES,
  MAX_SPACE_ABOUT,
  MAX_SPACE_NAME,
  MAX_QUESTION,
  MAX_QUESTIONS,
  MAX_WELCOME,
  cleanLine,
  cleanText,
} from "@/lib/community-text";

const ACTIONS = new Set([
  "enable",
  "settings",
  "messages",
  "room",
  "access",
  "space-add",
  "space-edit",
  "space-move",
  "space-remove",
  "rewards",
  "onboarding",
  "member",
  "dismiss",
  "report-hide",
  "report-delete",
]);

/** What keeps order, as opposed to what sets the community up. */
const MODERATION = new Set(["member", "dismiss", "report-hide", "report-delete"]);

/**
 * Everything the studio changes about the creator's community.
 *
 * `{ action: "enable", on }` switches it on or off (made the first time);
 * `{ action: "settings", name, about }`; `{ action: "access", products }`
 * chooses whose purchases let people in; `space-add`, `space-edit`,
 * `space-move` and `space-remove` look after the spaces; `{ action:
 * "member", key, muted?, removed? }` mutes, takes out or lets back a member;
 * `dismiss`, `report-hide` and `report-delete` clear the moderation queue.
 *
 * The community is always found through the creator's own store, so nothing
 * here can reach anyone else's.
 */
export async function POST(request: NextRequest) {
  // Keeping order is moderation, which Editors and Support do too; setting
  // the community up is the store's settings (lib/team-roles.ts).
  const guarded = await guardStoreWrite(
    request,
    (body) => (MODERATION.has(text(body.action, 20)) ? "community" : "settings"),
    8_000,
  );
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;
  const action = text(body.action, 20);
  if (!ACTIONS.has(action)) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  // The setup read exactly, or null when the reply was in no exact shape.
  const exactSetup = async (communityId: string) => {
    try {
      return { config: await readConfigExact(communityId) };
    } catch (error) {
      if (error instanceof UnknownReplyError) return null;
      throw error;
    }
  };

  try {
    let store = await storeForEmail(ref);
    if (!store) return fail("none");

    if (action === "enable") {
      const on = body.on === true;
      // The setup is read exactly before the switch is written: an unknown
      // reply refuses with nothing changed, and only an exact absence means
      // there is none yet. A fresh setup written over a lost read would drop
      // the spaces and the products that let members in.
      const before = store.community?.id;
      const read = before ? await exactSetup(before) : { config: null };
      if (!read) return fail("setup_read_unavailable", 503);
      store = await setCommunity(ref, on);
      if (!store?.community) return fail("none");
      const again = store.community.id === before ? read : await exactSetup(store.community.id);
      if (!again) return fail("setup_read_unavailable", 503);
      let config = again.config;
      if (!config) {
        config = freshConfig(store.name);
        await saveConfig(store.community.id, config);
      }
      return Response.json({ ok: true, on, config });
    }

    const id = store.community?.id;
    const config = id ? await readConfig(id) : null;
    if (!id || !config) return fail("not_set_up");
    const save = async (next: CommunityConfig) => {
      await saveConfig(id, next);
      return Response.json({ ok: true, config: next });
    };

    if (action === "settings") {
      const name = cleanLine(body.name, MAX_COMMUNITY_NAME);
      if (!name) return fail("name");
      return save({ ...config, name, about: cleanText(body.about, MAX_COMMUNITY_ABOUT) });
    }

    // Who may write to whom. Off is off: with `on` false the page is gone and
    // the route refuses, rather than the form merely being hidden.
    if (action === "messages") {
      return save({
        ...config,
        dm: parseDmSetting({ on: body.on === true, between: body.between === true, ask: body.ask !== false }),
      });
    }

    // The room, and what keeps it civil. Off is off: the page is gone and the
    // route refuses, rather than the form merely being hidden.
    if (action === "room") {
      return save({
        ...config,
        chat: parseChatSetting({
          on: body.on === true,
          slow: Number(body.slow),
          links: body.links !== false,
          creatorOnly: body.creatorOnly === true,
        }),
      });
    }

    if (action === "access") {
      const wanted = Array.isArray(body.products) ? body.products.filter((p): p is string => typeof p === "string") : [];
      const access = [...new Set(wanted)].filter((p) => hasProduct(store, p));
      // A new version, so no answer kept under the old choice lets anybody in.
      return save({ ...config, access, v: config.v + 1 });
    }

    if (action === "space-add" || action === "space-edit") {
      const name = cleanLine(body.name, MAX_SPACE_NAME);
      if (!name) return fail("space_name");
      const about = cleanLine(body.about, MAX_SPACE_ABOUT);
      const creatorOnly = body.creatorOnly === true;
      // Kept for the buyers of some of the community's own products. Anything
      // that does not open the community is dropped rather than saved, so the
      // list here can never name a product that lets nobody in.
      const asked = Array.isArray(body.only) ? body.only.filter((p): p is string => typeof p === "string") : [];
      const only = [...new Set(asked)].filter((p) => config.access.includes(p)).slice(0, 50);
      // The level a member needs to start a post here (lib/community-points.ts); 0 for none.
      const wanted = Number(body.level ?? 0);
      if (!Number.isInteger(wanted) || wanted < 0 || wanted > MAX_LEVEL) return fail("level");
      const level = wanted >= 2 ? wanted : 0;
      if (action === "space-add") {
        if (config.spaces.length >= MAX_SPACES) return fail("too_many");
        return save({ ...config, spaces: [...config.spaces, { id: newItemId(), name, about, creatorOnly, only, level }] });
      }
      const spaceId = text(body.id, 12);
      if (!config.spaces.some((s) => s.id === spaceId)) return fail("unknown", 404);
      return save({ ...config, spaces: config.spaces.map((s) => (s.id === spaceId ? { ...s, name, about, creatorOnly, only, level } : s)) });
    }

    // Which of the creator's courses a level hands over (lib/community-points.ts).
    // Only a course of this store, and one per level; anything else is refused
    // rather than dropped, so what the studio shows is what was saved.
    if (action === "rewards") {
      const asked = Array.isArray(body.rewards) ? body.rewards : [];
      const rewards = parseRewards(asked);
      if (rewards.length !== asked.length) return fail("rewards");
      const courses = new Set((await readKind(store, "course")).filter((p) => p.course).map((p) => p.id));
      if (rewards.some((r) => !courses.has(r.product))) return fail("rewards");
      await saveRewards(id, rewards);
      return Response.json({ ok: true, rewards });
    }

    // Welcoming a new member: the questions asked before a first post, and the
    // message sent privately on a first visit (lib/community-access.ts).
    if (action === "onboarding") {
      const asked = Array.isArray(body.questions) ? body.questions : [];
      const questions = asked.map((q) => cleanLine(q, MAX_QUESTION)).filter(Boolean);
      if (questions.length > MAX_QUESTIONS) return fail("questions");
      return save({ ...config, questions, welcome: cleanText(body.welcome, MAX_WELCOME) });
    }

    if (action === "space-move") {
      const spaceId = text(body.id, 12);
      const at = config.spaces.findIndex((s) => s.id === spaceId);
      if (at < 0) return fail("unknown", 404);
      const to = body.direction === "up" ? at - 1 : at + 1;
      if (to < 0 || to >= config.spaces.length) return Response.json({ ok: true, config });
      const spaces = [...config.spaces];
      [spaces[at], spaces[to]] = [spaces[to], spaces[at]];
      return save({ ...config, spaces });
    }

    if (action === "space-remove") {
      const spaceId = text(body.id, 12);
      if (!config.spaces.some((s) => s.id === spaceId)) return fail("unknown", 404);
      if (config.spaces.length <= 1) return fail("last_space");
      await dropSpace(id, spaceId);
      return save({ ...config, spaces: config.spaces.filter((s) => s.id !== spaceId) });
    }

    if (action === "member") {
      const key = text(body.key, 32);
      if (!/^[0-9a-f]{32}$/.test(key)) return fail("unknown", 404);
      const change: { muted?: boolean; removed?: boolean } = {};
      if (typeof body.muted === "boolean") change.muted = body.muted;
      if (typeof body.removed === "boolean") change.removed = body.removed;
      const member = await moderateMember(id, key, change);
      if (!member) return fail("unknown", 404);
      // Let back in: whatever Stripe said before is asked again.
      if (change.removed === false) await forgetTicket(store, member.e);
      return Response.json({ ok: true, member: { key: member.k, muted: member.muted, removed: member.removed } });
    }

    const reportKey = text(body.key, 40);
    const target = parseTarget(reportKey);
    if (!target) return fail("unknown", 404);
    if (action === "dismiss") {
      await dismissReport(id, reportKey);
      return Response.json({ ok: true });
    }
    // Only an exact absence clears the report as already gone; an unknown
    // read throws ReportQueueReadError and the report stays in the queue.
    const found = await readReportedTarget(id, target);
    if (!found) {
      await dismissReport(id, reportKey);
      return Response.json({ ok: true });
    }
    const { post, comment } = found;
    if (comment) {
      if (action === "report-delete") await deleteComment(id, post.id, comment, store);
      else await setCommentHidden(id, post.id, comment, true);
    } else if (action === "report-delete") {
      await deletePost(id, post, store);
      await dropCommunityImage(post.img?.path);
      let next = config;
      if (config.pinned.includes(post.id)) next = withPin(next, post.id, false) ?? next;
      if (config.start === post.id) next = { ...next, start: null };
      if (next !== config) await saveConfig(id, next);
    } else {
      await setPostHidden(id, post, true);
    }
    await dismissReport(id, reportKey);
    return Response.json({ ok: true });
  } catch (error) {
    // Switching the community on is the one change here that writes to the
    // store record, and a record at its ceiling refuses to grow.
    if (error instanceof StoreFullError) return fail("store_full", 409);
    // A member's record read or written in another shape (CX-123 rule 24, lib/community.ts patchMember):
    // the change is not known to be made, and the member is not known to be gone.
    if (error instanceof UnknownReplyError) {
      console.error("changing a community could not be confirmed", action, error);
      return fail("not_confirmed", 503);
    }
    // The reported post or comment was not read in its exact shape: nothing
    // was changed and the report is still waiting.
    if (error instanceof ReportQueueReadError) return fail("report_read_unavailable", 503);
    console.error("changing a community failed", action, error);
    return fail("server_error", 500);
  }
}
