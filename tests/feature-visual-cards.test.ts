/**
 * More feature-page cards (531 [VP1], units 2 and 3; added 1 November 2026):
 * bundles, quizzes and certificates, license keys, webhooks, calendar sync,
 * Discord access (units 2 and 3), the community and affiliates (unit 4),
 * the team and email platforms (unit 6), PDF stamping and ways to pay
 * (unit 7), phone notifications (unit 8), security (unit 9), the sales page
 * editor and its writing help (unit 10), the deals board (unit 11), a pitch in Outreach (unit 12), a finished import and a ClickFunnels dry run (unit 13), live events (unit 5; the reviews page has none, since a drawn review would
 * be an invented one),
 * each a piece of the
 * studio's real screen in HTML, with its words and figures from the code.
 * Checked: each page shows its card; the studio's own labels; every figure
 * is one the code holds (the bundle's 2 to 20, the quiz's default pass mark
 * and tries, a key's default shape), and anything else is marked as an
 * example by its caption; real text, the drawing hidden beside its read
 * caption.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AI_LEFT_EXAMPLE, CRM_EXAMPLE, CRM_PIPELINES, DRY_RUN_EXAMPLE, IMPORT_EXAMPLE, OUTREACH_EXAMPLE, EXAMPLE_KEY, FeatureVisual, SALES_PAGE_EXAMPLE } from "@/components/feature-visuals";
import { BLOCK_KINDS, MAX_BENEFITS, MAX_BLOCKS, MAX_CTA_LABEL, MAX_FAQ_ITEMS, MAX_FIT_ITEMS, MAX_HEADLINE, MAX_INSIDE_ITEMS } from "@/lib/sales-page";
import { KIND_ICONS } from "@/lib/sales-page-icons";
import { AI_MONTHLY, AI_PLANS_WORDS } from "@/lib/ai-rules";
import { DEFAULT_STAGES, FIRST_PIPELINE_NAME, PIPELINES_BY_TIER, pipelineLimit } from "@/lib/crm-rules";
import { PLAN_TITLES } from "@/lib/plan";
import { MAX_PITCH_BODY, MAX_PITCH_SUBJECT, OUTREACH_COUNTRIES, draftLinks, pitchFooter, pitchText } from "@/lib/outreach-rules";
import { SITE_URL } from "@/lib/site-url";
import { HOUSE_HANDLE } from "@/lib/house-store";
import { IMPORT_DATE, IMPORT_LEFT_WORDS, IMPORT_WORDS, OUTCOME_WORDS } from "@/lib/import-words";
import { IMPORT_ALLOWANCES } from "@/lib/import-limits";
import { IMPORT_LIMITS } from "@/lib/imports";
import { MAX_BUNDLE_ITEMS, MIN_BUNDLE_ITEMS } from "@/lib/bundle-rules";
import { DEFAULT_ATTEMPTS, DEFAULT_PASS_PERCENT } from "@/lib/quiz";
import { DEFAULT_KEYS } from "@/lib/key-setup";
import { KEY_ALPHABET, sampleKey } from "@/lib/licence-key-rules";
import { WEBHOOK_EVENTS } from "@/lib/webhooks";
import { MAX_ENDPOINTS, shortAddress } from "@/lib/webhook-limits";
import { LOOKAHEAD_DAYS, MAX_FEEDS } from "@/lib/calendar-limits";
import { MAX_DISCORD_PRODUCTS, MAX_PRODUCT_ROLES } from "@/lib/discord-rules";
import { findPage } from "@/lib/site-pages";
import { formatMoney } from "@/lib/money";
import { JOIN_EARLY_MINUTES } from "@/lib/community-text";
import { ROLE_NAMES, can } from "@/lib/team-roles";
import { MAX_TEAM } from "@/lib/team";
import { stampLine } from "@/lib/pdf-stamp-line";
import { stampLine as printedLine } from "@/lib/pdf-stamp";
import { waysFrom } from "@/lib/payment-methods";
import { RECOVERY_CODES } from "@/lib/two-step";
import { hideAddress } from "@/lib/recovery-address";
import { eventTime, lengthWords } from "@/lib/community-events";
import { done, is, part } from "./check";

const text = (html: string) => html.replace(/<[^>]+>/g, "\n").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").split("\n").map((s) => s.trim()).filter(Boolean);
const read = (file: string) => readFileSync(file, "utf8");
const draw = (visual: "bundles" | "quizzes" | "keys" | "webhooks" | "calendar" | "discord" | "community" | "affiliates" | "events" | "team" | "emailPlatforms" | "stamp" | "ways" | "phone" | "security" | "salesPage" | "aiWriting" | "crm" | "outreach" | "importDone" | "dryRun") => renderToStaticMarkup(createElement(FeatureVisual, { visual, tone: "light" }));
const flatText = (html: string) => text(html).join(" ").replace(/\s+/g, " ");
const hidden = (html: string) => html.startsWith('<figure class="w-full min-w-0 max-w-[26rem]"><div aria-hidden="true">');

function main(): void {
  part("Bundles");
  is("the bundles page shows its card", findPage("platform", "bundles")?.visual, "bundles");
  const bundle = draw("bundles");
  const b = text(bundle);
  is("the editor's own count of what is in it", b.includes(`In it: 3 of ${MAX_BUNDLE_ITEMS}`), true);
  is("and its own words for the choosing", [b.includes("Let each buyer choose which ones they get"), read("components/bundle-editor.tsx").includes("Let each buyer choose which ones they get")], [true, true]);
  is("the editor's worth line, summed from the example prices (shown once a bundle has its minimum)", [b.includes("$77 of products for $49"), MIN_BUNDLE_ITEMS <= 3, read("components/bundle-editor.tsx").includes("`${formatMoney(worth, currency)} of products for ${formatMoney(priceCents, currency)}`")], [true, true, true]);
  is("no error message drawn as a note (the 2-to-20 rule is said only on a refused save)", b.some((w) => /bundle holds/.test(w)), false);
  is("the prices are said to be an example", b.some((w) => /example/.test(w) && /price/i.test(w)), true);
  is("drawn, hidden, beside its caption", hidden(bundle), true);

  part("Quizzes and certificates");
  is("the quizzes page shows its card", findPage("platform", "quizzes-and-certificates")?.visual, "quizzes");
  const quiz = draw("quizzes");
  const q = text(quiz);
  const quizEditor = read("components/quiz-editor.tsx");
  is("the open quiz's own fields, at the values a new quiz starts with", [q.includes("Pass mark (%)"), q.includes("Tries allowed"), q.includes(String(DEFAULT_PASS_PERCENT)), q.includes(String(DEFAULT_ATTEMPTS)), quizEditor.includes('<span className="field-label">Pass mark (%)</span>'), quizEditor.includes('<span className="field-label">Tries allowed</span>')], [true, true, true, true, true, true]);
  is("the answers under the editor's own legend", [q.includes("Answers — check the right one"), quizEditor.includes("Answers — check the right {")], [true, true]);
  is("an answer wraps on a phone instead of being cut", quiz.includes("min-w-0 flex-1 break-words"), true);
  is("the certificate as the course page says it", [q.includes("Certificate of completion"), read("app/studio/course/[product]/page.tsx").includes("Certificate of completion")], [true, true]);
  is("the questions are said to be an example", q.some((w) => /example/.test(w)), true);
  is("drawn, hidden, beside its caption", hidden(quiz), true);

  part("License keys");
  is("the license keys page shows its card", findPage("platform", "license-keys")?.visual, "keys");
  const keys = draw("keys");
  const k = text(keys);
  is("the two places a key comes from, in the editor's words", ["Made here, one per sale", "From a list you upload"].every((w) => k.includes(w) && read("components/licence-key-editor.tsx").includes(w)), true);
  is("the preview in the default shape, as the editor shows it", [k.some((w) => w.includes(`like ${sampleKey(DEFAULT_KEYS)}.`)), DEFAULT_KEYS.groups, DEFAULT_KEYS.groupLength], [true, 4, 4]);
  is("a key given looks like one: the default shape, the keys' own letters", [k.includes(EXAMPLE_KEY), EXAMPLE_KEY.split("-").map((g) => g.length), [...EXAMPLE_KEY.replace(/-/g, "")].every((ch) => KEY_ALPHABET.includes(ch))], [true, [4, 4, 4, 4], true]);
  is("the caption says the key is an example, and only made keys are new", /The key, the buyer and the order are an example\. Keys made here are new for each sale\./.test(keys), true);
  is("the editor's own heading for the keys given", [k.includes("Keys given"), read("components/licence-key-editor.tsx").includes('<span className="field-label">Keys given</span>')], [true, true]);
  is("the editor's own sentence for a made key, with the sample", k.includes(`Each buyer gets a new key made for them, like ${sampleKey(DEFAULT_KEYS)}. No key is ever given twice.`), true);
  is("the emails are said to be an example", k.some((w) => /example/.test(w)), true);
  is("drawn, hidden, beside its caption", hidden(keys), true);

  part("Webhooks");
  is("the webhooks page shows its card", findPage("platform", "webhooks")?.visual, "webhooks");
  const hooks = draw("webhooks");
  const h = text(hooks);
  const editor = read("components/webhook-editor.tsx");
  is("the studio card's heading and count", [h.includes("Webhooks and Zapier"), editor.includes("Webhooks and Zapier"), h.includes(`1 of ${MAX_ENDPOINTS}`), MAX_ENDPOINTS], [true, true, true, 5]);
  is("deliveries by the code's own event names, newest first, under the editor's heading", [h.filter((w) => (WEBHOOK_EVENTS as readonly string[]).includes(w)), h.includes("Last 3 deliveries"), editor.includes("`Last ${view.log.length} ${view.log.length === 1 ? \"delivery\" : \"deliveries\"}`")], [["refund.issued", "list.joined", "sale.completed"], true, true]);
  is("the endpoint as the studio shortens it, never the whole secret path", [h.includes(shortAddress("https://hooks.zapier.com/hooks/catch/1234567/abcdefg/")), h.some((w) => w.includes("1234567"))], [true, false]);
  is("the editor reads the same figure as the server", [editor.includes('import { MAX_ENDPOINTS } from "@/lib/webhook-limits";'), /const MAX_ENDPOINTS = /.test(editor), read("lib/webhooks.ts").includes('import { MAX_ENDPOINTS, shortAddress } from "@/lib/webhook-limits";')], [true, false, true]);
  is("in the editor's words", ["Every event", "Sending"].every((w) => h.includes(w) && editor.includes(`"${w}"`)) && h.includes("Delivered (200)") && editor.includes("`Delivered${d.lastStatus ? ` (${d.lastStatus})` : \"\"}`"), true);
  is("the address and deliveries said to be an example", h.some((w) => /example/.test(w)), true);
  is("drawn, hidden, beside its caption", hidden(hooks), true);

  part("Calendar sync");
  is("the calendar sync page shows its card", findPage("platform", "calendar-sync")?.visual, "calendar");
  const cal = draw("calendar");
  const c = text(cal);
  const calEditor = read("components/calendar-editor.tsx");
  is("the studio card's heading and count", [c.includes("Your calendars"), calEditor.includes("Your calendars"), c.includes(`1 of ${MAX_FEEDS} read`)], [true, true, true]);
  is("a calendar's line in the editor's format, with the code's look-ahead and the day it was added", [c.includes(`Read 4 min ago · 12 busy times in the next ${LOOKAHEAD_DAYS} days · added Oct 20, 2026`), calEditor.includes("in the next ${LOOKAHEAD_DAYS} days`"), calEditor.includes("`${minutes} min ago`"), calEditor.includes("` · added ${addedOn(feed.addedAt)}`")], [true, true, true, true]);
  is("the editor reads the same figures as the server", [calEditor.includes('import { LOOKAHEAD_DAYS, MAX_FEEDS } from "@/lib/calendar-limits";'), /const MAX_FEEDS = /.test(calEditor), read("lib/calendar-sync.ts").includes('import { LOOKAHEAD_DAYS, MAX_FEEDS } from "@/lib/calendar-limits";')], [true, false, true]);
  is("the line wraps on a phone, so the look-ahead is never cut", cal.includes('block break-words text-[12px] text-ink-soft">Read 4 min ago'), true);
  is("the bookings feed, under its own heading, with its own button", [c.includes("Your bookings in your calendar"), calEditor.includes("Your bookings in your calendar"), c.includes("Copy address"), calEditor.includes('"Copy address"')], [true, true, true, true]);
  is("drawn, hidden, beside its caption", hidden(cal), true);

  part("Discord access");
  is("the Discord page shows its card", findPage("platform", "discord-access")?.visual, "discord");
  const disc = draw("discord");
  const d = text(disc);
  const discordStudio = read("components/discord-studio.tsx");
  is("the studio's heading", [d.includes("Which products give which roles"), discordStudio.includes("Which products give which roles")], [true, true]);
  is("its limits, from the code", d.includes(`Up to ${MAX_PRODUCT_ROLES} roles for each product, on up to ${MAX_DISCORD_PRODUCTS} products.`) && discordStudio.includes("`Up to ${limits.roles} roles for each product, on up to ${limits.products} products."), true);
  is("each product as the studio draws it: its title, how many roles it gives, a pill per role", [d.includes("Gives 1 role."), d.includes("Gives 2 roles."), discordStudio.includes("`Gives ${saved.length} ${saved.length === 1 ? \"role\" : \"roles\"}.`")], [true, true, true]);
  // How soon roles are taken back is not drawn: the next check is CHECK_HOURS after the last plus up to the cron's half hour, and longer while Stripe does not answer.
  is("no promise of how soon roles are taken back", d.some((w) => /taken back|within \d+ hours/.test(w)), false);
  is("drawn, hidden, beside its caption", hidden(disc), true);

  part("Community");
  is("the community page shows its card", findPage("platform", "community")?.visual, "community");
  const com = draw("community");
  const m = text(com);
  const comStudio = read("components/community-studio.tsx");
  is("the studio card's heading, state and sentence", ["Your community", "On", "Open to everyone who holds one of the products you chose below. Your store page shows the way in."].every((w) => m.includes(w) && comStudio.includes(w)), true);
  is("its three counts, under the studio's own labels", ["have come in", "posts"].every((w) => m.includes(w) && comStudio.includes(`>${w}<`)) && m.includes("want the community's emails") && comStudio.includes("want the community&apos;s emails"), true);
  is("its buttons, in the studio's words", ["Switch it off", "Open it"].every((w) => m.includes(w) && comStudio.includes(w)), true);
  is("the counts said to be an example", m.some((w) => /example/.test(w)), true);
  is("drawn, hidden, beside its caption", hidden(com), true);

  part("Affiliates");
  is("the affiliates page shows its card", findPage("platform", "affiliates")?.visual, "affiliates");
  const aff = draw("affiliates");
  const a = text(aff);
  const affStudio = read("components/affiliate-studio.tsx");
  is("the studio's heading, link code and status", [a.includes("Your affiliates"), affStudio.includes("Your affiliates"), a.includes("?via=ana"), affStudio.includes("`?via=${affiliate.code}`"), a.includes("Approved"), affStudio.includes('approved: { label: "Approved", tone: "tag-live" }')], [true, true, true, true, true, true]);
  is("the five tiles, in the studio's order", a.filter((w) => ["Clicks", "Sales", "Earned", "Paid", "Owed"].includes(w)), ["Clicks", "Sales", "Earned", "Paid", "Owed"]);
  is("the tiles' labels are the studio's", ["Clicks", "Sales", "Earned", "Paid"].every((w) => affStudio.includes(`label: "${w}"`)) && affStudio.includes('label: row.owed < 0 ? "Paid ahead" : "Owed"'), true);
  const after = (label: string) => a[a.indexOf(label) + 1] ?? "";
  const cents = (money: string) => Math.round(Number(money.replace(/[$,]/g, "")) * 100);
  is("each amount in the studio's own money format", [after("Earned"), after("Paid"), after("Owed")], [formatMoney(5_940, "usd"), formatMoney(3_000, "usd"), formatMoney(2_940, "usd")]);
  is("owed, as drawn, is what was earned less what was paid", cents(after("Earned")) - cents(after("Paid")), cents(after("Owed")));
  is("the person and every figure said to be made up, not anyone's real results", a.some((w) => /every figure are made up as an example, not anyone's real results/.test(w)), true);
  is("drawn, hidden, beside its caption", hidden(aff), true);

  part("Live events");
  is("the live events page shows its card", findPage("platform", "live-events")?.visual, "events");
  const ev = draw("events");
  const e = text(ev);
  const evStudio = read("components/community-events-studio.tsx");
  is("the studio's heading, count and section", [e.includes("Live events"), e.includes("2 coming up"), evStudio.includes("`${upcoming} coming up`"), e.includes("Coming up"), evStudio.includes(">Coming up<")], [true, true, true, true, true]);
  const firstWhen = `${eventTime({ start: Date.UTC(2026, 10, 10, 23), tz: "America/New_York" })} · ${lengthWords(60)}`;
  const secondWhen = `${eventTime({ start: Date.UTC(2026, 10, 19, 17), tz: "America/New_York" })} · ${lengthWords(45)}`;
  is("when, in the studio's own eventTime and lengthWords", [e.includes(firstWhen), e.includes(secondWhen), lengthWords(45), read("app/studio/community/page.tsx").includes("when: eventTime(e),") && read("app/studio/community/page.tsx").includes("length: lengthWords(e.minutes),"), evStudio.includes("`${event.when} · ${event.length}`")], [true, true, "45 minutes", true, true]);
  is("each row's place and who may come, in the row's own words", [e.includes("Private video room · every member"), evStudio.includes('"Private video room"'), evStudio.includes('" · every member"'), e.includes("Your meeting link · only for buyers of Batch Cooking Basics"), evStudio.includes('"Your meeting link"'), evStudio.includes("` · only for buyers of ${only.join(\", \")}`")], [true, true, true, true, true, true]);
  is("places in the row's two formats", [e.includes("12 of 30 places taken"), e.includes("8 going"), evStudio.includes("`${event.going} of ${event.cap} ${event.cap === 1 ? \"place\" : \"places\"} taken`"), evStudio.includes("`${event.going} going`")], [true, true, true, true]);
  is("the way in, from the code's own minutes", [e.includes(`The way in shows ${JOIN_EARLY_MINUTES} minutes before the start, only to members who can come.`), JOIN_EARLY_MINUTES], [true, 15]);
  is("the events, dates and counts said to be made up", e.some((w) => /made up as an example/.test(w)), true);
  is("drawn, hidden, beside its caption", hidden(ev), true);
  is("no drawn review on the reviews page: a made-up one would be an invented testimonial", findPage("platform", "reviews")?.visual, undefined);

  part("Teams");
  is("the teams page shows its card", findPage("platform", "teams-and-stores")?.visual, "team");
  const tm = draw("team");
  const t = text(tm);
  const teamUi = read("components/team-manager.tsx");
  is("the owner as the studio says it", [t.includes("You. Everything, including the plan, payments and the team."), teamUi.includes("You. Everything, including the plan, payments and the team."), t.includes("Owner"), teamUi.includes(">Owner<")], [true, true, true, true]);
  is("a member's role by the code's own name", [t.includes(ROLE_NAMES.editor), t.includes("Joined Oct 3, 2026"), teamUi.includes("`Joined ${day(m.joinedAt)}`")], [true, true, true]);
  is("an invitation as the studio writes it", [t.includes(`Invited as ${ROLE_NAMES.support} · the link works until Nov 8`), teamUi.includes("`Invited as ${ROLE_NAMES[i.role]} · the link works until "), t.includes("Waiting"), teamUi.includes('<span className="tag tag-next">Waiting</span>')], [true, true, true, true]);
  is("the places used, from the code's figure", [t.includes(`2 of ${MAX_TEAM} places used`), teamUi.includes("`${used} of ${max} places used`"), t.includes("People on this store"), teamUi.includes("People on this store")], [true, true, true, true]);
  is("the invite form, filled in, with its button and its envelope", [t.includes("Invite someone"), t.includes("Their email"), t.includes("Send the invitation"), teamUi.includes("Send the invitation"), teamUi.includes('<Icon name="mail" size={16} />')], [true, true, true, true, true]);
  is("a member's role as a list to choose from, and its Remove", [t.includes("Remove"), /Remove\s*<\/button>/.test(teamUi) || teamUi.includes("Remove\n")], [true, true]);
  is("the people said to be made up", t.some((w) => /made up as an example/.test(w)), true);
  is("drawn, hidden, beside its caption", hidden(tm), true);

  part("Email platforms");
  is("the email platforms page shows its card", findPage("platform", "email-platforms")?.visual, "emailPlatforms");
  const ep = draw("emailPlatforms");
  const pl = text(ep);
  const sync = read("components/email-sync-editor.tsx");
  is("the four platforms, by the studio's names, in its order", pl.filter((w) => ["Mailchimp", "Kit", "beehiiv", "MailerLite"].includes(w)), ["Mailchimp", "Kit", "beehiiv", "MailerLite"]);
  is("each with what it adds to, from the studio's list", [["audience", "an"], ["form", "a"], ["publication", "a"], ["group", "a"]].every(([target, article]) => pl.includes(`Adds to ${article} ${target}`) && sync.includes(`target: "${target}"`)) && sync.includes('`Adds to ${p.target === "audience" ? "an" : "a"} ${p.target}`'), true);
  is("one screen only, as it shows before anything is connected: platform, key, Connect", [["Connect your email platform", "Mailchimp API key", "Connect"].every((w) => pl.includes(w)), sync.includes("`${byKey(provider).name} API key`"), pl.includes("Your Mailchimp API key (ends in -us21 or similar)"), sync.includes('placeholder: "Your Mailchimp API key (ends in -us21 or similar)"')], [true, true, true, true]);
  is("nothing from the connected screen drawn beside it", ["Who is sent", "Free sign-ups", "Buyers of every product"].some((w) => pl.includes(w)), false);
  is("no figure but the key's own hint", pl.filter((w) => /\d/.test(w)), ["Your Mailchimp API key (ends in -us21 or similar)"]);
  is("drawn, hidden, beside its caption", hidden(ep), true);

  part("PDF stamping");
  is("the PDF stamping page shows its card", findPage("platform", "pdf-stamping")?.visual, "stamp");
  const st = draw("stamp");
  const sp = text(st);
  const toggle = read("components/pdf-stamp-toggle.tsx");
  const stamped = stampLine("maya@example.com", "cs_test_a1E54F2A", new Date(Date.UTC(2026, 8, 26)));
  is("the very line every page carries, made by the code that prints it", [sp.includes(stamped), stamped, toggle.includes(stamped), printedLine === stampLine], [true, "Sold to maya@example.com on Sep 26, 2026 · order …E54F2A · for personal use", true, true]);
  is("on one line, shrunk to fit, in the plain font the PDF uses, with no rule above it", [st.includes("whitespace-nowrap font-sans"), /font-mono[^"]*">Sold to/.test(st), /border-t[^"]*">Sold to/.test(st)], [true, false, false]);
  is("the switch apart, said to be in the studio: the buyer never sees it", [sp.includes("In the studio, on the product"), sp.indexOf("In the studio, on the product") > sp.indexOf(stamped)], [true, true]);
  is("the card reads the line without the PDF library", [read("components/feature-visuals.tsx").includes('from "@/lib/pdf-stamp-line"'), read("components/feature-visuals.tsx").includes('from "@/lib/pdf-stamp"')], [true, false]);
  is("the product's switch and its honest limit, in the editor's words", [sp.includes("Stamp each buyer's email on every page of the PDF"), toggle.includes("Stamp each buyer&apos;s email on every page of the PDF"), sp.includes("It makes a shared copy traceable to its buyer; it cannot stop anyone from sharing."), toggle.includes("It makes a shared copy traceable to its buyer; it cannot stop anyone from sharing.")], [true, true, true, true]);
  is("drawn, hidden, beside its caption", hidden(st), true);

  part("Ways to pay");
  is("the currencies and ways to pay page shows its card", findPage("platform", "currencies-and-ways-to-pay")?.visual, "ways");
  const wy = draw("ways");
  const w = text(wy);
  const panel = read("components/payments-panel.tsx");
  is("the studio's groups and their own notes", [["Cards and wallets", "Apple Pay and Google Pay pay with a card; Link fills in Stripe's saved details."], ["Pay later", "The buyer pays in installments; you are paid in full."]].every(([title, note]) => w.includes(title) && w.includes(note) && panel.includes(`title: "${title}"`) && panel.includes(note)), true);
  is("the heading and the currency field, in the panel's words and format", [w.includes("Ways to pay"), panel.includes("Ways to pay"), w.includes("Your store's currency"), panel.includes("Your store&apos;s currency"), w.includes("US dollar (USD)")], [true, true, true, true, true]);
  const on = waysFrom({ card: { available: true }, apple_pay: { available: true }, google_pay: { available: true }, link: { available: true }, klarna: { available: true }, affirm: { available: true } } as never, "").on;
  const drawn = ["Cards", "Apple Pay", "Google Pay", "Link", "Klarna", "Affirm"];
  is("each way by the name, group and order the panel shows (waysFrom)", [on.map((x) => x.name), w.filter((x) => drawn.includes(x))], [drawn, drawn]);
  is("cards and wallets, then pay later, as the panel groups them", [on.slice(0, 4).every((x) => x.group === "card" || x.group === "wallet"), on.slice(4).every((x) => x.group === "later")], [true, true]);
  is("which ways show is said to depend on each creator's own Stripe", w.some((x) => /depends on what is switched on in each creator's own Stripe account/.test(x)), true);
  is("drawn, hidden, beside its caption", hidden(wy), true);

  part("Phone notifications");
  is("the phone notifications page shows its card", findPage("platform", "phone-notifications")?.visual, "phone");
  const ph = draw("phone");
  const pn = text(ph);
  const alerts = read("components/phone-alerts-panel.tsx");
  is("the device card's heading, tag, legend and test, in the panel's words", [["This device", "Notifications on", "Tell this device about", "Send a test", "Turn off on this device"].every((w) => pn.includes(w)) && alerts.includes('"Turn off on this device"'), alerts.includes("This device"), alerts.includes('"Notifications on"'), alerts.includes(">Tell this device about<"), alerts.includes('"Send a test"')], [true, true, true, true, true]);
  is("each kind with the panel's own label and hint", [["Sales", "Every paid order: the amount and what was bought"], ["Bookings", "A call or a seat booked: what, when, and what was paid"], ["Community reports", "A member reported a post or a comment"], ["Live events", "A community live event starts in 15 minutes"]].every(([label, hint]) => pn.includes(label) && pn.includes(hint) && alerts.includes(`label: "${label}", hint: "${hint}"`)), true);
  is("the four kinds a Support member may hear, and the caption says so", [can("support", "orders"), can("support", "community"), pn.some((x) => /as a Support team member sees them/.test(x))], [true, true, true]);
  is("drawn, hidden, beside its caption", hidden(ph), true);

  part("Security");
  is("the security page shows its card", findPage("platform", "security")?.visual, "security");
  const sc = draw("security");
  const sec = text(sc);
  const passkeys = read("components/passkey-manager.tsx");
  const twoStep = read("components/two-step-manager.tsx");
  is("the passkeys heading, a row in its own format, and its Remove", [sec.includes("Passkeys"), sec.includes("Added Oct 12, 2026 · last used Oct 30, 2026 · synced across your devices"), passkeys.includes("`Added ${day(row.createdAt)} · last used ${day(row.lastUsedAt)}${row.synced ? \" · synced across your devices\" : \"\"}`"), passkeys.includes('month: "short", day: "numeric", year: "numeric"'), sec.includes("Remove")], [true, true, true, true, true]);
  is("two-step login on, in its own sentence, with the codes a setup makes", [sec.includes("Two-step login"), sec.includes(`On. Logging in with the emailed link also asks for the code in your authenticator app; a passkey needs no code. ${RECOVERY_CODES} recovery codes left. Lose your phone and your codes, and a link to your recovery address, ${hideAddress("maya@example.com")}, lets you back in.`), twoStep.includes("`On. Logging in with the emailed link also asks for the code in your authenticator app; a passkey needs no code. ${left} recovery ${left === 1 ? \"code\" : \"codes\"} left."), RECOVERY_CODES], [true, true, true, 10]);
  is("the whole sentence, its recovery address masked as the code masks it", [twoStep.includes("` Lose your phone and your codes, and a link to your recovery address, ${recoveryShown}, lets you back in.`"), hideAddress("maya@example.com")], [true, "m•••@e•••.com"]);
  is("two-step login's own buttons when it is on", ["New recovery codes", "Turn it off"].every((w) => sec.includes(w) && twoStep.includes(w)), true);
  is("drawn, hidden, beside its caption", hidden(sc), true);

  part("Sales pages");
  is("the sales pages page shows its card", findPage("platform", "sales-pages")?.visual, "salesPage");
  const spg = draw("salesPage");
  const sg = text(spg);
  const pageEditor = read("components/page-editor.tsx");
  const { product, blocks } = SALES_PAGE_EXAMPLE;
  is("the editor's heading and count, in its own words", [sg.includes(`Sales page for ${product}`), pageEditor.includes("`${kind} for ${product.title}`"), pageEditor.includes('product.free ? "Landing page" : "Sales page"'), sg.includes(`${blocks.length} blocks live on its page.`), pageEditor.includes('`${initial.blocks.length} ${initial.blocks.length === 1 ? "block" : "blocks"} ${site ? "on this page" : "live on its page"}.`')], [true, true, true, true, true]);
  is("the Built tag and Build or Preview", [["Built", "Build", "Preview"].every((w) => sg.includes(w)), pageEditor.includes('!hiddenNow ? "Built"'), pageEditor.includes('v === "build" ? "Build" : "Preview"')], [true, true, true]);
  is("each row as the editor numbers it, under BLOCK_KINDS' own label", blocks.every((bl, i) => sg.includes(`${i + 1}. ${BLOCK_KINDS.find((k) => k.kind === bl.kind)?.label}`)) && pageEditor.includes("{`${index + 1}. ${kindLabel(block.kind)}`}"), true);
  is("the editor and the picture read one icon list", [pageEditor.includes('import { KIND_ICONS } from "@/lib/sales-page-icons";'), /const KIND_ICONS\b/.test(pageEditor), pageEditor.includes("<Icon name={KIND_ICONS[block.kind]} size={17} />"), read("components/feature-visuals.tsx").includes("<Icon name={KIND_ICONS[b.kind]} size={14} />"), KIND_ICONS.hero], [true, false, true, true, "sparkle"]);
  const branch = (kinds: string[], body: string) => pageEditor.includes(kinds.map((k) => `      case "${k}":`).join("\n") + "\n        return " + body);
  is("each summary line from the editor's own branch for its kind", [
    branch(["hero"], "block.headline || product.title;"),
    branch(["benefits", "inside", "faq"], '`${block.heading ? `${block.heading} · ` : ""}${block.items.length} ${block.items.length === 1 ? "item" : "items"}`;'),
    branch(["fit"], '`${block.heading ? `${block.heading} · ` : ""}${block.yes.length} for, ${block.no.length} not for`;'),
    branch(["cta"], "block.label || product.defaultLabel;"),
    blocks[1].line === "What you get · 5 items" && blocks[2].line === "6 items" && blocks[4].line === "4 items" && blocks[3].line === "3 for, 2 not for",
  ], [true, true, true, true, true]);
  is("and each count inside the editor's own most", [5 <= MAX_BENEFITS, 6 <= MAX_INSIDE_ITEMS, 4 <= MAX_FAQ_ITEMS, 3 <= MAX_FIT_ITEMS, blocks[0].line.length <= MAX_HEADLINE, blocks[5].line.length <= MAX_CTA_LABEL], [true, true, true, true, true, true]);
  is("the row's buttons as the editor draws them: up off for the first two under a hero, down off for the last, no copy of a hero", [pageEditor.includes("disabled={locked || index === 0 || (index === 1 && hasHero)}"), pageEditor.includes("disabled={locked || index === drafts.length - 1}"), pageEditor.includes('return block.kind !== "hero" && block.kind !== "reviews" && block.kind !== "pictures";'), (spg.match(/opacity-30/g) ?? []).length], [true, true, true, 3]);
  is("Add here between two rows, never after the last", [sg.filter((w) => w === "Add here").length, pageEditor.includes("{index < drafts.length - 1 ? ("), pageEditor.includes("Add here")], [blocks.length - 1, true, true]);
  is("Undo, Redo and the live page beside Build or Preview", [sg.includes("Open the live page"), pageEditor.includes("Open the live page"), pageEditor.includes('aria-label="Undo and redo"')], [true, true, true]);
  is("the caption says it is part of the editor, with the break where the coach and test sit", [sg.some((w) => /^Part of a product's sales page/.test(w) && /score and its test sit at the break/.test(w)), pageEditor.includes("<PageCoach"), pageEditor.includes("Test a second version of the whole page")], [true, true, true]);
  is("the add button's count, against the code's most", [sg.includes(`Add a block (${blocks.length} of ${MAX_BLOCKS})`), pageEditor.includes("{`Add a block (${drafts.length} of ${MAX_BLOCKS})`}"), MAX_BLOCKS, blocks.length < MAX_BLOCKS], [true, true, 30, true]);
  is("no share of readers is drawn (a figure the page has not counted)", sg.some((w) => /reach it/.test(w)), false);
  is("the product and its blocks are said to be an example", sg.some((w) => /example/.test(w) && /product/.test(w)), true);
  is("drawn, hidden, beside its caption", hidden(spg), true);

  part("Writing help with AI");
  is("the writing help page shows its card", findPage("platform", "ai-writing")?.visual, "aiWriting");
  const aw = draw("aiWriting");
  const ai = text(aw);
  const assist = read("components/ai-assist.tsx");
  const hint = `A full draft — headline, what the buyer gets, what is inside, questions and buttons — from ${product}'s name, price and description. Add anything else it should know below, or leave the box empty. It replaces the blocks here; nothing is saved until you press Save.`;
  is("the editor's title, hint and box words", [ai.includes("Write the whole page with AI"), pageEditor.includes('title="Write the whole page with AI"'), ai.includes(hint), pageEditor.includes(hint.replace(`${product}'s`, "${product.title}'s")), pageEditor.includes('placeholder="Who it is for, what makes it different, what buyers ask you most. Your refund promise, if you have one."'), ai.includes("Who it is for, what makes it different, what buyers ask you most. Your refund promise, if you have one.")], [true, true, true, true, true, true]);
  is("the button and the jobs left, in the helper's own words", [ai.includes("Write a draft"), assist.includes('"Write a draft"'), ai.includes(`${AI_LEFT_EXAMPLE} left this month. Started attempts count, even if they fail.`), assist.includes("`${left} left this month. Started attempts count, even if they fail.`")], [true, true, true, true]);
  is("never more left than Studio's month holds, and none on Store or in a trial", [AI_LEFT_EXAMPLE <= AI_MONTHLY.pro, AI_MONTHLY.scale > 0, AI_MONTHLY.creator, AI_MONTHLY.trial], [true, true, 0, 0]);
  is("the line under it, word for word", [ai.includes("It uses only your own words, here and in your store, never invents reviews, numbers, results or deadlines, and saves nothing until you do. Read it before you publish: it is yours."), assist.replace(/\s+/g, " ").includes("It uses only your own words, here and in your store, never invents reviews, numbers, results or deadlines, and saves nothing until you do. Read it before you publish: it is yours.")], [true, true]);
  is("the jobs left are said to be an example, on the plans that have it", ai.some((w) => /example/.test(w) && /jobs left/.test(w) && w.includes(`on ${AI_PLANS_WORDS}.`)), true);
  is("drawn, hidden, beside its caption", hidden(aw), true);

  part("Deals");
  is("the CRM page shows its card, and it is a Store plan page", [findPage("platform", "crm")?.visual, findPage("platform", "crm")?.plan], ["crm", "creator"]);
  const cr = draw("crm");
  const cw = text(cr);
  const board = read("components/deals-board.tsx");
  const dealsPage = read("app/studio/deals/page.tsx");
  const flat = (src: string) => src.replace(/\s+/g, " ");
  const kindOf = (id: string) => DEFAULT_STAGES.find((st) => st.id === id)?.kind;
  const openDeals = CRM_EXAMPLE.filter((d) => kindOf(d.stage) === "open");
  const wonSum = CRM_EXAMPLE.filter((d) => kindOf(d.stage) === "won").reduce((n, d) => n + d.cents, 0);
  const openSum = openDeals.reduce((n, d) => n + d.cents, 0);
  is("the heading and its sentence, summed from the deals drawn, one pipeline so no pipeline name in it", [cw.includes("Deals"), cw.includes(`People you are talking to about something sold outside a checkout: a coaching package, a custom project. ${openDeals.length} open, worth ${formatMoney(openSum, "usd")}; won so far, ${formatMoney(wonSum, "usd")}.`), flat(board).includes(flat("`People you are talking to about something sold outside a checkout: a coaching package, a custom project.${pipelines.length > 1 ? ` In ${pipeline.name}:` : \"\"} ${open.reduce((n, t) => n + t.count, 0)} open, worth ${money(open.reduce((n, t) => n + t.cents, 0))}; won so far, ${money(won.reduce((n, t) => n + t.cents, 0))}.`"))], [true, true, true]);
  is("New deal, and the first pipeline's button with its open count", [cw.includes("New deal"), /New deal/.test(board), cw.includes(FIRST_PIPELINE_NAME) && cw.includes(`· ${openDeals.length} open`), board.includes("{` · ${t.open.count} open`}"), FIRST_PIPELINE_NAME], [true, true, true, true, "Sales"]);
  is("New pipeline, since a paid Store plan keeps more than one, as the board's page counts them", [cw.includes("New pipeline"), CRM_PIPELINES, pipelineLimit({ tier: "creator", subscriptionActive: true, trialEnds: 0 }) > 1, dealsPage.includes("pipelineMax={pipelineLimit(store)}"), board.includes("pipelines.length < pipelineMax")], [true, PIPELINES_BY_TIER.creator, true, true, true]);
  is("the stages a store starts with, each column with its count and total", DEFAULT_STAGES.slice(0, 2).map((st) => { const here = CRM_EXAMPLE.filter((d) => d.stage === st.id); return cw.includes(st.name) && cw.includes(`${here.length} · ${formatMoney(here.reduce((n, d) => n + d.cents, 0), "usd")}`); }).concat([board.includes("{`${count} · ${money(cents)}`}")]), [true, true, true]);
  is("each deal as the board writes it, in its own stage", [CRM_EXAMPLE.every((d) => cw.includes(d.title) && cw.includes(formatMoney(d.cents, "usd"))), cw.includes("Next: Follow up on the proposal"), board.includes("Next: {deal.nextAction}"), cw.includes("sam@example.com"), cw.filter((w) => w === "Edit").length, /\n\s*Edit\n/.test(board), CRM_EXAMPLE.every((d) => { const name = DEFAULT_STAGES.find((st) => st.id === d.stage)?.name ?? ""; const at = cw.indexOf(d.title); return at >= 0 && cw.slice(at).includes(name); })], [true, true, true, true, 2, true, true]);
  is("Request payment on the deal with an email only, for a role that may send (the owner may)", [cw.filter((w) => w === "Request payment").length, CRM_EXAMPLE.filter((d) => "email" in d).length, board.includes("{requestHref && deal.email ? ("), dealsPage.includes('requestHref={can(view.role, "send") ?'), can("owner", "send")], [1, 1, true, true, true]);
  is("no due date drawn, which the board would turn red once it has passed", cw.some((w) => /^Due /.test(w)), false);
  is("a deal's name and next action are the editor's own placeholders", [board.includes('placeholder="Six coaching sessions for Dana"'), board.includes('placeholder="Follow up on the proposal"')], [true, true]);
  is("the caption: part of the board, the owner on the Store plan, the break, the stages left out, and recorded values that are not revenue", cw.some((w) => /^Part of the deals board/.test(w) && w.includes(`on the ${PLAN_TITLES.creator} plan`) && /totals and filters sit at the break, and three more stages follow/.test(w) && /not revenue/.test(w) && /example/.test(w)), true);
  is("three more stages do follow", DEFAULT_STAGES.length - 2, 3);
  is("drawn, hidden, beside its caption", hidden(cr), true);

  part("Outreach");
  is("the outreach page shows its card", findPage("platform", "outreach")?.visual, "outreach");
  const ot = draw("outreach");
  const ow = text(ot);
  const studio = read("components/outreach-studio.tsx");
  const o = OUTREACH_EXAMPLE;
  const us = OUTREACH_COUNTRIES.find((c) => c.code === "US");
  is("the business, its address and the Draft tag, as a pitch shows them", [ow.includes(o.company), ow.includes(o.to), ow.includes("Draft"), studio.includes('draft: "Draft"'), studio.includes("{STATUS_WORDS[pitch.status]}")], [true, true, true, true, true]);
  is("where the address was printed and the day it was read, in the studio's own date", [ow.includes(`Address printed on their own website, read ${o.read}: ${o.page}`), studio.includes("{`Address printed on their own website, read ${day(pitch.foundAt)}: `}"), new Date("2026-10-28T12:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }), studio.includes('toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })')], [true, true, o.read, true]);
  is("the draft's labels, word for word", ["Subject", "Your email. Read it and make it yours before you send it", "Added under it on every email, as the law asks"].every((w) => ow.includes(w) && studio.includes(w)), true);
  const aiSource = read("lib/ai.ts");
  is("the subject and words in the shape the writing help is asked for", [o.subject.length <= 60, aiSource.includes("The subject at most 60 characters"), o.body.split(/\s+/).length <= 110, aiSource.includes("at most 110 words, two or three short paragraphs separated by one blank line"), o.body.split("\n\n").length, o.body.endsWith("?"), aiSource.includes("End with one simple question that is easy to answer."), o.subject.length <= MAX_PITCH_SUBJECT && o.body.length <= MAX_PITCH_BODY], [true, true, true, true, 3, true, true, true]);
  is("no count of followers or buyers in the words, which the writing help is told never to state", /\d/.test(o.body), false);
  is("the sender is the demo store's own name, as readSender falls back to, and the store link its own", [o.sender.name, read("lib/outreach.ts").includes("name: store.mail?.fromName || store.name"), read("lib/demo-seed.ts").includes('name: "Harbor Kitchen"'), o.storeUrl], ["Harbor Kitchen", true, true, `${SITE_URL}/@${HOUSE_HANDLE}`]);
  const footer = us ? pitchFooter({ sender: o.sender, storeUrl: o.storeUrl, page: o.page, country: us, stopUrl: o.stopUrl }) : "";
  is("the lines under it are the code's own footer for the United States, with its business proposal line", [us?.saysCommercial, flatText(ot).includes(footer.replace(/\s+/g, " ")), footer.includes("This is a business proposal, sent once."), footer.includes(`I found this address on your website (${o.page}).`)], [true, true, true, true]);
  is("the store link and the stop link in the code's own shapes", [o.storeUrl === `${SITE_URL}/@${HOUSE_HANDLE}`, read("lib/purchase-email.ts").includes("return `${SITE_URL}/@${store.handle}`;"), o.stopUrl.startsWith(`${SITE_URL}/outreach/stop/`), read("lib/outreach.ts").includes("export const stopUrl = (token: string) => `${SITE_URL}/outreach/stop/${token}`;")], [true, true, true, true]);
  is("the three ways to open it and the line under them", [["Open it in Gmail", "Open it in my mail app", "Copy it"].every((w) => ow.includes(w) && studio.includes(w)), ow.includes("Each of these opens a draft in your own mailbox. Nothing is sent until you press Send there, and nothing is ever sent from here."), studio.replace(/\s+/g, " ").includes("Each of these opens a draft in your own mailbox. Nothing is sent until you press Send there, and nothing is ever sent from here.")], [true, true, true]);
  is("I sent it and Delete this draft under it, as a draft's card ends", [["I sent it", "Delete this draft"].every((w) => ow.includes(w) && studio.includes(w))], [true]);
  is("a short draft gets both mailbox links, as the studio offers them", draftLinks(o.to, o.subject, pitchText(o.body, footer)) !== null, true);
  is("every address is on a reserved example domain", [o.to, o.page].every((w) => /\.example(\/|$)/.test(w)), true);
  is("the caption: part of one pitch, no domain of its own, the stop link shortened, and the business, postal address and words made up", ow.some((w) => /^Part of one pitch, a draft/.test(w) && /without its own domain/.test(w) && /stop link shortened/.test(w) && w.includes("The business, the postal address and the words are made up as an example.")), true);
  is("drawn, hidden, beside its caption", hidden(ot), true);

  part("Moving to Marktmorgen");
  is("the switching page shows its card", findPage("platform", "switching-to-marktmorgen")?.visual, "importDone");
  const im = draw("importDone");
  const iw = text(im);
  const tool = read("components/import-tool.tsx");
  const importPage = read("app/studio/import/page.tsx");
  const ex = IMPORT_EXAMPLE;
  const rowsIn = ex.counts.added + ex.counts.already + ex.counts.skipped + ex.counts.errors;
  is("the tool and the picture read one list of words", [tool.includes('from "@/lib/import-words"'), /const (WORDS|OUTCOME_WORDS)\b/.test(tool), IMPORT_WORDS.contacts.added, OUTCOME_WORDS.products.added], [true, false, "added to your list", "made as drafts"]);
  is("Your last imports, and the import as the page names it, from its own tab's title", [iw.includes("Your last imports"), importPage.includes("Your last imports"), iw.includes(`Your email list: ${ex.file}`), /kind: "contacts",\s*title: "Your email list"/.test(importPage)], [true, true, true, true]);
  is("its day in UTC and its rows, in the page's own format, the rows the four counts add up to", [iw.includes(`${IMPORT_DATE.format(new Date(ex.at))} UTC · ${rowsIn.toLocaleString("en-US")} rows`), importPage.includes("const DATE = IMPORT_DATE;"), importPage.includes('{`${DATE.format(new Date(job.at))} UTC · ${job.total.toLocaleString("en-US")} rows`}')], [true, true, true]);
  is("Finished, and the four counts in the tool's words for a list, in its order", [iw.includes("Finished"), tool.includes('? "Finished"'), [IMPORT_WORDS.contacts.added, IMPORT_WORDS.contacts.already, IMPORT_LEFT_WORDS.skipped, IMPORT_LEFT_WORDS.errors].map((w) => iw.indexOf(w)).every((at, k, all) => at >= 0 && (k === 0 || at > all[k - 1])), ["{IMPORT_LEFT_WORDS.skipped}</dt>", "{IMPORT_LEFT_WORDS.errors}</dt>"].every((w) => tool.includes(w))], [true, true, true, true]);
  is("no tiles for contacts that cannot be emailed while there are none, as the tool hides them", [iw.includes("contacts you cannot email"), tool.includes('job.kind === "contacts" && (job.counts.contacts || job.counts.stopped)')], [false, true]);
  is("the counts, two to a row, as a past import shows them", [importPage.includes("<ImportProgress job={view(job)} compact />"), tool.includes('grid grid-cols-2 gap-2 text-sm ${compact ? "" : "sm:grid-cols-4"}')], [true, true]);
  is("the rows not brought in, linked when there are any", [iw.includes("Download the rows that were not brought in"), tool.includes("job.counts.errors + job.counts.skipped > 0 && !running(job.state)"), ex.counts.errors + ex.counts.skipped > 0], [true, true, true]);
  is("the counts inside what a list import takes, and what the Store plan imports in a month", [rowsIn <= IMPORT_LIMITS.contacts, rowsIn <= IMPORT_ALLOWANCES.creator.rows, findPage("platform", "switching-to-marktmorgen")?.plan], [true, true, "creator"]);
  is("the file, the day and the counts are said to be an example", iw.some((w) => /^One of your last imports/.test(w) && w.includes("The file, the day and the counts are made up as an example.")), true);
  is("drawn, hidden, beside its caption", hidden(im), true);

  part("Moving from ClickFunnels");
  is("the ClickFunnels page shows its card", findPage("platform", "move-from-clickfunnels")?.visual, "dryRun");
  const dr = draw("dryRun");
  const dw = text(dr);
  const dx = DRY_RUN_EXAMPLE;
  const flatTool = tool.replace(/\s+/g, " ");
  is("the heading and its sentence, word for word", [dw.includes("Dry run: what this file will do"), tool.includes("Dry run: what this file will do"), dw.includes("Every row was checked the way the import checks it, against your store as it is now. Nothing was saved. The import checks every row again when it runs."), flatTool.includes("Every row was checked the way the import checks it, against your store as it is now. Nothing was saved. The import checks every row again when it runs.")], [true, true, true, true]);
  const shownWords = (Object.keys(OUTCOME_WORDS.products) as (keyof typeof OUTCOME_WORDS.products)[]).filter((o) => (dx.counts[o] ?? 0) > 0 || o === "added").map((o) => OUTCOME_WORDS.products[o]);
  is("a tile for each outcome with rows, and always the first, in the tool's words for products", [shownWords, tool.includes('.filter((o) => dry.counts[o] > 0 || o === "added")'), dw.includes(OUTCOME_WORDS.products.error ?? "?")], [["made as drafts", "already in your store", "left out"], true, false]);
  is("the rows worth a look, under the table's own headings", [["Rows worth a look", "Row", "Becomes", "Why", "Value"].every((w) => dw.includes(w)), tool.includes(': "Rows worth a look"'), ["Row", "Becomes", "Why", "Value"].every((w) => tool.includes(`font-semibold">${w}</th>`))], [true, true, true]);
  const server = read("lib/imports.ts");
  is("each row's note is the one the server writes", [dw.includes("A product with this title is already in your store: no copy is made"), server.includes('"A product with this title is already in your store: no copy is made"'), dw.includes("The same title as row 6"), server.includes('"The same title as row"') && server.includes("`${words} ${earlier}`")], [true, true, true, true]);
  const fileRows = (dx.counts.added ?? 0) + (dx.counts.already ?? 0) + (dx.counts.skipped ?? 0) + (dx.counts.error ?? 0);
  is("a repeated title points back to an earlier row that was made, and every row is inside the file (the header is row 1)", dx.rows.filter((r) => r.outcome === "skipped").map((r) => { const n = Number(/The same title as row (\d+)$/.exec(r.note)?.[1]); return n >= 2 && n < r.line && !dx.rows.some((x) => x.line === n); }).concat([dx.rows.every((r) => r.line >= 2 && r.line <= fileRows + 1)]), [true, true]);
  is("the bar names the studio's own step", [dr.includes("Studio · Move from ClickFunnels"), importPage.includes("Move from ClickFunnels")], [true, true]);
  is("and the link to every row", [dw.includes("Download the dry run, every row"), tool.includes("Download the dry run, every row")], [true, true]);
  is("the products and counts are said to be an example, before anything is saved", dw.some((w) => /^Part of the dry run of a products file from ClickFunnels/.test(w) && /buttons to import it sit under it/.test(w) && w.includes("The products and the counts are made up as an example.")), true);
  is("drawn, hidden, beside its caption", hidden(dr), true);

  part("Nothing that is not the code's or marked as an example");
  for (const [name, words, allowed] of [
    ["bundles", b, /^(In it: 3 of \d+|\$77 of products for \$49|\$\d+(\.\d\d)?|.*example.*)$/],
    ["quizzes", q, /^(70|3|.*example.*)$/],
    ["keys", k, /^(K7QM-R4TX-9WHC-P2ND|Each buyer gets a new key made for them, like XXXX-XXXX-XXXX-XXXX\. No key is ever given twice\.|.*example.*)$/],
    ["webhooks", h, /^(1 of \d+|Last 3 deliveries|Delivered \(200\)|· Nov 1, \d+:\d\d PM|hooks\.zapier\.com\/hooks\/cat…bcdefg|.*example.*)$/],
    ["calendar", c, /^(1 of \d+ read|Read 4 min ago · 12 busy times in the next \d+ days · added Oct 20, 2026|.*example.*)$/],
    ["discord", d, /^(Up to \d+ roles for each product, on up to \d+ products\.|Gives \d roles?\.|.*example.*)$/],
    ["community", m, /^(48|112|31|.*example.*)$/],
    ["affiliates", a, /^(120|6|\$59\.40|\$30|\$29\.40|.*example.*)$/],
    ["security", sec, /^(Added Oct 12, 2026 · last used Oct 30, 2026 · synced across your devices|On\. Logging in .* 10 recovery codes left\. Lose your phone .*lets you back in\.|.*example.*)$/],
    ["phone", pn, /^(A community live event starts in 15 minutes|.*example.*)$/],
    ["stamp", sp, /^(Week 1: the plan|Sold to maya@example\.com on Sep 26, 2026 · order …E54F2A · for personal use|.*example.*)$/],
    ["team", t, new RegExp(`^(2 of ${MAX_TEAM} places used|Joined Oct 3, 2026|Invited as ${ROLE_NAMES.support} · the link works until Nov 8|.*example.*)$`)],
    ["sales pages", sg, new RegExp(`^(\\d\\. (${BLOCK_KINDS.map((k) => k.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})|${blocks.length} blocks live on its page\\.|What you get · 5 items|\\d items|3 for, 2 not for|Add a block \\(${blocks.length} of ${MAX_BLOCKS}\\)|.*example.*)$`)],
    ["ai writing", ai, new RegExp(`^(${AI_LEFT_EXAMPLE} left this month\\. .*|.*example.*)$`)],
    ["deals", cw, /^(People you are talking to .* 2 open, worth \$1,800; won so far, \$0\.|· 2 open|1 · \$(600|1,200)|\$(600|1,200)|.*example.*)$/],
    ["outreach", ow, /^(Address printed on their own website, read October 28, 2026: .*|123 Example Street, Portland, ME 04101, United States|.*example.*)$/],
    ["import", iw, /^(Oct 30, 02:05\sPM UTC · 968 rows|912|41|12|3|.*example.*)$/],
    ["dry run", dw, /^(12|1|4|9|The same title as row 6|.*example.*)$/],
    ["events", e, /^(2 coming up|\w+day, November (10|19)\b.* \(E[SD]T\) · (1 hour|45 minutes)|12 of 30 places taken|8 going|The way in shows \d+ minutes before the start, only to members who can come\.|.*example.*)$/],
  ] as const) {
    is(`${name}: every figure is the code's, or an example said as one`, words.filter((w) => /\d/.test(w) && !allowed.test(w)), []);
  }
}

main();
done();
