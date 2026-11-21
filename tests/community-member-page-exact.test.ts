/**
 * Rule 24 (CX-123): one page of a community's member list (lib/community.ts
 * memberPage) is read only in HSCAN's exact shape, [cursor, [field, value, ...]],
 * with HLEN's exact count beside it. A page in any other shape was read as
 * "no members, and the end of the list" ("0"), so:
 *
 * - the creator's studio showed "Nobody has come in yet" or a short list as the whole list;
 * - GET /api/v1/members told a developer's sync it had every member when it had part;
 * - an announcement was queued to part of the members who asked for it, or refused as "nobody asked",
 *   and the composer counted fewer members than asked.
 *
 * Now the page throws UnknownReplyError: the API answers 502 (its route's catch), a send queues
 * nothing, and the screens say the members (or the count) could not be loaded. A healthy page, a
 * numeric cursor and a confirmed empty community are unchanged. Synthetic data only; only the
 * member list's HSCAN/HLEN reply is replaced.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { freshConfig, mailableMembers, memberPage, saveConfig, type Post } from "@/lib/community";
import { announcementReach, queueAnnouncement } from "@/lib/community-mail";
import { members as apiMembers } from "@/lib/api-read";
import { UnknownReplyError } from "@/lib/redis-reply";
import { communityNotices } from "@/components/community-parts";
import StudioCommunityPage from "@/app/studio/community/page";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureListId, ensureStatsId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { cookieValues } from "./meeting-withdrawal-page-world";
import { done, is, part } from "./check";

type Command = (string | number)[];
const original = redis.pipeline.bind(redis);
/** What the member list's HSCAN batch answers instead of the stub, while set. */
let injected: unknown[] | null = null;
let written: Command[] = [];
/** The member list's read fails in transport (no answer at all), while set. */
let membersDown = false;
redis.pipeline = (async (batch: Command[]) => {
  written.push(...batch);
  if (membersDown && batch.some((c) => c[0] === "HSCAN" && String(c[1]).endsWith(":m"))) throw new Error("synthetic transport failure reading the members");
  if (injected && batch.some((c) => c[0] === "HSCAN" && String(c[1]).endsWith(":m"))) return injected;
  return original(batch);
}) as typeof redis.pipeline;

const memberRecord = (k: string, e: string, n: string) =>
  JSON.stringify({ k, e, n, h: "", dir: false, mail: true, at: 1_700_000_000, seen: 1_700_000_100, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] });
const ROW = memberRecord("a".repeat(32), "one@example.com", "Synthetic One");

/** Each a whole pipeline answer for [HSCAN, HLEN]. */
const MALFORMED: [string, unknown[]][] = [
  ["no reply at all", []],
  ["the HSCAN reply alone", [["0", ["a".repeat(32), ROW]]]],
  ["a null page", [null, 1]],
  ["a number for the page", [7, 1]],
  ["the cursor alone", [["0"], 1]],
  ["three parts", [["0", [], "x"], 1]],
  ["rows that are not a list", [["0", "rows"], 1]],
  ["rows as null", [["0", null], 1]],
  ["an odd row list", [["0", ["a".repeat(32), ROW, "b".repeat(32)]], 1]],
  ["a row that is not text", [["0", ["a".repeat(32), 5]], 1]],
  ["a field that is not text", [["0", [5, ROW]], 1]],
  ["a cursor that is not a number", [["next", ["a".repeat(32), ROW]], 1]],
  ["an empty cursor", [["", ["a".repeat(32), ROW]], 1]],
  ["a cursor that is null", [[null, ["a".repeat(32), ROW]], 1]],
  ["a negative numeric cursor", [[-1, ["a".repeat(32), ROW]], 1]],
  ["a count that is text", [["0", ["a".repeat(32), ROW]], "1"]],
  ["a count that is null", [["0", ["a".repeat(32), ROW]], null]],
  ["a count that is negative", [["0", ["a".repeat(32), ROW]], -1]],
];

async function rejectsUnknown(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "resolved";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  }
}

async function main() {
  redis.clear();
  cookieValues.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const owner = "member-page-exact@example.com";
  await claimHandle(owner, "memberpageexact", "Member Page Exact", "A community.");
  await ensureStatsId(owner);
  await setSubscription(owner, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  await ensureListId(owner);
  await setCommunity(owner, true);
  const store = (await storeForEmail(owner))!;
  const id = store.community!.id;
  await saveConfig(id, freshConfig(store.name));
  cookieValues.set(SESSION_COOKIE, await openSession(owner));

  part("Confirmed empty community: no members, the end, a count of 0");
  is("an empty community reads as empty and ended", await memberPage(id, "0", 1000).then((p) => [p.members.length, p.next, p.total]), [0, "0", 0]);
  is("nobody to email in an empty community", await announcementReach(id), 0);

  await original([["HSET", `nl:cm:${id}:m`, "a".repeat(32), ROW]]);

  part("Healthy page: the member, the end of the list, the count");
  const healthy = await memberPage(id, "0", 1000);
  is("healthy: one member, cursor 0, total 1", [healthy.members.map((m) => m.e), healthy.next, healthy.total], [["one@example.com"], "0", 1]);
  injected = [[0, ["a".repeat(32), ROW]], 1];
  is("a numeric cursor 0 is the end, as Redis may send it", await memberPage(id, "0", 1000).then((p) => [p.members.length, p.next, p.total]), [1, "0", 1]);
  injected = [["1234", ["a".repeat(32), ROW]], 3];
  is("a text cursor of digits is the next page", await memberPage(id, "0", 1000).then((p) => [p.next, p.total]), ["1234", 3]);
  injected = null;
  is("healthy: one member asked for announcements", await announcementReach(id), 1);

  part("lib/community.ts memberPage and what walks it: a page in another shape is unknown");
  for (const [label, reply] of MALFORMED) {
    injected = reply;
    try {
      is(`memberPage, ${label}: unknown, never an empty or last page`, await rejectsUnknown(() => memberPage(id, "0", 1000)), "unknown");
      is(`mailableMembers, ${label}: unknown, never fewer members`, await rejectsUnknown(() => mailableMembers(id)), "unknown");
      is(`announcementReach, ${label}: unknown, never a smaller count`, await rejectsUnknown(() => announcementReach(id)), "unknown");
      is(
        `API members, ${label}: unknown (the route answers 502), never a last page`,
        await rejectsUnknown(() => apiMembers(store, null, async () => async () => null)),
        "unknown",
      );
    } finally {
      injected = null;
    }
  }

  part("An announcement send: an unread member list queues nothing");
  const post = { id: "123456789abc", title: "Synthetic announcement", text: "Synthetic text." } as Post;
  const mailing = { ...store, mail: { from: "Synthetic", reply: owner } as never } as Store;
  for (const [label, reply] of MALFORMED.slice(0, 6)) {
    injected = reply;
    written = [];
    try {
      is(`queueAnnouncement, ${label}: unknown`, await rejectsUnknown(() => queueAnnouncement(mailing, freshConfig(store.name), post)), "unknown");
      is(`queueAnnouncement, ${label}: no job written, nothing queued`, written.filter((c) => c[0] === "RPUSH" || c[0] === "SADD" || c[0] === "SET").length, 0);
    } finally {
      injected = null;
    }
  }
  // Codex M (M1 on #3213): a member read that fails in transport, after the post was saved, is the same "who asked
  // could not be read" as a reply in another shape: one error the route tells apart, raised before any queue write.
  const failure = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return "resolved";
    } catch (error) {
      return error instanceof Error ? error.name : "not an error";
    }
  };
  membersDown = true;
  written = [];
  try {
    is("queueAnnouncement, the member read fails in transport: said as the recipients not read", await failure(() => queueAnnouncement(mailing, freshConfig(store.name), post)), "RecipientsUnreadError");
    is("queueAnnouncement, the member read fails in transport: no job written, nothing queued", written.filter((c) => c[0] === "RPUSH" || c[0] === "SADD" || c[0] === "SET").length, 0);
  } finally {
    membersDown = false;
  }
  injected = MALFORMED[2][1];
  try {
    is("queueAnnouncement, a member page in another shape: the same error", await failure(() => queueAnnouncement(mailing, freshConfig(store.name), post)), "RecipientsUnreadError");
  } finally {
    injected = null;
  }
  const queued = await queueAnnouncement(mailing, freshConfig(store.name), post);
  is("healthy control: a read list queues the send to the one member who asked", queued.ok ? queued.job.total : queued.reason, 1);

  part("The real studio page: members that did not read are said so, never 'Nobody has come in yet'");
  async function draw(): Promise<string> {
    try {
      const page = await StudioCommunityPage({ searchParams: Promise.resolve({ store: store.sid }) });
      return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {} } as never }, page));
    } catch (error) {
      return `PAGE_FAILED ${String(error)}`;
    }
  }
  const good = await draw();
  is("healthy control: the member is listed, no unknown state", [/Synthetic One/.test(good), /could not be loaded/.test(good)], [true, false]);
  for (const [label, reply] of [MALFORMED[2], MALFORMED[7], MALFORMED[11], MALFORMED[15]]) {
    injected = reply;
    try {
      const html = await draw();
      is(`studio, ${label}: the page is drawn`, html.startsWith("PAGE_FAILED"), false);
      is(`studio, ${label}: "Members could not be loaded", in a status region`, /role="status"[^>]*>Members could not be loaded/.test(html), true);
      is(`studio, ${label}: never "Nobody has come in yet" nor "0 have come in"`, /Nobody has come in yet|0 have come in/.test(html), false);
      is(`studio, ${label}: the figures that did not read say "Not loaded"`, /Not loaded<\/p><p[^>]*>have come in/.test(html) && /Not loaded<\/p><p[^>]*>want the community/.test(html), true);
    } finally {
      injected = null;
    }
  }

  part("The composer: a count that did not read turns the email box off, with its reason, in every language");
  const root = process.cwd();
  const source = (path: string) => readFileSync(join(root, path), "utf8");
  const LANGUAGE_CODES = ["en", "es", "fr", "de", "it", "nl", "pt"];
  let unreadSource = "";
  try {
    unreadSource = source("lib/buyer-words/community-unread.ts");
  } catch {
    /* Not there before the fix. */
  }
  const reachLines = [...unreadSource.matchAll(/^ {2}reachUnknown:\s*\n?\s*"([^"]{20,})"/gm)].map((m) => m[1]);
  is("a sentence for a count that could not be read, in each of the seven languages, each its own", [reachLines.length, new Set(reachLines).size], [7, 7]);
  const composer = source("components/community-composer.tsx");
  is("the composer takes an unknown count", /reach: number \| null/.test(composer), true);
  is("an unknown count disables the email box", /disabled=\{!canEmail \|\| reach === null \|\| reach === 0\}/.test(composer), true);
  is("an unknown count says why", /reach === null \? reachUnknown :/.test(composer), true);
  const buyerPage = source("app/[handle]/community/page.tsx");
  is("the community page keeps an unread count as unknown, never fails the page", /announcementReach\(id\)\.catch\(\(\) => null\)/.test(buyerPage), true);
  is("the page hands the composer that sentence in the store's language", /reachUnknown=\{communityUnreadWords\(store\.language\)\.reachUnknown\}/.test(buyerPage), true);

  part("The announcement route: an unread member list says the post went up and the email did not");
  const route = source("app/api/store/community/route.ts");
  is("the route tells an unread list apart however the read failed, and only the read", /error instanceof RecipientsUnreadError\) return back\(`\$\{home\}\/post\/\$\{made\.post\.id\}`, "notemailed"\)/.test(route), true);
  const notEmailed = LANGUAGE_CODES.map((l) => communityNotices(l).notemailed);
  is("its notice is in all seven languages, each its own, said as a warning", [notEmailed.every((n) => typeof n?.text === "string" && n.text.length > 20 && n.tone === "warn"), new Set(notEmailed.map((n) => n?.text)).size], [true, 7]);
  is("its notice says the post is up and nothing was emailed", /^Posted\. It was not emailed/.test(communityNotices("en").notemailed?.text ?? ""), true);

  done();
}

void main();
