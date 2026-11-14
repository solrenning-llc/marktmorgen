/**
 * WCAG 2.4.8 (location) on a community's notifications page: the bar across
 * the top marks the tab of the page the person is on (aria-current="page"),
 * as on the feed, events, members and the rest; the notifications page left
 * every tab unmarked. The page source is read for the tab it hands the bar,
 * and the real bar is rendered with it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommunityBar } from "@/components/community-parts";
import { freshConfig } from "@/lib/community";
import type { Store } from "@/lib/store";

const source = readFileSync("app/[handle]/community/notifications/page.tsx", "utf8");
const handed = source.match(/<CommunityBar [^>]*tab=(\{null\}|"([a-z]+)")/);
assert.ok(handed, "the notifications page still draws the community bar");
assert.equal(handed[2], "notifications", "the notifications page tells the bar it is the notifications tab");

const store = { handle: "synthetic-kitchen", name: "Synthetic Kitchen", language: "en", photoId: null } as unknown as Store;
const html = renderToStaticMarkup(createElement(CommunityBar, { store, config: freshConfig(store.name), tab: "notifications", signedIn: true }));
const current = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>([^<]*)</g)].map(([, words]) => words);
assert.equal(current.length, 1, "exactly one tab is marked as the current page");
assert.match(html, /href="\/@synthetic-kitchen\/community\/notifications"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/@synthetic-kitchen\/community\/notifications"/, "and it is the notifications tab");
console.log(`Community notifications: the bar marks "${current[0]}" as the current page`);
