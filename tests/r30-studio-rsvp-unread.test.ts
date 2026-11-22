/**
 * Rule 30 (review of #2921), synthetic only: the studio's community page with one event whose list of who is
 * coming does not read. rsvpList (lib/community-events.ts) is everyone or throws UnknownReplyError; the page
 * (app/studio/community/page.tsx) used to await every list with no catch, so one unread list failed the whole
 * page. Now that event says who is coming is not known, never 0 and never a short list, and the rest of the
 * page, the other event's people included, is drawn as before.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { freshConfig, saveConfig, touchMember } from "@/lib/community";
import { createEvent } from "@/lib/community-events";
import StudioCommunityPage from "@/app/studio/community/page";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { cookieValues } from "./meeting-withdrawal-page-world";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const UNREAD = /Who is coming could not be read just now, so the number and the names are not shown\. Reload the page to try again\./g;

async function main(): Promise<void> {
  redis.clear();
  cookieValues.clear();
  const owner = "rsvp-owner@example.com";
  await claimHandle(owner, "rsvpproof", "RSVP proof", "A community.");
  await ensureStatsId(owner);
  await setSubscription(owner, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  await setCommunity(owner, true);
  const store = (await storeForEmail(owner))!;
  const id = store.community!.id;
  await saveConfig(id, freshConfig(store.name));
  cookieValues.set(SESSION_COOKIE, await openSession(owner));

  const base = { about: "A synthetic call.", minutes: 60, tz: "UTC", where: "room" as const, link: "", meet: null, only: [] };
  const readable = await createEvent(store, { ...base, title: "Readable night", start: Date.now() + 86_400_000, cap: 0 });
  const unread = await createEvent(store, { ...base, title: "Unread night", start: Date.now() + 2 * 86_400_000, cap: 30 });
  if (!readable.ok || !unread.ok) throw new Error("synthetic events were not made");
  const unreadList = `nl:cm:${id}:ev:${unread.event.id}:r`;
  const going = ["ann@example.com", "bo@example.com"];
  const members = await Promise.all(going.map((email) => touchMember(id, email, null, store)));
  const original = redis.pipeline.bind(redis);
  await original([
    ["HSET", `nl:cm:${id}:ev:${readable.event.id}:r`, members[0]!.k, "100", members[1]!.k, "200"],
    ["HSET", unreadList, members[0]!.k, "100", members[1]!.k, "200"],
  ]);

  /** The unread event's HSCAN answers `answer` (a reply that is not a page) instead of the stub's. */
  function breaking(answer: unknown): void {
    redis.pipeline = (async (commands: Commands) => {
      if (commands.length === 1 && commands[0][0] === "HSCAN" && commands[0][1] === unreadList) {
        if (answer === "throw") throw new Error("synthetic pipeline failure");
        return [answer];
      }
      return original(commands);
    }) as typeof redis.pipeline;
  }
  async function draw(): Promise<string> {
    try {
      const page = await StudioCommunityPage({ searchParams: Promise.resolve({ store: store.sid }) });
      return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {} } as never }, page));
    } catch {
      return "PAGE_FAILED";
    } finally {
      redis.pipeline = original;
    }
  }
  /** The part of the page from an event's title to the end of its row, or of its first person. */
  function rowOf(html: string, title: string): string {
    const from = html.indexOf(title);
    if (from < 0) return "";
    const next = html.indexOf("</li>", from);
    return html.slice(from, next < 0 ? undefined : next);
  }

  try {
    part("Both lists read (control)");
    let html = await draw();
    is("the page is drawn", html === "PAGE_FAILED", false);
    is("each event says who is coming", [/2 going/.test(rowOf(html, "Readable night")), /2 of 30 places taken/.test(rowOf(html, "Unread night"))], [true, true]);
    is("each event names the people coming", [rowOf(html, "Readable night").includes("Who is coming (2)"), rowOf(html, "Unread night").includes("ann@example.com")], [true, true]);
    is("no notice that a list could not be read", (html.match(UNREAD) ?? []).length, 0);
    is("the members part is drawn", /Members/.test(html), true);

    for (const [label, answer] of [["a reply that is not a page", "QUEUED"], ["an odd hash page", ["0", ["lonely"]]], ["a thrown pipeline", "throw"]] as const) {
      part(`One event's list does not read: ${label}`);
      breaking(answer);
      html = await draw();
      const row = rowOf(html, "Unread night");
      is(`${label}: the page is drawn, not failed`, html === "PAGE_FAILED", false);
      is(`${label}: the event says who is coming is not known, next to it`, [(row.match(UNREAD) ?? []).length, (html.match(UNREAD) ?? []).length], [1, 1]);
      is(`${label}: the notice is a status, in words`, /role="status"[^>]*>Who is coming could not be read just now/.test(row), true);
      is(`${label}: never 0, a count or a short list`, [/\b\d+ of 30 places taken/.test(row), /Who is coming \(/.test(row), row.includes("ann@example.com")], [false, false, false]);
      is(`${label}: the places it has are said without a count`, row.includes("Not known how many of 30 places are taken"), true);
      is(`${label}: the other event is drawn as before`, [/2 going/.test(rowOf(html, "Readable night")), rowOf(html, "Readable night").includes("Who is coming (2)")], [true, true]);
      is(`${label}: the rest of the page is drawn`, /Members/.test(html), true);
    }
  } finally {
    redis.pipeline = original;
    cookieValues.clear();
  }
  done();
}

void main();
