import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { CommunityStudio, type QueueRow } from "@/components/community-studio";
import { freshConfig, saveConfig } from "@/lib/community";
import StudioCommunityPage from "@/app/studio/community/page";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { cookieValues } from "./meeting-withdrawal-page-world";
import { done, is, part } from "./check";

function render(queue: QueueRow[] | null): string {
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {} } as never },
    createElement(CommunityStudio, { handle: "queueproof", address: "https://example.com/community", on: true,
      config: freshConfig("Queue proof"), products: [], queue, members: [],
      totals: { members: 0, listed: 0, posts: 0, reach: 0 }, canEmail: false, canSettings: false, isOwner: false, rewards: [] })));
}

part("What the creator actually reads");
let html = "";
try { html = render(null); } catch { /* The old view throws on an unreadable queue. */ }
is("an unreadable queue renders an explicit status instead of failing the page", /Reports could not be loaded/.test(html), true);
is("an unreadable queue never claims it is empty", /Nothing waiting|No reports\./.test(html), false);
is("a confirmed empty queue retains its empty state", /Nothing waiting/.test(render([])), true);
const row: QueueRow = { key: "p:123456789abc", kind: "post", count: null, at: 1, text: "A reported post", author: "A member", authorEmail: "", hidden: false, href: "/community/post/123456789abc" };
html = render([row]);
is("an expired reporter set does not claim a historical count", /reporter count is no longer available/.test(html), true);
is("confirmed reports retain moderation actions", /Hide it/.test(html) && /Nothing wrong/.test(html), true);
is("a retained count of one remains once", /reported once/.test(render([{ ...row, count: 1 }])), true);

async function pageFlow() {
  part("The real studio page, session and queue reader");
  redis.clear();
  cookieValues.clear();
  const owner = "queue-owner@example.com";
  await claimHandle(owner, "queueproof", "Queue proof", "A community.");
  await ensureStatsId(owner);
  await setSubscription(owner, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  await setCommunity(owner, true);
  const store = (await storeForEmail(owner))!;
  await saveConfig(store.community!.id, freshConfig(store.name));
  cookieValues.set(SESSION_COOKIE, await openSession(owner));
  const original = redis.pipeline.bind(redis);
  let broken: "index" | "count" | "none" = "index";
  let reads = 0;
  redis.pipeline = async (commands) => {
    if (commands[0]?.[0] === "ZREVRANGEBYSCORE" && String(commands[0][1]).endsWith(":rep")) {
      reads += 1;
      if (broken === "index") return [] as never;
      if (broken === "count") return [["p:123456789abc", "1000"]] as never;
    }
    if (broken === "count" && commands[0]?.[0] === "SCARD") return [] as never;
    return original(commands);
  };
  async function draw() {
    try {
      const page = await StudioCommunityPage({ searchParams: Promise.resolve({ store: store.sid }) });
      return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {} } as never }, page));
    } catch { return "PAGE_FAILED"; }
  }
  try {
    for (const failure of ["index", "count"] as const) {
      broken = failure;
      reads = 0;
      const page = await draw();
      is(`${failure}: the actual page says the queue could not be loaded`, /Reports could not be loaded/.test(page), true);
      is(`${failure}: no false empty state or automatic retry`, [/Nothing waiting|No reports\./.test(page), reads], [false, 1]);
    }
    broken = "none";
    is("a subsequent successful page load can show the confirmed empty state", /Nothing waiting/.test(await draw()), true);

    part("Confirmed reports still need confirmed target reads (independent review P)");
    const post = "123456789abc", comment = "abcdef123456", community = store.community!.id;
    const postKey = `nl:cm:${community}:p:${post}`, commentsKey = `nl:cm:${community}:c:${post}`;
    const postValue = { id: post, a: "creator", sp: "general", title: "Reported target", text: "Report evidence", at: 1, n: 1, hid: false };
    const commentValue = { id: comment, parent: "", a: "creator", text: "Reported comment", at: 1, hid: false };
    await original([["SET", postKey, JSON.stringify(postValue)], ["HSET", commentsKey, comment, JSON.stringify(commentValue)]]);
    let mode = "valid", target = `p:${post}`;
    redis.pipeline = async (commands) => {
      if (commands[0]?.[0] === "ZREVRANGEBYSCORE" && commands[0][1] === `nl:cm:${community}:rep`) return [[target, "1000"]] as never;
      if (commands[0]?.[0] === "SCARD" && String(commands[0][1]).startsWith(`nl:cm:${community}:rep:`)) return [1] as never;
      if (commands[0]?.[0] === "GET" && commands[0][1] === postKey) {
        if (mode === "post-partial") return [] as never;
        if (mode === "post-throw") throw Error("synthetic unavailable post read");
        if (mode === "post-absent") return [null] as never;
        if (mode === "post-invalid") return ["invalid JSON"] as never;
        if (mode === "post-mismatch") return [JSON.stringify({ ...postValue, id: "fedcba654321" })] as never;
      }
      if (commands[0]?.[0] === "HGET" && commands[0][1] === commentsKey) {
        if (mode === "comment-partial") return [] as never;
        if (mode === "comment-throw") throw Error("synthetic unavailable comment read");
        if (mode === "comment-absent") return [null] as never;
        if (mode === "comment-invalid") return ["invalid JSON"] as never;
        if (mode === "comment-mismatch") return [JSON.stringify({ ...commentValue, id: "fedcba654321" })] as never;
      }
      if (mode === "name-partial" && commands[0]?.[0] === "HGET" && commands[0][1] === `nl:cm:${community}:m`) return [] as never;
      return original(commands);
    };
    is("a fully confirmed reported post is shown", /Reported target/.test(await draw()), true);
    for (mode of ["post-partial", "post-throw", "comment-partial", "comment-throw", "post-invalid", "comment-invalid", "post-mismatch", "comment-mismatch"]) {
      target = mode.startsWith("comment") ? `c:${post}:${comment}` : `p:${post}`;
      const page = await draw();
      is(`${mode}: unavailable without a false empty state or failed page`, [/Reports could not be loaded/.test(page), /Nothing waiting|No reports\./.test(page), page === "PAGE_FAILED"], [true, false, false]);
    }
    mode = "valid"; target = `c:${post}:${comment}`;
    is("a fully confirmed reported comment is shown", /Reported comment/.test(await draw()), true);
    mode = "post-absent"; target = `p:${post}`;
    is("an explicitly absent deleted post can still be omitted", /Nothing waiting/.test(await draw()), true);
    mode = "comment-absent"; target = `c:${post}:${comment}`;
    is("an explicitly absent deleted comment can still be omitted", /Nothing waiting/.test(await draw()), true);
    await original([["SET", postKey, JSON.stringify({ ...postValue, a: "b".repeat(32) })]]);
    mode = "name-partial"; target = `p:${post}`;
    const unnamed = await draw();
    is("an unknown author label does not claim the member chose no name", [/Reported target/.test(unnamed), /A member without a name/.test(unnamed)], [true, false]);
  } finally { redis.pipeline = original; cookieValues.clear(); }
  done();
}
void pageFlow();
