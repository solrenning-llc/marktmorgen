/**
 * 766 [STN13], unit 4: a bell that keeps what needs the creator apart from
 * news. Built only from the store record every studio page already holds, so
 * it reads nothing more. The rules (lib/bell-rules.ts), the panel
 * (components/studio-bell.tsx) and its place beside "Help for this screen"
 * under the studio's top bar (components/studio-header.tsx).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { MOST_NEWS, bellView, type BellFacts } from "@/lib/bell-rules";
import { StudioBell } from "@/components/studio-bell";
import { StudioHeader } from "@/components/studio-header";
import type { Role } from "@/lib/team-roles";
import { done, is, part } from "./check";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const NOW = Date.UTC(2026, 10, 9, 15, 0); // 9 November 2026, 15:00 UTC
const S = NOW / 1000;
const quiet = { sid: "s1", subscriptionActive: true, suspended: "", strikes: [], stripeAccountId: "acct_1", stripeChargesEnabled: true, renewalUnpaidSince: 0, planDisputes: [] };
const store = (facts: BellFacts = {}) => ({ ...quiet, ...facts });
const ids = (items: { id: string }[]) => items.map((item) => item.id);
const draw = (facts: BellFacts = {}, role: Role = "owner") => renderToStaticMarkup(createElement(StudioBell, { store: store(facts), role, now: NOW }));
const strike = (at: string, what: string) => ({ at, what, report: "r1" });

part("Nothing to say");
is("a store with nothing wrong: nothing needs the creator, and no news", bellView(store(), "owner", NOW), { needs: [], news: [] });
const calm = draw();
is("the panel says so in one sentence, and its button carries no number", [calm.includes("Nothing needs you right now."), /<summary[^>]*>.*Notifications<\/summary>/.test(calm)], [true, true]);
is("no News part with nothing in it", calm.includes("News"), false);
is("a record without these facts (an older shape) is the same quiet bell", bellView({ sid: "s1" }, "owner", NOW), { needs: [], news: [] });

part("What needs the creator, each with the way to it");
is(
  "the plan's renewal payment did not go through: to the studio home's own notice",
  bellView(store({ renewalUnpaidSince: S - 3600 }), "editor", NOW).needs,
  [{ id: "renewal", words: "Your plan's renewal payment did not go through.", link: { href: "/studio?store=s1#renewal-unpaid", label: "See what to do about your plan's payment" } }],
);
is("that notice is there, by that name", read("components/renewal-unpaid-notice.tsx").includes('id="renewal-unpaid"'), true);
const open = { id: "du_1", status: "open" as const, at: S - 86_400, coversUntil: S + 86_400 };
is(
  "a plan payment disputed with the bank, on a plan that is paid up: to its notice",
  bellView(store({ planDisputes: [open] }), "support", NOW).needs,
  [{ id: "plan-disputed", words: "A payment for your plan is disputed with your bank.", link: { href: "/studio?store=s1#plan-disputed", label: "Read what a disputed plan payment pauses" } }],
);
is("that notice is there, by that name", read("components/plan-dispute-notice.tsx").includes('id="plan-disputed"'), true);
is(
  "the same test the studio home draws its notice by: not on a plan that is not paid up, nor once the bank decided for the creator",
  [ids(bellView(store({ planDisputes: [open], subscriptionActive: false }), "owner", NOW).needs), ids(bellView(store({ planDisputes: [{ ...open, status: "won" as const }] }), "owner", NOW).needs)],
  [[], []],
);
is("the studio home draws it by that test", /current\.subscriptionActive && planDisputed\(current\)/.test(read("app/studio/page.tsx")), true);
is(
  "the store switched off after notices about its content",
  bellView(store({ suspended: "2026-11-02T10:00:00.000Z" }), "owner", NOW).needs,
  [{ id: "suspended", words: "Your store's pages and sales are switched off after notices about its content. To send a counter-notice, reply to the email we sent you about it.", link: { href: "/copyright", label: "Read our policy on content notices" } }],
);
is(
  "Stripe has not let the store take payments yet: to the store check, for whoever may open it",
  bellView(store({ stripeChargesEnabled: false }), "admin", NOW).needs,
  [{ id: "stripe", words: "Stripe has not let your store take payments yet.", link: { href: "/studio/checkup?store=s1", label: "Check what Stripe still needs" } }],
);
is(
  "not for a role that cannot open the store check, nor for a store with no Stripe account yet (its first steps say so)",
  [ids(bellView(store({ stripeChargesEnabled: false }), "editor", NOW).needs), ids(bellView(store({ stripeChargesEnabled: false, stripeAccountId: null }), "owner", NOW).needs)],
  [[], []],
);
is(
  "all at once, in that order",
  ids(bellView(store({ renewalUnpaidSince: 1, planDisputes: [open], suspended: "2026-11-02T10:00:00.000Z", stripeChargesEnabled: false }), "owner", NOW).needs),
  ["renewal", "plan-disputed", "suspended", "stripe"],
);

part("News: only what was taken down, with its date");
is(
  "each piece taken down, newest first as the record keeps them",
  bellView(store({ strikes: [strike("2026-11-03T12:00:00.000Z", "the product “Pattern pack”"), strike("2026-10-28T09:00:00.000Z", "a post in the community")] }), "owner", NOW).news,
  [
    { id: "taken-down-0", words: "Taken down on November 3, 2026: the product “Pattern pack”.", link: null },
    { id: "taken-down-1", words: "Taken down on October 28, 2026: a post in the community.", link: null },
  ],
);
is("a time that cannot be read is left out of the words, never made up", bellView(store({ strikes: [strike("soon", "a lesson")] }), "owner", NOW).news, [{ id: "taken-down-0", words: "Taken down: a lesson.", link: null }]);
const many = Array.from({ length: MOST_NEWS + 2 }, (_, i) => strike(`2026-10-${String(20 - i).padStart(2, "0")}T00:00:00.000Z`, `item ${i}`));
const manyNews = bellView(store({ strikes: many }), "owner", NOW).news;
is(`at most ${MOST_NEWS}, then how many more, where they are`, [MOST_NEWS, manyNews.length, manyNews.at(-1)], [5, MOST_NEWS + 1, { id: "taken-down-more", words: "And 2 earlier, each in the email we sent you about it.", link: null }]);

part("The panel");
const full = draw({ renewalUnpaidSince: 1, stripeChargesEnabled: false, strikes: [strike("2026-11-03T12:00:00.000Z", "a lesson")] });
is("a native disclosure, closed even with something waiting: it never interrupts", [/^<details[ >]/.test(full), /<details\b[^>]*?\sopen(=""|\s|>)/.test(full)], [true, false]);
is("its button says how many need the creator, in words", [/<summary[^>]*>.*Notifications: 2 need you<\/summary>/.test(full), /<summary[^>]*>.*Notifications: 1 needs you<\/summary>/.test(draw({ renewalUnpaidSince: 1 }))], [true, true]);
is("the two parts, by name: what needs you first, then news", [full.indexOf("Needs you") > -1, full.indexOf("News") > full.indexOf("Needs you")], [true, true]);
is("each link says where it goes", [full.includes(`href="/studio?store=s1#renewal-unpaid"`) && full.includes("See what to do about your plan&#x27;s payment"), full.includes(`href="/studio/checkup?store=s1"`) && full.includes("Check what Stripe still needs")], [true, true]);
is("the news line in full", full.includes("Taken down on November 3, 2026: a lesson."), true);
is("nothing is announced when the page opens, and no heading sits above the page's own title", /aria-live|role="(status|alert)"|<h[1-6]\b/.test(full), false);
const controls = full.match(/<(summary|a)\b[^>]*>/g) ?? [];
is("every control is at least 44 px tall with its words centered in it", controls.length >= 3 && controls.every((tag) => /\bmin-h-11\b/.test(tag) && /\bitems-center\b/.test(tag)), true);
is("the text stays within 80 characters a line", /max-w-\[80ch\]/.test(full), true);
const source = read("components/studio-bell.tsx") + read("lib/bell-rules.ts");
is("it opens in the page, never over the menu", /\b(absolute|fixed|sticky)\b/.test(read("components/studio-bell.tsx")), false);
is("it reads and sends nothing: no database, no provider, no request", /lib\/redis|lib\/stripe|\bfetch\(/.test(source), false);

part("Under the top bar of every studio screen, beside the help");
const header = (current: Record<string, unknown>, role: Role = "owner") =>
  renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: {} as never },
      createElement(PathnameContext.Provider, { value: "/studio/bundles" }, createElement(StudioHeader, { current: { name: "Harbor", handle: "harbor", ...current, sid: "s1" }, role, stores: [], owned: 1, action: { href: "/studio?store=s1", label: "Back to the studio", short: "Studio" } })),
    ),
  );
const bar = header({ renewalUnpaidSince: 1 });
is("the bell is in the help's row, after it", [bar.includes("Notifications: 1 needs you"), bar.indexOf("Help for this screen") > -1 && bar.indexOf("Notifications") > bar.indexOf("Help for this screen")], [true, true]);
is("a page that hands over only the store's name has a quiet bell, never a made-up one", header({}).includes("Nothing needs you right now."), true);
is("the studio home hands over the store as it read it on this load, so the bell and the home's notices agree", /<StudioHeader\s+current=\{current \?\? store\}/.test(read("app/studio/page.tsx")), true);

part("What it adds to a page");
const worst = draw({ renewalUnpaidSince: 1, planDisputes: [open], suspended: "2026-11-02T10:00:00.000Z", stripeChargesEnabled: false, strikes: many.map((s) => ({ ...s, what: "x".repeat(200) })) });
is("at most 4,800 bytes of HTML at its fullest, and 1,200 when quiet", [Buffer.byteLength(worst) <= 4_800, Buffer.byteLength(calm) <= 1_200, Buffer.byteLength(calm) > 0], [true, true, true]);

done();
