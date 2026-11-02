/**
 * The questions someone starting out asks about live events (534 [FQ1],
 * unit 29, lib/live-events-faq.ts; added 2 November 2026). Checked: the
 * studio's own words, read from its file, in the order the answer gives them;
 * the events drawn only once the community is set up; scheduling for whoever
 * may run events; a sale or a free copy needing the plan or its trial; the
 * shared trial answer in both states; no sentence said twice on the page; no
 * figure; first in the page's own Questions block.
 */
import { readFileSync } from "node:fs";
import { EVENT_WORDS, liveEventsBeginnerQuestions } from "@/lib/live-events-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { TRIAL_DAYS } from "@/lib/plan";
import { can } from "@/lib/team-roles";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
const w = EVENT_WORDS;

part("The studio's own words and rules");
const page = flat(read("app/studio/community/page.tsx"));
const panel = flat(read("components/community-events-studio.tsx"));
is("events only once the community is set up, managed by whoever may run events", [page.includes("events={ config ? ( <CommunityEventsStudio"), page.includes('canManage={can(view.role, "events")}'), can("owner", "events"), can("admin", "events"), can("editor", "events"), can("support", "events")], [true, true, true, true, true, false]);
is("the part's title, the button, the fields and the confirm, as the studio says them", [panel.includes(`>${w.part}</h2>`), panel.includes(` ${w.schedule} </button>`), panel.includes(`>${w.title}</label>`), panel.includes(`>${w.when}</legend>`), panel.includes(`>${w.where}</legend>`), panel.includes(`mode === "new" ? "${w.confirm}" : "Save"`)], [true, true, true, true, true, true]);
const studioPanel = flat(read("components/community-studio.tsx"));
const route = read("app/api/store/community/events/route.ts");
is("setting up is the owner's or an Admin's, its button; scheduling needs it set up, not switched on; members see nothing while it is off", [studioPanel.includes(`: "${w.setUp}"}`), can("admin", "settings"), can("editor", "settings"), route.includes('if (!store || !id || !config) return fail("not_set_up");'), /community\?\.on/.test(route), read("lib/community-access.ts").includes('if (!store.community?.on) return { state: "off" };')], [true, true, false, true, false, true]);
is("only the title starts empty; when and where are filled in, the private room first", [panel.includes('className="field mt-1" required maxLength={MAX_EVENT_TITLE}'), panel.includes('where: event?.where ?? "room",')], [true, true]);
is("the announcement is a post, not an email; reminders only to those who RSVP and opted in", [panel.includes(`>${w.announce}</span>`), panel.includes("An announcement post with the time and a link to RSVP. Not emailed."), flat(read("lib/community-event-mail.ts")).includes("coming AND asked to be emailed by the community")], [true, true, true]);
is("a sale or a free copy needs the plan or its trial; bought-over buyers come in too, and importing asks for no plan", [flat(read("lib/store-checkout.ts")).includes("isPaidUp(store) &&"), flat(read("lib/free.ts")).includes("isPaidUp(store) &&"), read("lib/community-access.ts").includes("(await broughtOver(store, email,"), /isPaidUp\(/.test(read("app/api/store/import/route.ts"))], [true, true, true, false]);

part("The answers, in both states");
const now = liveEventsBeginnerQuestions(false, TRIAL_DAYS);
const later = liveEventsBeginnerQuestions(true, TRIAL_DAYS);
is("three questions", now.map((x) => x.q), ["How do I schedule my first event?", "Is anyone told when I schedule an event?", "Can I try live events before paying?"]);
const how = answer(now, "How do I schedule my first event?");
is("scheduling: the community set up first by the owner or an Admin, the studio's words in order, seen once switched on", [how.startsWith("Events live inside your community, so the owner or an Admin sets that up first"), how.endsWith("Members see it once the community is switched on."), (() => { const at = [w.tool, w.setUp, w.part, w.schedule, w.title, w.when, w.where, w.confirm].map((x) => how.indexOf(`“${x}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })()], [true, true, true]);
const tryNow = answer(now, "Can I try live events before paying?");
const tryLater = answer(later, "Can I try live events before paying?");
is("try before paying: the shared answer, then members by an event's own name, bought, free or brought over", [tryNow.startsWith(tryBeforePaying("A live event", "a live event", false, TRIAL_DAYS)), tryLater.startsWith(tryBeforePaying("A live event", "a live event", true, TRIAL_DAYS)), tryNow.includes("Members come to an event through a product"), tryNow.includes("which needs your store's plan, or held by buyers"), tryLater.includes("which needs your store's plan or its trial, or held by buyers"), /Members come to it\b/.test(tryNow + tryLater)], [true, true, true, true, true, false]);
is("told: not by email, the feed post, reminders only on RSVP and consent", answer(now, "Is anyone told when I schedule an event?").startsWith(`Not by email. It shows in your community, and with “${w.announce}” checked`), true);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("one space between sentences, never two", /\s{2}/.test(all), false);
is("no figure but the trial's days, no percent, no result promised", [/\d/.test(all.split(`${TRIAL_DAYS}-day`).join("")), /%|guarantee|attendance|proven/i.test(all)], [false, false]);

part("On the live events page");
const topic = findPage("platform", "live-events");
const faq = (topic?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { items: { q: string; a: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 3).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);
const shared = [tryBeforePaying("A live event", "a live event", false, TRIAL_DAYS), tryBeforePaying("A live event", "a live event", true, TRIAL_DAYS)].join(" ");
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 20 && !shared.includes(x));
const rest = JSON.stringify({ ...topic, blocks: (topic?.blocks ?? []).map((b) => ((b as { kind?: string }).kind === "faq" ? { ...b, items: faq?.items.slice(3) } : b)) });
is("no sentence of the answers said elsewhere on the page, or twice among them", [now, later].map((l) => { const mine = l.flatMap((x) => sentences(x.a)); return mine.some((x) => rest.includes(x)) || new Set(mine).size !== mine.length; }), [false, false]);

done();
