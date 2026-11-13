/**
 * A change to a community member's record (lib/community.ts patchMember) is
 * said done only once its read and its write were answered in their exact
 * shape (CX-123 rule 24; CAN-SPAM 15 U.S.C. 7704(a)(4) and GDPR art. 21(3):
 * an unsubscribe is never confirmed without being recorded).
 *
 * patchMember read the member's record loosely: a reply that was missing, cut
 * short or of another shape parsed to null, the same as Redis's own nil, and
 * every caller took null for "no record" and went on as if it were done:
 *
 *   - the stop link (app/api/mail/unsubscribe, stopAnnouncements, setMail)
 *     answered "Unsubscribed." while the member's `mail` stayed on and the
 *     announcements kept coming;
 *   - the creator's mute from a post (app/api/store/community) answered
 *     "muted-member" with nothing written;
 *   - the studio's removal (app/api/store/community/manage) answered 404
 *     "unknown", as if the member were gone;
 *   - a member's stop-link token (tokenFor, setMemberToken) went unsaved, so
 *     the email carried a stop link that would not be known.
 *
 * Its write (the compare-and-set script) was read with Number(...), so "1"
 * as text was taken for done. And the stop door and page called
 * readCommunityUnsub, which throws on an unknown member read since #3123,
 * without catching it: an unhandled 500 and a broken page.
 *
 * The real routes and functions over the in-memory Redis (tests/redis-stub.ts),
 * with only the member read, the member write or the stop link's read answered
 * differently. The compare-and-set script is run here as Redis would (the
 * stand-in runs no unmarked script). Controls: a record Redis says is not
 * there (nil) behaves exactly as before. Synthetic records only.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import UnsubscribePage from "@/app/unsubscribe/page";
import { POST as unsubscribePost } from "@/app/api/mail/unsubscribe/route";
import { POST as communityPost } from "@/app/api/store/community/route";
import { POST as managePost } from "@/app/api/store/community/manage/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { createPost, freshConfig, memberKey, readMember, saveConfig, setMail, type Member } from "@/lib/community";
import { readCommunityUnsub, stopAnnouncements, tokenFor } from "@/lib/community-mail";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];

/**
 * Which pipeline is answered differently: the one `match` picks after `skip`
 * of them have gone through as Redis would, with `reply` (or what it throws).
 */
let odd: { match: (commands: Command[]) => boolean; skip: number; reply: () => unknown } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  if (odd && odd.match(commands)) {
    if (odd.skip > 0) odd.skip -= 1;
    else return odd.reply();
  }
  // lib/community.ts CAS_MEMBER, as Redis runs it: the record written only over the one it was read as.
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith('local cur = redis.call("HGET"')) {
    const [, , , members, dir, field, expected, next, listed, at] = commands[0];
    const [cur] = await pipeline([["HGET", members, field]]);
    if (cur !== expected) return [0];
    await pipeline([["HSET", members, field, next], listed === "1" ? ["ZADD", dir, at, field] : ["ZREM", dir, field]]);
    return [1];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

/** Runs `act` with one pipeline answered differently; "thrown" when it threw. */
async function withOdd<T>(match: (commands: Command[]) => boolean, skip: number, reply: unknown, act: () => Promise<T>): Promise<T | "thrown"> {
  const quiet = console.error;
  console.error = () => {};
  odd = { match, skip, reply: () => reply };
  try {
    return await act();
  } catch {
    return "thrown";
  } finally {
    odd = null;
    console.error = quiet;
  }
}

/** Resolves the page's async server children, as the unsubscribe render test does. */
async function settle(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(settle));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === "function") {
    return settle(await (element.type as (props: unknown) => ReactNode | Promise<ReactNode>)(element.props));
  }
  return "children" in element.props ? cloneElement(element, undefined, await settle(element.props.children)) : element;
}
async function page(query: Record<string, string>): Promise<string> {
  return renderToStaticMarkup(await settle(await UnsubscribePage({ searchParams: Promise.resolve(query) })));
}

/** The one-click stop a mail app posts (RFC 8058), or the page's button: status, body and where it goes. */
async function stopPress(token: string, fromPage = false): Promise<{ status: number; text: string; to: string }> {
  const form = new FormData();
  if (fromPage) form.set("from", "page");
  const response = await unsubscribePost(new NextRequest(`https://marktmorgen.com/api/mail/unsubscribe?c=${token}`, { method: "POST", body: form }));
  return { status: response.status, text: await response.text(), to: response.headers.get("location") ?? "" };
}

const SHAPES: [string, unknown][] = [
  ["no reply at all", []],
  ["a hole where the record was", [undefined]],
  ["a number", [42]],
  ["text that is not a record", ["{bad"]],
  ["a record without its mute and removal", [JSON.stringify({ k: "x", e: "x@example.test" })]],
];

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "club@patchmember.example";
  const made = await claimHandle(OWNER, "patchmemberclub", "Patch Member Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PatchMember1", subscriptionId: "sub_PatchMember1", active: true, tier: "creator", period: paidPeriod() });
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const cid = club.community!.id;
  await saveConfig(cid, freshConfig(club.name));
  const members = `nl:cm:${cid}:m`;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;

  let n = 0;
  /** A member as touchMember writes one, with their emails on and a stop link of their own. */
  async function member(): Promise<{ key: string; token: string; email: string }> {
    n += 1;
    const email = `member${n}@patchmember.example`;
    const key = memberKey(email);
    const token = n.toString(16).padStart(40, "a");
    const record: Member = { k: key, e: email, n: `Member ${n}`, h: "", dir: false, mail: true, at: 1, seen: 1, muted: false, removed: false, t: token, q: [], qa: 0, qq: [] };
    await redis.pipeline([["HSET", members, key, JSON.stringify(record)], ["SET", `nl:cm:unsub:${token}`, `${cid}|${key}|${club.handle}`]]);
    return { key, token, email };
  }
  const memberRead = (key: string) => (commands: Command[]) => commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === members && commands[0][2] === key;
  const memberWrite = (key: string) => (commands: Command[]) => commands.length === 1 && commands[0][0] === "EVAL" && commands[0].includes(key) && commands[0].includes(members);
  const linkRead = (token: string) => (commands: Command[]) => commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:cm:unsub:${token}`;
  const mailOf = async (key: string) => (await readMember(cid, key))?.mail;
  const mutedOf = async (key: string) => (await readMember(cid, key))?.muted;

  part("The stop link, when the member's record cannot be read for the change");
  for (const [what, reply] of SHAPES) {
    const m = await member();
    // The first read (readCommunityUnsub's) answers; the change's own read is the one in another shape.
    is(`${what}: stopAnnouncements is not done`, await withOdd(memberRead(m.key), 1, reply, () => stopAnnouncements(m.token)), "thrown");
    is(`${what}: the one-click stop answers 503, never "Unsubscribed."`, (await withOdd(memberRead(m.key), 1, reply, () => stopPress(m.token))) as unknown as { status: number }, { status: 503, text: "We could not save that just now. Please try again in a minute.", to: "" });
    const fromPage = await withOdd(memberRead(m.key), 1, reply, () => stopPress(m.token, true));
    is(`${what}: from the page it goes back with done=0`, fromPage !== "thrown" && fromPage.to.endsWith(`/unsubscribe?c=${m.token}&done=0`), true);
    is(`${what}: and the emails are still on`, await mailOf(m.key), true);
    is(`${what}: once the record reads, the stop is saved`, [await stopPress(m.token).then((r) => [r.status, r.text]), await mailOf(m.key)], [[200, "Unsubscribed."], false]);
  }

  part("The stop link, when the change's write is answered in another shape");
  for (const [what, reply] of [["no reply at all", []], ["a hole", [undefined]], ["one as text", ["1"]], ["OK", ["OK"]], ["two", [2]]] as [string, unknown][]) {
    const m = await member();
    is(`${what}: the one-click stop answers 503, never "Unsubscribed."`, await withOdd(memberWrite(m.key), 0, reply, () => stopPress(m.token).then((r) => r.status)), 503);
    is(`${what}: setMail itself is not done`, await withOdd(memberWrite(m.key), 0, reply, async () => { await setMail(cid, (await readMember(cid, m.key))!, false); return "done"; }), "thrown");
  }

  part("The stop page after a press that was not saved");
  {
    const m = await member();
    const html = await page({ c: m.token, done: "0" });
    is("says it could not be saved, and offers the button again", [html.includes("We could not save that just now. Please try again."), html.includes(`/api/mail/unsubscribe?c=${m.token}`)], [true, true]);
    const fresh = await page({ c: m.token });
    is("opened by hand, says nothing of the kind", fresh.includes("We could not save that just now"), false);
  }

  part("The stop door and page, when the link or its member cannot be read at all");
  for (const [what, reply] of SHAPES) {
    const m = await member();
    is(`the member read as ${what}: the one-click stop answers 503, not a crash`, await withOdd(memberRead(m.key), 0, reply, () => stopPress(m.token).then((r) => r.status)), 503);
    const html = await withOdd(memberRead(m.key), 0, reply, () => page({ c: m.token }));
    is(`the member read as ${what}: the page still opens, says it could not open the link, offers no button and never says it is unknown`, html !== "thrown" && [html.includes("We could not open this link just now"), html.includes("<form"), html.includes("This link is not one we know")], [true, false, false]);
    is(`the member read as ${what}: emails still on`, await mailOf(m.key), true);
  }
  for (const [what, reply] of [["no reply at all", []], ["a hole", [undefined]], ["a number", [42]]] as [string, unknown][]) {
    const m = await member();
    is(`the link read as ${what}: readCommunityUnsub does not say there is no such link`, await withOdd(linkRead(m.token), 0, reply, () => readCommunityUnsub(m.token)), "thrown");
    is(`the link read as ${what}: the one-click stop answers 503, never "Not found."`, await withOdd(linkRead(m.token), 0, reply, () => stopPress(m.token).then((r) => r.status)), 503);
    const html = await withOdd(linkRead(m.token), 0, reply, () => page({ c: m.token }));
    is(`the link read as ${what}: the page never says the link is unknown`, html !== "thrown" && [html.includes("We could not open this link just now"), html.includes("This link is not one we know")], [true, false]);
  }

  part("The creator's mute from a post");
  for (const [what, reply] of SHAPES) {
    const m = await member();
    const made = await createPost(cid, { space: freshConfig(club.name).spaces[0].id, author: m.key, title: "", text: `Hello ${what}`, img: null, kind: "post", poll: null }, club);
    if (!made.ok) throw new Error("no post");
    const form = new FormData();
    form.set("handle", club.handle);
    form.set("action", "mute");
    form.set("post", made.post.id);
    form.set("from", "post");
    const press = () => communityPost(new NextRequest("https://marktmorgen.com/api/store/community", { method: "POST", headers: { cookie }, body: form })).then((r) => (r.headers.get("location") ?? "").replace(/^.*[?&]n=/, ""));
    is(`${what}: never "muted-member" with nothing written`, await withOdd(memberRead(m.key), 0, reply, press), "error");
    is(`${what}: and the member is not muted`, await mutedOf(m.key), false);
    is(`${what}: once it reads, the mute is written`, [await press(), await mutedOf(m.key)], ["muted-member", true]);
  }

  part("The studio's removal");
  const manage = async (body: Record<string, unknown>) => {
    const response = await managePost(new NextRequest("https://marktmorgen.com/api/store/community/manage", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": club.sid, cookie }, body: JSON.stringify(body) }));
    return [response.status, ((await response.json()) as { error?: string }).error ?? "ok"];
  };
  for (const [what, reply] of SHAPES) {
    const m = await member();
    const removal = () => manage({ action: "member", key: m.key, removed: true });
    is(`${what}: answered as not confirmed (503), never 404 "unknown"`, await withOdd(memberRead(m.key), 0, reply, removal), [503, "not_confirmed"]);
    is(`${what}: once it reads, the removal is written`, [await removal(), (await readMember(cid, m.key))?.removed], [[200, "ok"], true]);
  }

  part("A member's stop link token");
  {
    const m = await member();
    await redis.pipeline([["HSET", members, m.key, JSON.stringify({ ...(await readMember(cid, m.key))!, t: "" })]]);
    const fresh = (await readMember(cid, m.key))!;
    is("an unknown read never hands out a stop link that was not kept", await withOdd(memberRead(m.key), 0, [7], () => tokenFor(club, cid, fresh)), "thrown");
    is("and no token was written on the member", (await readMember(cid, m.key))?.t, "");
    const token = await tokenFor(club, cid, fresh);
    is("once it reads, the token is kept and its link is known", [(await readMember(cid, m.key))?.t === token, (await readCommunityUnsub(token))?.member.k], [true, m.key]);
  }

  part("Controls: a record Redis says is not there (nil) behaves as before");
  {
    const m = await member();
    const before = (await readMember(cid, m.key))!;
    await redis.pipeline([["HDEL", members, m.key]]);
    is("setMail hands back the member it was given", await setMail(cid, before, false), before);
    is("the stop link answers 404 \"Not found.\"", await stopPress(m.token).then((r) => [r.status, r.text]), [404, "Not found."]);
    is("the page says the link is not one we know", (await page({ c: m.token })).includes("This link is not one we know"), true);
    is("the studio's removal answers 404 \"unknown\"", await manage({ action: "member", key: m.key, removed: true }), [404, "unknown"]);
    const made = await createPost(cid, { space: freshConfig(club.name).spaces[0].id, author: m.key, title: "", text: "Hello nil", img: null, kind: "post", poll: null }, club);
    if (!made.ok) throw new Error("no post");
    const form = new FormData();
    form.set("handle", club.handle);
    form.set("action", "mute");
    form.set("post", made.post.id);
    const where = (await communityPost(new NextRequest("https://marktmorgen.com/api/store/community", { method: "POST", headers: { cookie }, body: form }))).headers.get("location") ?? "";
    is("the mute from a post answers as before", where.replace(/^.*[?&]n=/, ""), "muted-member");
    is("and no record is made", (await redis.pipeline([["HEXISTS", members, m.key]]))[0], 0);
  }
  done();
}

void main();
