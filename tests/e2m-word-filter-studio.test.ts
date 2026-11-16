/**
 * 113 [E2-COMMUNITY-MODERATION], unit 2.2 (Claude 6, 16 November 2026): the
 * studio's community page, drawn for real over the in-memory Redis, with the
 * creator's words to check and the reason each post or comment waits.
 *
 *   - a community that never set a list shows an empty form, links off;
 *   - a saved list shows its words, one a line, and whether links hold;
 *   - a list saved and not read says so, and that everything waits until it
 *     is saved again, rather than showing an empty list as if none were set;
 *   - an item held by the words says which word to the creator, next to
 *     Approve and Don't publish; one held only by a space's setting says no
 *     reason; the form is only for those who may change the settings.
 *
 * Synthetic stores, people and words only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import StudioCommunityPage from "@/app/studio/community/page";
import { CommunityApprovalStudio } from "@/components/community-approval-studio";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { freshConfig, saveConfig } from "@/lib/community";
import { holdComment, holdPost } from "@/lib/community-approval";
import { claimHandle, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { cookieValues } from "./meeting-withdrawal-page-world";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const decode = (html: string) => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

async function main(): Promise<void> {
  redis.clear();
  cookieValues.clear();
  const owner = "words-owner@example.com";
  await claimHandle(owner, "wordsproof", "Words proof", "A community.");
  await ensureStatsId(owner);
  await setSubscription(owner, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  await setCommunity(owner, true);
  const store = (await storeForEmail(owner))!;
  const id = store.community!.id;
  const config = freshConfig(store.name);
  await saveConfig(id, config);
  cookieValues.set(SESSION_COOKIE, await openSession(owner));
  const draw = async () => {
    const page = await StudioCommunityPage({ searchParams: Promise.resolve({ store: store.sid }) });
    return decode(renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {} } as never }, page)));
  };
  const area = (html: string) => html.match(/<textarea[^>]*id="cm-words"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? null;
  const linksOn = (html: string) => /<input[^>]*type="checkbox"[^>]*checked=""[^>]*>\s*<span class="text-sm"><span class="block font-semibold text-ink">Also hold a post or comment with more than 2 links/.test(html);

  part("Never set: an empty form, links off");
  let html = await draw();
  is("the section is there, with its label", [/Words to check/.test(html), /<label for="cm-words"[^>]*>Words and phrases, one on each line \(up to 50, each up to 40 characters\)<\/label>/.test(html)], [true, true]);
  is("an empty list, links off", [area(html), linksOn(html)], ["", false]);
  is("nothing said about an unreadable list", /could not be read, so every post/.test(html), false);

  part("A saved list shows as saved");
  await saveConfig(id, { ...config, filter: { words: ["crypto", "free money"], links: true } });
  html = await draw();
  is("one a line", area(html), "crypto\nfree money");
  is("links on", linksOn(html), true);
  is("counted for the creator", /2 of 50 on the list/.test(html), true);

  part("Held items say why, to the creator");
  const ada = "a".repeat(31) + "1";
  const post = await holdPost(id, { space: config.spaces[0].id, author: ada, title: "Hi", text: "Ask me about crypto", img: null, kind: "post", poll: null }, ROOM, undefined, { kind: "word", word: "crypto" });
  const comment = await holdComment(id, { post: "123456789abc", space: config.spaces[0].id, parent: "", author: ada, text: "By the setting" }, ROOM);
  if (!post.ok || !comment.ok) throw new Error("not held");
  html = await draw();
  is("the word that held it", html.includes('Held for you to look at: it uses "crypto", which is on your list of words to check.'), true);
  is("one held only by the space's setting gives no word", html.match(/Held for you to look at/g)?.length, 1);
  is("both still have Approve", html.match(/>Approve</g)?.length, 2);
  is("the queue says what holds things", /held by a space&#x27;s approval setting or by your words to check|held by a space's approval setting or by your words to check/.test(html), true);

  part("A list that does not read says so");
  const raw = JSON.parse(String(redis.run(["GET", `nl:cm:${id}:cfg`])));
  redis.run(["SET", `nl:cm:${id}:cfg`, JSON.stringify({ ...raw, filter: { words: "crypto" } })]);
  html = await draw();
  is("said, with what it means and how to fix it", /Your saved list could not be read, so every post and comment from members waits for you\. Save the list again to fix it\./.test(html), true);

  part("Only for those who may change the settings");
  const moderator = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {} } as never }, createElement(CommunityApprovalStudio, { rules: [], queue: [], canSettings: false, filter: { words: ["crypto"], links: false, unreadable: false } })));
  is("a moderator without settings sees the queue, not the form", [/Waiting for approval/.test(moderator), /Words to check/.test(moderator)], [true, false]);

  cookieValues.clear();
  done();
}

void main();
