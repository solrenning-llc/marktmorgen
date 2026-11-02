/**
 * The questions someone starting out asks about Discord access (534 [FQ1],
 * unit 17, lib/discord-faq.ts; added 2 November 2026). Checked: the studio's
 * own words, read from its files; the page there only with Discord's keys and
 * for those who may change settings; the code's limits and check interval;
 * the routes waiting on no plan; the shared trial answer in both states; no
 * figure; first in the page's own Questions block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { DISCORD_WORDS, discordBeginnerQuestions } from "@/lib/discord-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { CHECK_HOURS, MAX_DISCORD_PRODUCTS, MAX_PRODUCT_ROLES } from "@/lib/discord-rules";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const ui = flat(read("components/discord-studio.tsx"));
const studio = flat(read("app/studio/page.tsx"));
const page = flat(read("app/studio/discord/page.tsx"));
is("the studio tool, its connect button, its roles heading, its save, and who joined", [studio.includes(`title: "${DISCORD_WORDS.tool}"`), ui.includes(`connect("${DISCORD_WORDS.connect}")`), ui.includes(DISCORD_WORDS.roles), ui.includes(`"Saving…" : "${DISCORD_WORDS.save}"`), ui.includes(DISCORD_WORDS.joined)], [true, true, true, true, true]);
is("the buyer's own button", read("lib/buyer-words/discord.ts").includes(`joinButton: "${DISCORD_WORDS.join}"`), true);
is("who joined: their name on Discord, the address, the roles and the day joined, and gone once access ended", [["On Discord", "Bought with", "Roles", "Joined"].every((h) => ui.includes(`>${h}</th>`)), ui.includes("Somebody whose access ended is taken off this list")], [true, true]);
is("nothing taken while Stripe or Discord cannot be reached, as the studio says", page.includes("While Stripe or Discord cannot be reached, or Discord will not let the bot remove a role, nothing is taken until it can be."), true);
is("joining needs a paid order or an orders link", /order|orders/.test(read("app/api/store/discord/join/route.ts")), true);
is("the tool only with Discord's keys and for those who may change settings, and the page too", [/may\("settings"\) && isDiscordConfigured\(\)/.test(studio), page.includes("if (!isDiscordConfigured()) redirect(studioPath(store));"), /studioView\(await cookies\(\),[^;]*"settings"\)/.test(page)], [true, true, true]);
is("connecting needs a server you may manage, as the studio says", ui.includes("you need to be allowed to manage that server"), true);
is("the routes wait on no plan: a paid window is reserved only for a funded period", [["app/api/store/discord/route.ts", "app/api/store/discord/connect/route.ts"].some((f) => /isPaidUp|canSell\(/.test(read(f))), ["app/api/store/discord/route.ts", "app/api/store/discord/connect/route.ts"].every((f) => /reservePaidResourceWindow/.test(read(f)))], [false, true]);
is("the limits the page writes by hand, and the check interval the studio says", [JSON.stringify(findPage("platform", "discord-access")).includes("Up to three roles for each product, on up to 20 products"), MAX_PRODUCT_ROLES, MAX_DISCORD_PRODUCTS, /about every \$\{CHECK_HOURS\} hours/.test(page)], [true, 3, 20, true]);

part("The answers");
const now = discordBeginnerQuestions(false);
const later = discordBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What is Discord access here?", "How do I connect my server?", "Can I try Discord access before paying?", "How many people use Discord access?"]);
is("the limits and the check from the code", answer(now, "What is Discord access here?").includes(`up to ${MAX_PRODUCT_ROLES} roles for each product, on up to ${MAX_DISCORD_PRODUCTS} products`) && answer(now, "What is Discord access here?").includes(`about every ${CHECK_HOURS} hours`), true);
is("connect: the studio's own words, in order, who sees it, and when it is not there", [(() => { const a = answer(now, "How do I connect my server?"); const at = [DISCORD_WORDS.tool, DISCORD_WORDS.connect, DISCORD_WORDS.roles, DISCORD_WORDS.save].map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), answer(now, "How do I connect my server?").includes(`Only the store's owner and Admins see “${DISCORD_WORDS.tool}” in the studio`), answer(now, "How do I connect my server?").includes("if you are one of them and it is not there, it is not switched on yet on our side")], [true, true, true]);
const who = " Only the owner and Admins can, once Discord is switched on on our side.";
is("try before paying: the shared answer, who can, and no buyer joining while plans are off sale", [answer(now, "Can I try Discord access before paying?"), answer(later, "Can I try Discord access before paying?")], [tryBeforePaying("Discord access", "the connection to your server and the roles each product gives", false) + who + " Paid plans are not on sale yet, so no buyer can join from a purchase now.", tryBeforePaying("Discord access", "the connection to your server and the roles each product gives", true, TRIAL_DAYS) + who]);
is("how many: no figure, the studio's own list", [answer(now, "How many people use Discord access?").startsWith("We publish no number"), answer(now, "How many people use Discord access?").includes(`Under “${DISCORD_WORDS.joined}”`)], [true, true]);
is("one space between sentences, never two", /\s{2}/.test([...now, ...later].map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of servers, members or sales, no percent, no result promised", /\b\d+\s+(servers|members|sales|buyers|creators)|\d+%|guarantee|proven|results?\b/i.test(all), false);

part("On the Discord page");
const faq = (findPage("platform", "discord-access")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
