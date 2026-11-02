/**
 * More feature-page cards (531 [VP1], units 2 and 3; added 1 November 2026):
 * bundles, quizzes and certificates, license keys, webhooks, calendar sync,
 * Discord access (units 2 and 3), the community and affiliates (unit 4),
 * the team and email platforms (unit 6), PDF stamping and ways to pay
 * (unit 7), phone notifications (unit 8), live events (unit 5; the reviews page has none, since a drawn review would
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
import { EXAMPLE_KEY, FeatureVisual } from "@/components/feature-visuals";
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
import { eventTime, lengthWords } from "@/lib/community-events";
import { done, is, part } from "./check";

const text = (html: string) => html.replace(/<[^>]+>/g, "\n").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").split("\n").map((s) => s.trim()).filter(Boolean);
const read = (file: string) => readFileSync(file, "utf8");
const draw = (visual: "bundles" | "quizzes" | "keys" | "webhooks" | "calendar" | "discord" | "community" | "affiliates" | "events" | "team" | "emailPlatforms" | "stamp" | "ways" | "phone") => renderToStaticMarkup(createElement(FeatureVisual, { visual, tone: "light" }));
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
  is("the editor reads the same figures as the server", [calEditor.includes('import { LOOKAHEAD_DAYS, MAX_FEEDS } from "@/lib/calendar-limits";'), /const MAX_FEEDS = /.test(calEditor), read("lib/calendar-sync.ts").includes('import { CACHE_SECONDS, LOOKAHEAD_DAYS, MAX_FEEDS, STALE_SECONDS } from "@/lib/calendar-limits";')], [true, false, true]);
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
    ["phone", pn, /^(A community live event starts in 15 minutes|.*example.*)$/],
    ["stamp", sp, /^(Week 1: the plan|Sold to maya@example\.com on Sep 26, 2026 · order …E54F2A · for personal use|.*example.*)$/],
    ["team", t, new RegExp(`^(2 of ${MAX_TEAM} places used|Joined Oct 3, 2026|Invited as ${ROLE_NAMES.support} · the link works until Nov 8|.*example.*)$`)],
    ["events", e, /^(2 coming up|\w+day, November (10|19)\b.* \(E[SD]T\) · (1 hour|45 minutes)|12 of 30 places taken|8 going|The way in shows \d+ minutes before the start, only to members who can come\.|.*example.*)$/],
  ] as const) {
    is(`${name}: every figure is the code's, or an example said as one`, words.filter((w) => /\d/.test(w) && !allowed.test(w)), []);
  }
}

main();
done();
