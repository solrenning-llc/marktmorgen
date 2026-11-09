/**
 * Rules 24 and 30, synthetic only: who a community's members are, and whose
 * handle an @ names, is never decided from a Redis reply that did not come
 * back in its exact shape.
 *
 * readMembers (lib/community.ts) and whoIs (lib/community-mentions.ts) read
 * their HMGET with `Array.isArray(rows) ? rows : []`: a reply lost, cut short
 * or in another shape was an empty answer. What that did:
 *
 *   - Writing (app/api/store/community/route.ts): a post or a comment that
 *     named somebody with an @ went in, and the person named was never told.
 *     whoIs was read after the write, so failing there would have answered
 *     "Nothing was changed" over a post already up. Now the @s are read
 *     before anything is written: a reply that does not read refuses the post
 *     or the comment with the route's own "error" (nothing was changed), and
 *     nothing is written.
 *   - claimHandle (lib/community-mentions.ts), on a name change: a claim
 *     answered "1" as text or not at all was taken for "somebody else holds
 *     it", and the member was given a numbered handle. Now it throws.
 *   - Screens: every name on the feed, a post, the room, messages,
 *     notifications and the leaderboard said "A member", the members page
 *     said nobody was listed, and a search of members said "No match". Now
 *     the page is drawn, and a status line says some names, the members list
 *     or the members search could not be loaded; never an empty list as if
 *     it were true. The room's own route says so to the page too.
 *   - directory (lib/community.ts) read its page with the same loose shape,
 *     and the one-time search walk (lib/community-walk.ts) took an unread
 *     page for the end of the directory and marked the community walked.
 *
 * Controls: a member Redis says is not there (nil) is still nobody, a record
 * that does not parse is still passed over, and every page reads as before
 * when the replies are whole.
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { POST as communityPost } from "@/app/api/store/community/route";
import { GET as chatGet } from "@/app/api/store/community/chat/route";
import CommunityPage from "@/app/[handle]/community/page";
import CommunityPostPage from "@/app/[handle]/community/post/[post]/page";
import CommunityChatPage from "@/app/[handle]/community/chat/page";
import CommunityLeaderboardPage from "@/app/[handle]/community/leaderboard/page";
import MessagesPage from "@/app/[handle]/community/messages/page";
import MessageThreadPage from "@/app/[handle]/community/messages/[pair]/page";
import NotificationsPage from "@/app/[handle]/community/notifications/page";
import CommunityMembersPage from "@/app/[handle]/community/members/page";
import CommunitySearchPage from "@/app/[handle]/community/search/page";
import StudioCommunityPage from "@/app/studio/community/page";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { CREATOR, addComment, createPost, directory, directorySize, freshConfig, readMembers, saveConfig, setProfile, touchMember } from "@/lib/community";
import { claimHandle, releaseHandle, whoIs } from "@/lib/community-mentions";
import { membersFound } from "@/lib/community-found";
import { say } from "@/lib/community-chat";
import { pairOf, send } from "@/lib/community-dm";
import { tell } from "@/lib/community-notify";
import { award } from "@/lib/community-points";
import { createEvent, rsvp } from "@/lib/community-events";
import { claimHandle as claimStore, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { cookieValues } from "./meeting-withdrawal-page-world";
import { communityWords } from "@/lib/buyer-words/community";
import { done, is, part } from "./check";

type Command = (string | number)[];

const original = redis.pipeline.bind(redis);
/** The pipeline `match` picks is answered with `reply` ("throw" throws) instead of the stub's. */
let odd: { match: (commands: Command[]) => boolean; reply: unknown } | null = null;
redis.pipeline = (async (commands: Command[]) => {
  if (odd && odd.match(commands)) {
    if (odd.reply === "throw") throw new Error("synthetic pipeline failure");
    return odd.reply;
  }
  // lib/community.ts CAS_MEMBER, as Redis runs it: the record written only over the one it was read as.
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith('local cur = redis.call("HGET"')) {
    const [, , , members, dir, field, expected, next, listed, at] = commands[0];
    const [cur] = await original([["HGET", members, field]]);
    if (cur !== expected) return [0];
    await original([["HSET", members, field, next], listed === "1" ? ["ZADD", dir, at, field] : ["ZREM", dir, field]]);
    return [1];
  }
  return original(commands);
}) as typeof redis.pipeline;

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

/** Runs `act` with the pipelines `match` picks answered by `reply`; "thrown" when it threw. */
async function withOdd<T>(match: (commands: Command[]) => boolean, reply: unknown, act: () => Promise<T>): Promise<T | "thrown"> {
  const quiet = console.error;
  console.error = () => {};
  odd = { match, reply };
  try {
    return await act();
  } catch {
    return "thrown";
  } finally {
    odd = null;
    console.error = quiet;
  }
}

/** One HMGET of `key`, as the readers send it. */
const hmget = (key: string) => (commands: Command[]) => commands.length === 1 && commands[0][0] === "HMGET" && commands[0][1] === key;

/** Replies that are not an answer: nothing, a hole, a word, a short list, a row of the wrong type. Each `rows` long. */
function shapes(rows: number): [string, unknown][] {
  return [
    ["no reply at all", []],
    ["a hole where the reply was", [undefined]],
    ["a word instead of a list", ["QUEUED"]],
    ["a list one row short", [new Array(Math.max(0, rows - 1)).fill(null)]],
    ["a row that is a number", [[42, ...new Array(Math.max(0, rows - 1)).fill(null)]]],
    ["a thrown pipeline", "throw"],
  ];
}

async function draw(page: () => Promise<ReactNode>): Promise<string> {
  try {
    const tree = await page();
    return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {}, replace() {}, prefetch() {} } as never }, tree));
  } catch (error) {
    return `PAGE_FAILED ${error instanceof Error ? error.message : String(error)}`;
  }
}

const NAMES = "Some names could not be loaded just now. Reload the page to see them.";
const LIST = "The members list could not be loaded just now. Reload the page to try again.";
const SEARCH = "Members could not be searched just now, so we cannot say whether any match. Try again in a moment.";
const STUDIO_PEOPLE = "Who is coming could not be read just now";

async function main(): Promise<void> {
  redis.clear();
  cookieValues.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "club@membersexact.example";
  const made = await claimStore(OWNER, "membersexact", "Members Exact Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_MembersExact1", subscriptionId: "sub_MembersExact1", active: true, tier: "pro", period: paidPeriod() });
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const cid = club.community!.id;
  const fresh = freshConfig(club.name);
  const config = { ...fresh, chat: { ...fresh.chat, on: true }, dm: { ...fresh.dm, on: true } };
  await saveConfig(cid, config);
  const space = config.spaces[0].id;
  const MEMBERS = `nl:cm:${cid}:m`;
  const HANDLES = `nl:cm:${cid}:h`;
  const session = await openSession(OWNER);
  const cookie = `${SESSION_COOKIE}=${session}`;
  cookieValues.set(SESSION_COOKIE, session);

  // Zed: a member with a name, listed in the directory, mentionable as @zed-quill.
  const zed0 = await touchMember(cid, "zed@membersexact.example", null, club);
  if (!zed0) throw new Error("no member");
  const zed = await setProfile(cid, zed0, { name: "Zed Quill", dir: true, mail: false }, club);
  if (zed.h !== "zed-quill") throw new Error(`unexpected handle ${zed.h}`);
  const ghost = "f".repeat(zed.k.length);

  part("readMembers and whoIs, read exactly");
  {
    const both = await readMembers(cid, [zed.k, ghost]);
    is("control: the member is read, and a key Redis answers nil for is nobody", [both.get(zed.k)?.n, both.has(ghost)], ["Zed Quill", false]);
    await original([["HSET", MEMBERS, "e".repeat(zed.k.length), "{not a record"]]);
    is("control: a record that does not parse is passed over, as before", (await readMembers(cid, [zed.k, "e".repeat(zed.k.length)])).size, 1);
    is("control: whoIs names the member, and an unknown handle names nobody", [...(await whoIs(cid, ["zed-quill", "nobody-here"]))], [["zed-quill", zed.k]]);
    for (const [what, reply] of shapes(2)) {
      is(`readMembers, ${what}: unknown, never an empty map`, await withOdd(hmget(MEMBERS), reply, () => readMembers(cid, [zed.k, ghost])), "thrown");
      is(`whoIs, ${what}: unknown, never nobody`, await withOdd(hmget(HANDLES), reply, () => whoIs(cid, ["zed-quill", "nobody-here"])), "thrown");
    }
    is("control: the directory lists the member", (await directory(cid, null, 10)).members.map((m) => m.n), ["Zed Quill"]);
    const dirRead = (commands: Command[]) => commands.length === 1 && commands[0][0] === "ZREVRANGEBYSCORE";
    for (const [what, reply] of [["no reply at all", []], ["a word instead of a page", ["QUEUED"]], ["a member without its score", [[zed.k]]], ["a score that is not a number", [[zed.k, "soon"]]]] as [string, unknown][]) {
      is(`directory, ${what}: unknown, never an empty page`, await withOdd(dirRead, reply, () => directory(cid, null, 10)), "thrown");
    }
    is("directory, its members unread: unknown, never an empty page", await withOdd(hmget(MEMBERS), ["QUEUED"], () => directory(cid, null, 10)), "thrown");
    is("membersFound, its members unread: unknown, never no match", await withOdd(hmget(MEMBERS), ["QUEUED"], () => membersFound(cid, [zed.k])), "thrown");
    is("control: membersFound finds the member", (await membersFound(cid, [zed.k])).map((m) => m.n), ["Zed Quill"]);
  }

  part("claimHandle: a claim that did not read is not somebody else's");
  {
    const setnx = (commands: Command[]) => commands.length === 1 && commands[0][0] === "HSETNX" && commands[0][1] === HANDLES;
    for (const [what, reply] of [["no reply at all", []], ["1 as text", ["1"]], ["a hole", [undefined]]] as [string, unknown][]) {
      is(`${what}: unknown, never a numbered handle`, await withOdd(setnx, reply, () => claimHandle(cid, "a".repeat(zed.k.length), "Ana Lima", "")), "thrown");
    }
    is("control: a free name is claimed as it is", await claimHandle(cid, "b".repeat(zed.k.length), "Bea Ray", ""), "bea-ray");
    is("control: a name somebody holds gets a number", await claimHandle(cid, "c".repeat(zed.k.length), "Zed Quill", ""), "zed-quill2");
  }

  part("Writing: a post or a comment naming somebody, with the @s unread");
  const feedOf = async () => (await original([["ZCARD", `nl:cm:${cid}:feed`]]))[0];
  const noticesOf = async () => (await original([["ZCARD", `nl:cm:${cid}:nt:${zed.k}`]]))[0];
  const press = (fields: Record<string, string>) => {
    const form = new FormData();
    form.set("handle", club.handle);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return communityPost(new NextRequest("https://marktmorgen.com/api/store/community", { method: "POST", headers: { cookie }, body: form })).then((r) =>
      (r.headers.get("location") ?? "").replace(/^.*[?&]n=/, "").replace(/#.*$/, ""),
    );
  };
  {
    const before = await feedOf();
    const told = await noticesOf();
    for (const [what, reply] of shapes(1)) {
      is(`a post, ${what}: refused as "error" (nothing was changed)`, await withOdd(hmget(HANDLES), reply, () => press({ action: "post", space, from: "feed", text: `Hello @zed-quill (${what})` })), "error");
    }
    is("and no post was written", await feedOf(), before);
    is("and nobody was told", await noticesOf(), told);
    is("control: the post goes in", await press({ action: "post", space, from: "feed", text: "Hello @zed-quill" }), "posted");
    is("control: and the member named is told", Number(await noticesOf()) > Number(told), true);
  }
  const ownerPost = await createPost(cid, { space, author: CREATOR, title: "Welcome", text: "Say hi to @zed-quill", img: null, kind: "post", poll: null }, club);
  if (!ownerPost.ok) throw new Error("no post");
  {
    const commentsOf = async () => (await original([["HLEN", `nl:cm:${cid}:c:${ownerPost.post.id}`]]))[0];
    const before = await commentsOf();
    for (const [what, reply] of shapes(1)) {
      is(`a comment, ${what}: refused as "error"`, await withOdd(hmget(HANDLES), reply, () => press({ action: "comment", post: ownerPost.post.id, from: "post", text: `Thanks @zed-quill (${what})` })), "error");
    }
    is("and no comment was written", await commentsOf(), before);
    is("control: the comment goes in", await press({ action: "comment", post: ownerPost.post.id, from: "post", text: "Thanks @zed-quill" }), "commented");
    is("control: and it is written", Number(await commentsOf()), Number(before) + 1);
  }

  // What the pages show: Zed's post and comment, a room line said before names were kept with it, a conversation,
  // a notice, points, an event Zed is coming to.
  const zedPost = await createPost(cid, { space, author: zed.k, title: "Zed writes", text: "A post by Zed", img: null, kind: "post", poll: null }, club);
  if (!zedPost.ok) throw new Error("no post");
  await addComment(cid, zedPost.post.id, { parent: "", author: zed.k, text: "Zed again" }, club);
  const said = await say(cid, config.chat, zed.k, false, "Zed in the room");
  if (!said.ok) throw new Error("not said");
  const sent = await send(cid, config.dm, zed.k, CREATOR, "Hello creator", club);
  if (!("ok" in sent) || !sent.ok) throw new Error(`not sent ${JSON.stringify(sent)}`);
  await tell(cid, [CREATOR], { kind: "reply", post: zedPost.post.id, comment: "", by: zed.k, words: "A post by Zed" }, club);
  await award(cid, zed.k, 1, club);
  const event = await createEvent(club, { title: "Zed night", about: "A synthetic call.", start: Date.now() + 86_400_000, minutes: 60, tz: "UTC", where: "room", link: "", meet: null, only: [], cap: 0 });
  if (!event.ok) throw new Error("no event");
  if ((await rsvp(cid, event.event, zed.k, club)) !== "added") throw new Error("no rsvp");

  const handle = { handle: `@${club.handle}` };
  const pages: [string, () => Promise<ReactNode>, string][] = [
    ["the feed", () => CommunityPage({ params: Promise.resolve(handle), searchParams: Promise.resolve({}) }), "Zed Quill"],
    ["a post", () => CommunityPostPage({ params: Promise.resolve({ ...handle, post: zedPost.post.id }), searchParams: Promise.resolve({}) }), "Zed Quill"],
    ["the room", () => CommunityChatPage({ params: Promise.resolve(handle) } as never), "Zed Quill"],
    ["the leaderboard", () => CommunityLeaderboardPage({ params: Promise.resolve(handle), searchParams: Promise.resolve({}) }), "Zed Quill"],
    ["messages", () => MessagesPage({ params: Promise.resolve(handle), searchParams: Promise.resolve({}) }), "Zed Quill"],
    ["a conversation", () => MessageThreadPage({ params: Promise.resolve({ ...handle, pair: pairOf(CREATOR, zed.k) }), searchParams: Promise.resolve({}) }), "Zed Quill"],
    ["notifications", () => NotificationsPage({ params: Promise.resolve(handle) } as never), "Zed Quill"],
  ];

  part("Screens: names that did not read");
  for (const [what, page, name] of pages) {
    const html = await draw(page);
    is(`${what}, control: drawn with the name, no notice`, [html.startsWith("PAGE_FAILED") ? html.slice(0, 160) : "drawn", html.includes(name), html.includes(NAMES)], ["drawn", true, false]);
    const broken = await withOdd(hmget(MEMBERS), ["QUEUED"], () => draw(page));
    is(`${what}, names unread: drawn, not failed`, typeof broken === "string" && broken.startsWith("PAGE_FAILED") ? broken.slice(0, 160) : "drawn", "drawn");
    is(`${what}, names unread: says so, as a status`, typeof broken === "string" && new RegExp(`role="status"[^>]*>${NAMES.replace(/\./g, "\\.")}`).test(broken), true);
  }
  {
    // The post that names @zed-quill (Zed's own post names nobody, so its page asks for no @ at all).
    const named = () => CommunityPostPage({ params: Promise.resolve({ ...handle, post: ownerPost.post.id }), searchParams: Promise.resolve({}) });
    const html = await draw(named);
    is("a post naming somebody, control: the @ is a link to them, no notice", [html.startsWith("PAGE_FAILED"), /@zed-quill<\/a>|>@zed-quill</.test(html), html.includes(NAMES)], [false, true, false]);
    const broken = await withOdd(hmget(HANDLES), ["QUEUED"], () => draw(named));
    is("a post, its @s unread: drawn, and says some names could not be loaded", [typeof broken === "string" && broken.startsWith("PAGE_FAILED"), typeof broken === "string" && broken.includes(NAMES)], [false, true]);
  }

  part("Screens: the members list and the members search");
  {
    const members = () => CommunityMembersPage({ params: Promise.resolve(handle), searchParams: Promise.resolve({}) });
    const html = await draw(members);
    is("members, control: Zed is listed, no notice", [html.startsWith("PAGE_FAILED") ? html.slice(0, 160) : "drawn", html.includes("Zed Quill"), html.includes(LIST)], ["drawn", true, false]);
    for (const [label, match] of [["its page", (c: Command[]) => c.length === 1 && c[0][0] === "ZREVRANGEBYSCORE"], ["its records", hmget(MEMBERS)]] as const) {
      const broken = await withOdd(match, ["QUEUED"], () => draw(members));
      is(`members, ${label} unread: drawn, says the list could not be loaded, never an empty list`, [typeof broken === "string" && broken.startsWith("PAGE_FAILED"), typeof broken === "string" && broken.includes(LIST)], [false, true]);
    }
    const search = () => CommunitySearchPage({ params: Promise.resolve(handle), searchParams: Promise.resolve({ q: "zed", k: "member" }) });
    const found = await draw(search);
    is("search, control: Zed is found among members", [found.startsWith("PAGE_FAILED") ? found.slice(0, 160) : "drawn", found.includes("Zed Quill"), found.includes(SEARCH)], ["drawn", true, false]);
    const unread = await withOdd(hmget(MEMBERS), ["QUEUED"], () => draw(search));
    is("search, members unread: says the members could not be searched, never No match", [typeof unread === "string" && unread.includes(SEARCH), typeof unread === "string" && /No match/.test(unread)], [true, false]);
  }

  part("directorySize and releaseHandle, read exactly");
  {
    // directorySize read its ZCARD as `Number(n) || 0`: a reply lost or in another shape was "0 members listed".
    const zcard = (c: Command[]) => c.length === 1 && c[0][0] === "ZCARD";
    is("control: the directory counts the one member listed", await directorySize(cid), 1);
    for (const [what, reply] of [["no reply at all", []], ["a hole", [undefined]], ["a word", ["QUEUED"]], ["a count as text", ["1"]], ["a negative count", [-1]], ["a fraction", [1.5]], ["a thrown pipeline", "throw"]] as [string, unknown][]) {
      is(`directorySize, ${what}: unknown, never a count`, await withOdd(zcard, reply, () => directorySize(cid)), "thrown");
    }
    const members = () => CommunityMembersPage({ params: Promise.resolve(handle), searchParams: Promise.resolve({}) });
    const fine = await draw(members);
    // The privacy promise is true whatever the count: it is said with the count, and without it when the count did not read.
    const PRIVACY = /Only the name each chose is shown; nobody(&#x27;|')s email address is, ever\./;
    const privacyTimes = (html: unknown) => (typeof html === "string" ? (html.match(new RegExp(PRIVACY.source, "g")) ?? []).length : -1);
    is("members, control: the count is said, with the privacy promise once", [fine.startsWith("PAGE_FAILED") ? fine.slice(0, 160) : "drawn", fine.includes("1 member has chosen to be listed"), fine.includes(LIST), privacyTimes(fine)], ["drawn", true, false, 1]);
    const unknown = await withOdd(zcard, ["QUEUED"], () => draw(members));
    // Rule 23: one expected value added (the privacy promise, said once); the four before it are unchanged.
    is(
      "members, the count unread: drawn, no number, says the list could not be loaded, and still says nobody's email address is shown",
      [typeof unknown === "string" && unknown.startsWith("PAGE_FAILED"), typeof unknown === "string" && /chosen to be listed/.test(unknown), typeof unknown === "string" && unknown.includes(LIST), typeof unknown === "string" && unknown.includes("Zed Quill"), privacyTimes(unknown)],
      [false, false, true, true, 1],
    );
    // In every store language: the promise said alone is exactly the second sentence of the count, word for word.
    const words = (await import("@/lib/buyer-words/community-names-unread")) as Record<string, unknown>;
    const alone = typeof words.listedPrivacy === "function" ? (words.listedPrivacy as (language: unknown) => string) : null;
    const PROMISES: Record<string, string> = {
      en: "Only the name each chose is shown; nobody's email address is, ever.",
      es: "Solo se muestra el nombre que eligió cada uno; la dirección de email de nadie, nunca.",
      fr: "Seul le nom choisi par chacun est affiché\u00a0; jamais l'adresse e-mail de personne.",
      de: "Gezeigt wird nur der Name, den jeder gewählt hat, niemals eine E-Mail-Adresse.",
      it: "Si vede solo il nome scelto da ciascuno; l'indirizzo email di nessuno, mai.",
      nl: "Alleen de naam die ieder koos wordt getoond; nooit iemands e-mailadres.",
      pt: "Só se mostra o nome que cada um escolheu; nunca o endereço de email de ninguém.",
    };
    for (const [language, promise] of Object.entries(PROMISES)) {
      const said = alone ? alone(language) : null;
      is(`the privacy promise alone, ${language}: the count's own second sentence, no number in it`, [said, said !== null && communityWords(language).listedTotal(3).endsWith(` ${said}`)], [promise, true]);
    }

    // releaseHandle sent its HDEL and never read the answer: a release lost or in another shape passed as done.
    await original([["HSET", HANDLES, "gone-soon", "x".repeat(zed.k.length)]]);
    is("releaseHandle, control: a handle held is given back (true), and then is not there (false)", [await releaseHandle(cid, "gone-soon"), await releaseHandle(cid, "gone-soon")], [true, false]);
    await original([["HSET", HANDLES, "gone-soon", "x".repeat(zed.k.length)]]);
    const hdel = (c: Command[]) => c.length === 1 && c[0][0] === "HDEL" && c[0][1] === HANDLES;
    for (const [what, reply] of [["no reply at all", []], ["a word", ["QUEUED"]], ["a count as text", ["1"]], ["a count of two", [2]], ["a thrown pipeline", "throw"]] as [string, unknown][]) {
      const quiet = console.error;
      const logged: string[] = [];
      console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
      odd = { match: hdel, reply };
      let outcome: unknown;
      try {
        outcome = await releaseHandle(cid, "gone-soon");
      } catch (error) {
        outcome = error instanceof Error ? error.name : "thrown";
      } finally {
        odd = null;
        console.error = quiet;
      }
      is(`releaseHandle, ${what}: refused (never true or false) and logged`, [outcome, logged.some((l) => /handle/.test(l) && /gone-soon/.test(l))], [what === "a thrown pipeline" ? "Error" : "UnknownReplyError", true]);
    }
  }

  part("The room's route: names that did not read are said, never 'A member'");
  {
    const ask = () => chatGet(new NextRequest(`https://marktmorgen.com/api/store/community/chat?handle=${club.handle}`, { headers: { cookie } })).then((r) => r.json() as Promise<{ ok?: boolean; names?: Record<string, string>; namesUnread?: boolean }>);
    const fine = await ask();
    is("control: the member's name, nothing unread", [fine.ok, fine.names?.[zed.k], fine.namesUnread ?? false], [true, "Zed Quill", false]);
    const lost = await withOdd(hmget(MEMBERS), ["QUEUED"], ask);
    is("names unread: the room still answers, says so, and gives no false name", [typeof lost === "object" && lost.ok, typeof lost === "object" && lost.namesUnread, typeof lost === "object" && lost.names?.[zed.k]], [true, true, undefined]);
  }

  part("The studio: who is coming, with their names unread");
  {
    const studio = () => StudioCommunityPage({ searchParams: Promise.resolve({ store: club.sid }) });
    const html = await draw(studio);
    is("control: the studio names who is coming", [html.startsWith("PAGE_FAILED") ? html.slice(0, 160) : "drawn", html.includes("zed@membersexact.example")], ["drawn", true]);
    const broken = await withOdd(hmget(MEMBERS), ["QUEUED"], () => draw(studio));
    is("names unread: the studio is drawn, says who is coming could not be read, never a list without them", [typeof broken === "string" && broken.startsWith("PAGE_FAILED"), typeof broken === "string" && broken.includes(STUDIO_PEOPLE)], [false, true]);
  }

  cookieValues.clear();
  done();
}

void main();
