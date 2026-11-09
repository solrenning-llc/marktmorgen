/**
 * A member's key never reaches another member, and a private message goes
 * only to somebody the sender could find (audit N2, 9 November 2026).
 *
 * A member's key is lib/learn.ts emailKey: an unsalted sha256 of a fixed
 * prefix and their address, the same in every store. Shown to other members
 * (the directory's and the search's "Message" links, the conversation list,
 * the "to" of a conversation, the leaderboard and the live room), anybody who
 * knows an address could confirm the person is a member, follow them from one
 * store to the next, and keep tying their posts to the address after an
 * erasure. And the messages route took any key as the recipient, so a member
 * who chose not to be listed got requests from whoever knew their address.
 *
 * Here the pages and the routes are run with their real code, and everything
 * they hand the browser (the HTML and the props of every component, the React
 * keys included, the JSON a route answers and the address it redirects to) is
 * searched for the key of every person in the community.
 */
import { NextRequest } from "next/server";
import { communityViewer } from "@/lib/community-access";
import { freshConfig, saveConfig } from "@/lib/community";
import { parseChatSetting } from "@/lib/community-chat";
import { parseDmSetting, pairOf, requestCount, accept } from "@/lib/community-dm";
import { award } from "@/lib/community-points";
import { emailKey, mintPass, passCookieName } from "@/lib/learn";
import { roomPass } from "@/lib/chat-pass";
import { MEMBER_ALIAS, aliasOf, memberOfAlias } from "@/lib/community-alias";
import { POST as messagesRoute } from "@/app/api/store/community/messages/route";
import { GET as chatGet, POST as chatPost } from "@/app/api/store/community/chat/route";
import { GET as chatNew } from "@/app/api/store/community/chat/new/route";
import MembersPage from "@/app/[handle]/community/members/page";
import MessagesPage from "@/app/[handle]/community/messages/page";
import ThreadPage from "@/app/[handle]/community/messages/[pair]/page";
import LeaderboardPage from "@/app/[handle]/community/leaderboard/page";
import ChatPage from "@/app/[handle]/community/chat/page";
import { answering } from "./security/next-headers";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const CLUB = "club@alias.example";
const ME = "me@alias.example";
const LISTED = "listed@alias.example";
const UNLISTED = "unlisted@alias.example";
const REMOVED = "removed@alias.example";
const STRANGER = "stranger@alias.example";
const PEOPLE = [ME, LISTED, UNLISTED, REMOVED, STRANGER];

/**
 * Everything of a rendered element tree that can reach the browser: text, the
 * React key of every element, and the props of every element and component
 * (a client component's props are sent as they are). Server components are
 * called and walked into; one that cannot be called outside React (a client
 * component using hooks) is left with its props recorded.
 */
async function sent(node: unknown, out: string[] = []): Promise<string[]> {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const one of node) await sent(one, out);
    return out;
  }
  if (node instanceof Promise) return sent(await node, out);
  if (typeof node !== "object" || !("$$typeof" in node)) return out;
  const element = node as unknown as { type: unknown; key: unknown; props: Record<string, unknown> };
  if (element.key !== null && element.key !== undefined) out.push(String(element.key));
  const { children, ...rest } = element.props ?? {};
  out.push(JSON.stringify(rest, (_name, value) => (typeof value === "function" ? undefined : value)));
  if (typeof element.type === "function") {
    let rendered: unknown;
    try {
      rendered = await (element.type as (props: unknown) => unknown)(element.props);
    } catch {
      await sent(children, out);
      return out;
    }
    return sent(rendered, out);
  }
  return sent(children, out);
}

/** A page rendered, or what it threw (a redirect, by its digest), as text. */
async function page(render: () => unknown): Promise<string> {
  try {
    return (await sent(await render())).join("\n");
  } catch (error) {
    return `thrown: ${(error as { digest?: string }).digest ?? String(error)}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  if (!(await claimHandle(CLUB, "aliasclub", "Alias Club", "")).ok) throw new Error("no store");
  await ensureStatsId(CLUB);
  await ensureStoreId(CLUB);
  await ensureListId(CLUB);
  await setSubscription(CLUB, { customerId: "cus_Alias00001", subscriptionId: "sub_Alias00001", active: true, tier: "creator", period: paidPeriod() });
  const ticket = await addProduct(CLUB, "Club pass", "", "0", null);
  if (!ticket.ok) throw new Error("no product");
  await setCommunity(CLUB, true);
  const club: Store = (await storeForEmail(CLUB))!;
  const cid = club.community!.id;
  await saveConfig(cid, { ...freshConfig(club.name), access: [ticket.product.id], chat: parseChatSetting({ on: true }), dm: parseDmSetting({ on: true, between: true }) });

  // A member's own choices and the creator's removal, written as patchMember writes them (the stub runs no EVAL):
  // the record, and the directory that lists those named, asking to be listed and not removed.
  const patch = async (email: string, change: Record<string, unknown>) => {
    const [raw] = await redis.pipeline([["HGET", `nl:cm:${cid}:m`, emailKey(email)]]);
    const next = { ...JSON.parse(String(raw)), ...change };
    await redis.pipeline([
      ["HSET", `nl:cm:${cid}:m`, emailKey(email), JSON.stringify(next)],
      next.dir && next.n && !next.removed ? ["ZADD", `nl:cm:${cid}:dir`, next.at, emailKey(email)] : ["ZREM", `nl:cm:${cid}:dir`, emailKey(email)],
    ]);
  };
  const cookies = new Map<string, string>();
  for (const email of [ME, LISTED, UNLISTED, REMOVED]) {
    await redis.pipeline([["SET", `nl:cm:${cid}:ok:${emailKey(email)}`, JSON.stringify({ v: 1, ok: true })]]);
    const token = await mintPass(club, email, "all");
    cookies.set(email, `${passCookieName(club)}=${token}`);
    const viewer = await communityViewer(club, { get: (name: string) => (name === passCookieName(club) ? { value: token } : undefined) } as never);
    if (viewer.state !== "in" || !viewer.member) throw new Error(`${email} is not in`);
    const name = email.split("@")[0];
    const shown = `${name[0].toUpperCase()}${name.slice(1)} Person`;
    await patch(email, { n: shown, h: shown.toLowerCase().replace(/ /g, ""), dir: email !== UNLISTED });
    await award(cid, viewer.member.k, 1, club);
  }
  await patch(REMOVED, { removed: true });
  const keys = PEOPLE.map(emailKey);
  const leaks = (text: string) => keys.filter((k) => text.includes(k)).map((k) => PEOPLE[keys.indexOf(k)]);
  const params = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ handle: `@${club.handle}`, ...extra }), searchParams: Promise.resolve({}) });
  const as = (email: string) => answering(new Request(`${ORIGIN}/@${club.handle}/community`, { headers: { cookie: cookies.get(email)!, host: "marktmorgen.com" } }));

  const send = async (from: string, to: string, text = "hello") => {
    const res = await messagesRoute(
      new NextRequest(`${ORIGIN}/api/store/community/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Host: "marktmorgen.com", cookie: cookies.get(from)! },
        body: new URLSearchParams({ handle: club.handle, action: "send", to, text }).toString(),
      }),
    );
    return res.headers.get("location") ?? `status ${res.status}`;
  };
  const written = async (from: string, to: string) => {
    const [n] = await redis.pipeline([["EXISTS", `nl:cm:${cid}:dm:${pairOf(emailKey(from), emailKey(to))}`]]);
    return Number(n) === 1;
  };

  part("The member directory: what it hands the browser carries nobody's key");
  as(ME);
  const membersText = await page(() => MembersPage(params()));
  is("control: the listed member is shown", membersText.includes("Listed Person"), true);
  is("no key of anybody in it (links, React keys, component props)", leaks(membersText), []);
  const links = [...membersText.matchAll(/\/community\/messages\/([^"\\?#\s]+)/g)].map((m) => m[1]);
  const toListed = links.find((link) => link !== "creator") ?? "";
  is("control: the directory offers a link to write to the listed member", toListed !== "", true);

  part("Writing through the directory's link reaches the listed member, and the answer names no key");
  const viaLink = await send(ME, toListed);
  is("the request is written", await written(ME, LISTED), true);
  is("the redirect carries no key", leaks(viaLink), []);

  part("Nobody can be written to by a key worked out from an address");
  const refusedTo = new Map<string, string>();
  for (const email of [UNLISTED, REMOVED, STRANGER]) refusedTo.set(email, (await send(ME, emailKey(email))).replace(/^.*\?/, "?"));
  is("an unlisted member's key is refused, nothing written", await written(ME, UNLISTED), false);
  is("a removed member's key is refused, nothing written", await written(ME, REMOVED), false);
  is("a non-member's key is refused, nothing written", await written(ME, STRANGER), false);
  is("the three are answered alike", new Set(refusedTo.values()).size, 1);
  is("and no request waits on any of them", [await requestCount(cid, emailKey(UNLISTED)), await requestCount(cid, emailKey(STRANGER))], [0, 0]);

  part("A conversation already open goes on after the other person leaves the directory");
  await accept(cid, emailKey(LISTED), pairOf(emailKey(ME), emailKey(LISTED)));
  await patch(LISTED, { dir: false });
  const followUp = await send(ME, toListed, "still here?");
  is("the follow-up is sent", followUp.endsWith("n=dmsent"), true);
  is("its redirect carries no key", leaks(followUp), []);

  part("The conversation list and the conversation hand the browser no key");
  as(LISTED);
  const list = await page(() => MessagesPage(params()));
  is("control: the conversation with Me is listed", list.includes("Me Person"), true);
  is("the list carries no key", leaks(list), []);
  const threadLink = [...list.matchAll(/\/community\/messages\/([^"\\?#\s]+)/g)].map((m) => m[1])[0] ?? "";
  is("control: the list links to the conversation", threadLink !== "", true);
  const thread = await page(() => ThreadPage({ ...params(), params: Promise.resolve({ handle: `@${club.handle}`, pair: threadLink }) }));
  is("control: the conversation shows what was said", thread.includes("still here?"), true);
  is("the conversation (its reply form's 'to' included) carries no key", leaks(thread), []);

  part("A request is answered by the other person's alias, from the form the page draws");
  is("control: an unlisted member may still write to a listed one", (await send(UNLISTED, aliasOf(cid, emailKey(ME)), "may I ask?")).endsWith("n=dmasked"), true);
  as(ME);
  const asked = await page(() => MessagesPage(params()));
  const answerWith = /name="with" value="([^"]+)"|"name":"with","value":"([^"]+)"/.exec(asked);
  const withAlias = answerWith?.[1] ?? answerWith?.[2] ?? "";
  is("the decline form carries the asker's alias", withAlias, aliasOf(cid, emailKey(UNLISTED)));
  const declined = await messagesRoute(
    new NextRequest(`${ORIGIN}/api/store/community/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Host: "marktmorgen.com", cookie: cookies.get(ME)! },
      body: new URLSearchParams({ handle: club.handle, action: "decline", with: withAlias }).toString(),
    }),
  );
  is("declined: the request is gone", [declined.headers.get("location")?.endsWith("n=dmdeclined"), await requestCount(cid, emailKey(ME))], [true, 0]);

  part("The alias: one per member and community, turned back only on the server, unknown fails closed");
  const mine = aliasOf(cid, emailKey(ME));
  const elsewhere = aliasOf("0123456789abcdef0123456789abcdef", emailKey(ME));
  is("an alias has its own form, never a key's", MEMBER_ALIAS.test(mine) && !mine.includes(emailKey(ME)), true);
  is("it turns back into the member's key in its own community", memberOfAlias(cid, mine), emailKey(ME));
  is("another community knows the same person by another alias", elsewhere !== mine && elsewhere !== "", true);
  is("and that alias is nobody here", memberOfAlias(cid, elsewhere) === emailKey(ME), false);
  is("the creator is 'creator' both ways", [aliasOf(cid, "creator"), memberOfAlias(cid, "creator")], ["creator", "creator"]);
  is("a raw key, a pair or rubbish is no alias", [memberOfAlias(cid, emailKey(ME)), memberOfAlias(cid, pairOf(emailKey(ME), emailKey(LISTED))), memberOfAlias(cid, "m12")], ["", "", ""]);
  const secret = process.env.NIMBUS_DATA_KEY;
  const stripe = process.env.STRIPE_SECRET_KEY;
  delete process.env.NIMBUS_DATA_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  is("without the deployment's secret there is no alias either way", [aliasOf(cid, emailKey(ME)), memberOfAlias(cid, mine)], ["", ""]);
  process.env.NIMBUS_DATA_KEY = secret;
  if (stripe !== undefined) process.env.STRIPE_SECRET_KEY = stripe;

  part("The leaderboard and the live room hand the browser no key");
  as(ME);
  const board = await page(() => LeaderboardPage(params()));
  is("control: the leaderboard shows the listed member", board.includes("Listed Person"), true);
  is("the leaderboard carries no key", leaks(board), []);
  const said = await chatPost(
    new NextRequest(`${ORIGIN}/api/store/community/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "marktmorgen.com", cookie: cookies.get(LISTED)! },
      body: JSON.stringify({ handle: club.handle, action: "say", text: "hi room" }),
    }),
  );
  const saidText = await said.text();
  is("control: the listed member says something in the room", said.status, 200);
  is("the answer to saying it carries no key", leaks(saidText), []);
  const read = await chatGet(new NextRequest(`${ORIGIN}/api/store/community/chat?handle=${club.handle}`, { headers: { cookie: cookies.get(ME)!, Host: "marktmorgen.com" } }));
  const readText = await read.text();
  is("control: the room is read", readText.includes("hi room"), true);
  is("reading the room carries no key", leaks(readText), []);
  const shared = await chatNew(new NextRequest(`${ORIGIN}/api/store/community/chat/new?c=${cid}&p=${roomPass(cid)}&s=0`));
  const sharedText = await shared.text();
  is("control: the shared read of the room answers", sharedText.includes("hi room"), true);
  is("the shared read carries no key", leaks(sharedText), []);
  const room = await page(() => ChatPage(params()));
  is("control: the room page shows the message", room.includes("hi room"), true);
  is("the room page (its client component's props included) carries no key", leaks(room), []);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
