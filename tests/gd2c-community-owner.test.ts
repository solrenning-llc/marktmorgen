/**
 * 568 [GD2] (c), the community: what the store itself puts before its members never poses as Marktmorgen.
 *
 * A post, an announcement emailed to every member, a comment, a message in the live room or a private message that
 * reads "Marktmorgen Support: verify your account" goes out in the store's name, inside a page that runs on
 * marktmorgen.com: a phishing message with our name on both ends. With the real routes on the in-memory database, a
 * real creator session and a real member pass:
 *
 *   - the creator's post (its title, its text, a poll's answers, a picture's description), comment, rewrite of either,
 *     room message and private message that poses is refused with the "imitation" notice (the room: "imitation",
 *     409), and nothing is written; a rewrite that poses leaves the words kept as they were;
 *   - the creator's plain words, saying the store runs on Marktmorgen and the protective opposite pass as before;
 *   - what a member writes is never held to it: the same words from a member are posted, commented, said and sent;
 *   - the notice and the room's refusal are in every store language, drawn as a warning, and the room knows the reason.
 *
 * Synthetic store, member and data only; nothing is emailed.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { CREATOR, freshConfig, postCount, readComments, readMember, readPost, saveConfig } from "@/lib/community";
import { communityViewer } from "@/lib/community-access";
import { parseChatSetting, refusalWords, room } from "@/lib/community-chat";
import { inbox, parseDmSetting } from "@/lib/community-dm";
import { COMMUNITY_WORDS, communityWords } from "@/lib/buyer-words/community";
import { communityNotices } from "@/components/community-parts";
import { emailKey, mintPass, passCookieName } from "@/lib/learn";
import { POST as communityRoute } from "@/app/api/store/community/route";
import { POST as chatRoute } from "@/app/api/store/community/chat/route";
import { POST as messagesRoute } from "@/app/api/store/community/messages/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ORIGIN = "https://marktmorgen.com";
const OWNER = "club@gd2ccommunity.example";
const MEMBER = "member@gd2ccommunity.example";
const POSING = "Marktmorgen Support: your account is locked until you verify it.";

async function main(): Promise<void> {
  redis.clear();
  if (!(await claimHandle(OWNER, "gd2cclub", "Posing Club", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Gd2cClub01", subscriptionId: "sub_Gd2cClub01", active: true, tier: "creator", period: paidPeriod() });
  const ticket = await addProduct(OWNER, "Club pass", "", "0", null);
  if (!ticket.ok) throw new Error("no product");
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const cid = club.community!.id;
  await saveConfig(cid, { ...freshConfig(club.name), access: [ticket.product.id], chat: parseChatSetting({ on: true, links: true }), dm: parseDmSetting({ on: true, between: true }) });
  await redis.pipeline([["SET", `nl:cm:${cid}:ok:${emailKey(MEMBER)}`, JSON.stringify({ v: 1, ok: true })]]);

  const ownerCookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const memberCookie = `${passCookieName(club)}=${await mintPass(club, MEMBER, "all")}`;
  const viewer = await communityViewer(club, { get: (name: string) => (name === passCookieName(club) ? { value: memberCookie.split("=")[1] } : undefined) } as never);
  if (viewer.state !== "in" || !viewer.member) throw new Error(`the member is not in: ${viewer.state}`);
  const memberKey = viewer.key;
  const [record] = await redis.pipeline([["HGET", `nl:cm:${cid}:m`, memberKey]]);
  await redis.pipeline([["HSET", `nl:cm:${cid}:m`, memberKey, JSON.stringify({ ...JSON.parse(String(record)), n: "Member One" })]]);
  if (!(await readMember(cid, memberKey))?.n) throw new Error("no name");

  const headers = (cookie: string, type: string) => ({ "Content-Type": type, Origin: ORIGIN, Host: "marktmorgen.com", "Sec-Fetch-Site": "same-origin", cookie });
  /** The community's form, as the page sends it; answers the notice word it was sent back with, and where. */
  const form = async (cookie: string, fields: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    body.set("handle", club.handle);
    for (const [name, value] of Object.entries(fields)) for (const one of [value].flat()) body.append(name, one);
    const response = await communityRoute(new NextRequest(`${ORIGIN}/api/store/community`, { method: "POST", headers: headers(cookie, "application/x-www-form-urlencoded"), body: body.toString() }));
    const location = new URL(response.headers.get("location") ?? `${ORIGIN}/`);
    return { status: response.status, n: location.searchParams.get("n"), post: /\/post\/([^/?#]+)/.exec(location.pathname)?.[1] ?? "" };
  };
  const owner = (fields: Record<string, string | string[]>) => form(ownerCookie, fields);
  const member = (fields: Record<string, string | string[]>) => form(memberCookie, fields);
  const say = async (cookie: string, text: string) => {
    const response = await chatRoute(new NextRequest(`${ORIGIN}/api/store/community/chat`, { method: "POST", headers: headers(cookie, "application/json"), body: JSON.stringify({ handle: club.handle, action: "say", text }) }));
    return { status: response.status, ...((await response.json()) as { ok?: boolean; error?: string }) };
  };
  const message = async (cookie: string, to: string, text: string) => {
    const response = await messagesRoute(
      new NextRequest(`${ORIGIN}/api/store/community/messages`, { method: "POST", headers: headers(cookie, "application/x-www-form-urlencoded"), body: new URLSearchParams({ handle: club.handle, action: "send", to, text }).toString() }),
    );
    return new URL(response.headers.get("location") ?? `${ORIGIN}/`).searchParams.get("n");
  };

  part("The creator's plain post is posted");
  const plain = await owner({ action: "post", title: "Welcome", text: "Glad you are here. This club runs on Marktmorgen, like the store." });
  is("posted", [plain.status, plain.n, await postCount(cid)], [303, "posted", 1]);

  part("The creator's post that poses is refused, and nothing is written");
  is("its text", [(await owner({ action: "post", title: "Notice", text: POSING })).n, await postCount(cid)], ["imitation", 1]);
  is("its title", [(await owner({ action: "post", title: "Regards, The Marktmorgen Team", text: "Read this." })).n, await postCount(cid)], ["imitation", 1]);
  is("an announcement emailed to every member", [(await owner({ action: "post", kind: "announcement", email: "1", text: "Sign in at https://marktmorgen-login.com to keep your place." })).n, await postCount(cid)], ["imitation", 1]);
  is(
    "a poll's answer",
    [(await owner({ action: "post", title: "Which day?", text: "", poll: "1", poll_option: ["Monday", "Reply with your Marktmorgen password"], poll_days: "3" })).n, await postCount(cid)],
    ["imitation", 1],
  );
  is("a picture's description (refused before any picture is taken)", [(await owner({ action: "post", text: "Our new room.", img: "community/x/none.webp", img_w: "10", img_h: "10", img_alt: "Official Marktmorgen notice" })).n, await postCount(cid)], ["imitation", 1]);

  part("The protective opposite is posted");
  const opposite = await owner({ action: "post", text: "Marktmorgen will never ask for your password. Neither will I." });
  is("posted", [opposite.n, await postCount(cid)], ["posted", 2]);

  part("A comment and a rewrite by the creator");
  is("a plain comment is added", [(await owner({ action: "comment", post: plain.post, text: "Ask me anything below." })).n, (await readComments(cid, plain.post)).length], ["commented", 1]);
  is("a comment that poses is refused, nothing added", [(await owner({ action: "comment", post: plain.post, text: "This is Marktmorgen: confirm your account." })).n, (await readComments(cid, plain.post)).length], ["imitation", 1]);
  is("a rewrite that poses is refused, and the post keeps its words", [(await owner({ action: "edit", post: plain.post, title: "Welcome", text: POSING })).n, (await readPost(cid, plain.post))?.text], ["imitation", "Glad you are here. This club runs on Marktmorgen, like the store."]);
  const comment = (await readComments(cid, plain.post))[0];
  is("a comment's rewrite that poses is refused, and the comment keeps its words", [(await owner({ action: "edit-comment", post: plain.post, comment: comment.id, text: POSING })).n, (await readComments(cid, plain.post))[0].text], ["imitation", "Ask me anything below."]);
  is("a plain rewrite is saved", (await owner({ action: "edit", post: plain.post, title: "Welcome", text: "Glad you are here." })).n, "edited");

  part("A member's own words are never held to it");
  const theirs = await member({ action: "post", text: POSING });
  is("a member's post with the same words is posted", [theirs.n, await postCount(cid)], ["posted", 3]);
  is("a member's comment with the same words is added", (await member({ action: "comment", post: plain.post, text: POSING })).n, "commented");

  part("The live room");
  is("the creator's plain message is said", [(await say(ownerCookie, "Hello, everybody.")).ok, (await room(cid, 0)).messages.length], [true, 1]);
  is("the creator's message that poses is refused with 409 \"imitation\", nothing said", [await say(ownerCookie, POSING), (await room(cid, 0)).messages.length], [{ status: 409, ok: false, error: "imitation" }, 1]);
  is("a member's message with the same words is said", [(await say(memberCookie, POSING)).ok, (await room(cid, 0)).messages.length], [true, 2]);

  part("Private messages");
  is("the creator's plain message is sent", /^dm(sent|asked)$/.test((await message(ownerCookie, memberKey, "Thanks for joining.")) ?? ""), true);
  const sentBefore = (await inbox(cid, memberKey, true)).length + (await inbox(cid, memberKey)).length;
  is("the creator's message that poses is refused, nothing sent", [await message(ownerCookie, memberKey, POSING), (await inbox(cid, memberKey, true)).length + (await inbox(cid, memberKey)).length], ["imitation", sentBefore]);
  is("a member's message with the same words to the creator is sent", /^dm(sent|asked)$/.test((await message(memberCookie, CREATOR, POSING)) ?? ""), true);

  part("What the creator is told, in every store language");
  for (const language of Object.keys(COMMUNITY_WORDS)) {
    const words = communityWords(language);
    is(`${language}: the notice says nothing was posted, saved or sent, and is a warning`, [typeof words.notices.imitation === "string" && words.notices.imitation.length > 80, communityNotices(language).imitation?.tone], [true, "warn"]);
    is(`${language}: the room's refusal`, typeof words.refusals.imitation === "string" && words.refusals.imitation.length > 80, true);
  }
  is("English notice", communityWords("en").notices.imitation, "Nothing was posted, saved or sent: it reads as if it came from Marktmorgen itself (its sign-in, its account or its staff), or it links to an address made to look like ours. Write as yourself, in your own name, and link only to your own pages or to marktmorgen.com. Marktmorgen never asks anyone for a password.");
  is("the room's English refusal and the library's agree", refusalWords("imitation", 0), communityWords("en").refusals.imitation);
  is("the room page takes it as a reason of its own", /"resting", "imitation", "unknown"/.test(readFileSync("components/community-room.tsx", "utf8")), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
