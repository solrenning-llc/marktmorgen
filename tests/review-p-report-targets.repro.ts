import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import StudioCommunityPage from "@/app/studio/community/page";
import { freshConfig, saveConfig } from "@/lib/community";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { cookieValues } from "./meeting-withdrawal-page-world";
import { done, is } from "./check";

async function main() {
  redis.clear(); cookieValues.clear();
  const owner = "review-targets@example.com";
  await claimHandle(owner, "targetproof", "Target proof", "A community.");
  await ensureStatsId(owner);
  await setSubscription(owner, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  await setCommunity(owner, true);
  const store = (await storeForEmail(owner))!;
  const cm = store.community!.id;
  await saveConfig(cm, freshConfig(store.name));
  cookieValues.set(SESSION_COOKIE, await openSession(owner));
  const post = "123456789abc", comment = "abcdef123456";
  const postKey = `nl:cm:${cm}:p:${post}`, commentsKey = `nl:cm:${cm}:c:${post}`;
  await redis.pipeline([["SET", postKey, JSON.stringify({ id: post, a: "creator", sp: "general", title: "Reported target", text: "Report evidence", at: 1, n: 1, hid: false })], ["HSET", commentsKey, comment, JSON.stringify({ id: comment, parent: "", a: "creator", text: "Reported comment", at: 1, hid: false })]]);
  const original = redis.pipeline.bind(redis);
  let mode = "valid", target = `p:${post}`;
  redis.pipeline = async commands => {
    if (commands[0]?.[0] === "ZREVRANGEBYSCORE" && commands[0][1] === `nl:cm:${cm}:rep`) return [[target, "1000"]];
    if (commands[0]?.[0] === "SCARD" && String(commands[0][1]).startsWith(`nl:cm:${cm}:rep:`)) return [1];
    if (commands[0]?.[0] === "GET" && commands[0][1] === postKey) {
      if (mode === "post-partial") return [];
      if (mode === "post-throw") throw Error("synthetic unavailable post read");
      if (mode === "post-absent") return [null];
    }
    if (commands[0]?.[0] === "HGET" && commands[0][1] === commentsKey) {
      if (mode === "comment-partial") return [];
      if (mode === "comment-throw") throw Error("synthetic unavailable comment read");
    }
    return original(commands);
  };
  async function draw() {
    try {
      const page = await StudioCommunityPage({ searchParams: Promise.resolve({ store: store.sid }) });
      return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {} } as never }, page));
    } catch { return "PAGE_FAILED"; }
  }
  try {
    is("a fully confirmed reported post is shown", /Reported target/.test(await draw()), true);
    for (mode of ["post-partial", "post-throw", "comment-partial", "comment-throw"]) {
      target = mode.startsWith("comment") ? `c:${post}:${comment}` : `p:${post}`;
      const html = await draw();
      is(`${mode}: missing target evidence says unavailable without a false empty state or failed page`, [/Reports could not be loaded/.test(html), /Nothing waiting|No reports\./.test(html), html === "PAGE_FAILED"], [true, false, false]);
    }
    mode = "valid"; target = `c:${post}:${comment}`;
    is("a fully confirmed reported comment is shown", /Reported comment/.test(await draw()), true);
    mode = "post-absent"; target = `p:${post}`;
    is("a confirmed absent deleted target can still be omitted", /Nothing waiting/.test(await draw()), true);
  } finally { redis.pipeline = original; cookieValues.clear(); }
  done();
}
void main();
