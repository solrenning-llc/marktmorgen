/**
 * The questions someone starting out asks about teams and stores (534 [FQ1],
 * unit 20, lib/team-faq.ts; added 2 November 2026). Checked: the Team page's
 * own words, read from its file; the role names; the team managed by the
 * owner alone; the invitation's link working once, for the code's days, with
 * no password, and nothing kept when its email is not sent; no plan asked of
 * the inviting route; several stores per account; removal read on every
 * request; the shared trial answer in both states; no figure; first in the
 * page's own Questions block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { TEAM_WORDS, teamBeginnerQuestions } from "@/lib/team-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { INVITE_DAYS, ROLE_NAMES, can } from "@/lib/team-roles";
import { INVITE_DAYS as SERVER_INVITE_DAYS } from "@/lib/team";
import { MAX_STORES_PER_ACCOUNT } from "@/lib/store";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const ui = flat(read("components/team-manager.tsx"));
const studio = flat(read("app/studio/page.tsx"));
is("the studio tool, for the owner alone", [studio.includes('may("team")'), studio.includes('studioPath(store, "", "team")'), can("owner", "team"), can("admin", "team"), can("editor", "team"), can("support", "team")], [true, true, true, false, false, false]);
is("the invite form's heading, field, roles legend and button, as written in the form", [`>${TEAM_WORDS.invite}<`, `> ${TEAM_WORDS.email} <`, `>${TEAM_WORDS.role}<`, TEAM_WORDS.send].map((w) => ui.includes(w)), [true, true, true, true]);
is("the link works once and there is no password, as the form says", ui.includes("They get a link that works once,") && ui.includes("There is no password:"), true);
const server = flat(read("lib/team.ts"));
is("the invitation's days are the server's own", [INVITE_DAYS, SERVER_INVITE_DAYS === INVITE_DAYS, server.includes("It works once and stops working in ${INVITE_DAYS} days.")], [7, true, true]);
is("an email not sent keeps nothing, as the form says", ui.includes("could not be sent just now, so nothing was kept"), true);
const route = read("app/api/store/team/route.ts");
is("inviting asks for no plan", /planOf|planStanding|PLANS_ON_SALE|canSell/.test(route), false);
is("removal is read from the store's record on every request", server.includes("counts from their very next"), true);
is("one account, several stores", MAX_STORES_PER_ACCOUNT > 1, true);
is("the three roles by their own names", [ROLE_NAMES.admin, ROLE_NAMES.editor, ROLE_NAMES.support], ["Admin", "Editor", "Support"]);

part("The answers");
const now = teamBeginnerQuestions(false);
const later = teamBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What are teams and stores here?", "How do I invite someone?", "Can I try it before paying?", "Do I have to share my login?"]);
is("invite: the studio's own words, in order, and the owner alone", [(() => { const a = answer(now, "How do I invite someone?"); const at = Object.values(TEAM_WORDS).map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), answer(now, "How do I invite someone?").includes("Only the store's owner manages the team.")], [true, true]);
is("try before paying: the one shared answer, in a team's words", [answer(now, "Can I try it before paying?"), answer(later, "Can I try it before paying?")], [tryBeforePaying("A team", "a team", false), tryBeforePaying("A team", "a team", true, TRIAL_DAYS)]);
is("login: no, each their own", answer(now, "Do I have to share my login?").startsWith("No. Each person signs in with their own email"), true);
is("invite: the code's days, and nothing kept when unsent", [answer(now, "How do I invite someone?").includes(`for ${INVITE_DAYS} days`), answer(now, "How do I invite someone?").includes("nothing was kept")], [true, true]);
is("no store said to have a plan while none is on sale", /Stripe account and plan|its own plan\b/.test(answer(now, "What are teams and stores here?")), false);
is("one space between sentences, never two", /\s{2}/.test([...now, ...later].map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of teams, stores or sales, no percent, no result promised", /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(teams|stores|sales|buyers|creators)|\d+%|guarantee|proven|results?\b/i.test(all), false);

part("On the teams and stores page");
const faq = (findPage("platform", "teams-and-stores")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
