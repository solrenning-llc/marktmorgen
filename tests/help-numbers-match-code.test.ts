/**
 * Every number the help center types by hand (lib/help-content.ts) and the
 * buyer help (lib/buyer-help.ts) is the number the code enforces (Claude 7,
 * help-truth audit, 12 November 2026; AGENTS.md VR Part A item 2: a page never
 * shows a limit the product does not keep).
 *
 * Each expected phrase below is built from the constant itself, never retyped,
 * so a change to a limit fails here until the copy says the new number. A few
 * constants are not exported; their values are read from the source by name.
 * Where the code holds the value inline with no constant (checkout rate limit,
 * stats alert threshold), the source line itself is matched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HELP_SECTIONS } from "@/lib/help-content";
import { BUYER_HELP } from "@/lib/buyer-help";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { MAX_STORE_LINKS } from "@/lib/store-link";
import { STORE_PAGE_SIZE } from "@/lib/catalog";
import { MAX_ABOUT_LENGTH } from "@/lib/product-about";
import { MAX_FILE_BYTES, MAX_STAMP_BYTES, MULTIPART_ABOVE_BYTES } from "@/lib/product-file";
import { TRIAL_DAYS } from "@/lib/plan";
import { KEPT_DAYS } from "@/lib/stats";
import { WELCOME_HOURS, WELCOME_PERCENTS } from "@/lib/welcome-offer";
import { MAX_LINKS } from "@/lib/short-link-rules";
import { WITHDRAWAL_KEEP_DAYS } from "@/lib/withdrawal";
import { WITHDRAWAL_DAYS } from "@/lib/withdrawal-rules";
import { INVITE_COOKIE_DAYS } from "@/lib/creator-invite-rules";
import { DELIVERY_ALLOWANCE_BYTES } from "@/lib/delivery";
import { AWAY_AFTER_MS, LIVE_MS, ROOM_GRANT_MINUTES } from "@/lib/chat-pace";
import { TRANSLATE_PART_CHARS } from "@/lib/page-translate";
import { MAX_SALE_DAYS } from "@/lib/store-sale";
import { FAIR_LEVEL_CHOICES, FAIR_MAX_CHOICES } from "@/lib/fair-price";
import { MAX_POST_BODY, MAX_POSTS } from "@/lib/store-blog";
import { MAX_TRIAL_DAYS, MIN_TRIAL_DAYS } from "@/lib/product-recurring";
import { MAX_INTRO_COUNT } from "@/lib/intro-price";
import { CARD_NOTICE_DAYS, REMINDER_DAYS } from "@/lib/dunning-rules";
import { MAX_TIERS, MIN_TIERS } from "@/lib/tier-rules";
import { LOOKAHEAD_DAYS } from "@/lib/calendar-limits";
import { SWITCH_BEFORE_MS } from "@/lib/meet-links";
import { PACKAGE_DAYS } from "@/lib/call-package-rules";
import { DEAL_MAX_PERCENT, DEAL_MIN_PERCENT } from "@/lib/cart-rules";
import { MAX_COLLECTION_PRODUCTS, MAX_COLLECTIONS } from "@/lib/store-collections";
import { CAMPAIGN_TAG_MAX } from "@/lib/came-from";
import { ATTRIBUTION_DAYS, DEFAULT_ATTRIBUTION_DAYS } from "@/lib/attribution-rules";
import { FIRST_CHANNEL_DAYS } from "@/lib/visit-channel";
import { MAX_LESSON_FILES } from "@/lib/course";
import { MAX_QUESTIONS } from "@/lib/quiz";
import { MAX_TASK_FILE_BYTES } from "@/lib/assignment-rules";
import { LIBRARY_LINK_SECONDS, MAX_LIBRARY_STORES } from "@/lib/buyer-library";
import { RUN_KEEP_SECONDS } from "@/lib/flow-limits";
import { MAX_ASK_DAYS, MIN_ASK_DAYS } from "@/lib/review-ask";
import { MAX_REVIEW_TEXT } from "@/lib/review-summary";
import { PASS_SECONDS } from "@/lib/learn";
import { EVENT_LENGTHS, JOIN_EARLY_MINUTES, MAX_EVENT_AHEAD_DAYS, MAX_POST_TEXT } from "@/lib/community-text";
import { LEVELS } from "@/lib/community-levels";
import { MAX_AFFILIATES, MAX_BONUSES, MAX_COMMISSION, MIN_COMMISSION, RECURRING_OPTIONS, SECOND_TIER_OPTIONS } from "@/lib/affiliate-setting";
import { MAX_LEAD_HOLD_DAYS, MIN_LEAD_HOLD_DAYS } from "@/lib/affiliate-lead-rules";
import { MAX_COMMITTED_SHARE } from "@/lib/partner-share";
import { RECENT_DAYS, SHOWN } from "@/lib/recent-sales-rules";
import { MAX_FIELDS } from "@/lib/forms";
import { KEEP_DAYS as INBOX_KEEP_DAYS, MAX_CONVERSATIONS } from "@/lib/inbox-rules";
import { RELEASE_QUARANTINE_DAYS } from "@/lib/store";
import { RESET_DAYS } from "@/lib/two-step";

const DAY = 86_400;
const n = (x: number) => x.toLocaleString("en-US");
const gb = (bytes: number) => bytes / 1024 ** 3;
const mb = (bytes: number) => bytes / 1024 ** 2;
const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const word = (x: number) => words[x] ?? n(x);
const hours = (x: number) => (x === 1 ? "an hour" : `${word(x)} hours`);
const real = (list: readonly number[]) => list.filter((x) => x > 0);
const list = (xs: readonly (number | string)[], last = "or") => xs.slice(0, -1).join(", ") + ` ${last} ` + xs[xs.length - 1];

/** A constant that is not exported, read from its source by name. */
function sourceNumber(file: string, name: string): number {
  const src = readFileSync(file, "utf8");
  const m = new RegExp(`const ${name}\\s*=\\s*([^;]+);`).exec(src);
  assert.ok(m, `${name} was not found in ${file}`);
  const value = Function(`"use strict"; return (${m[1].replace(/_/g, "")});`)();
  assert.equal(typeof value, "number", `${name} in ${file} is not a plain number`);
  return value;
}

const help = HELP_SECTIONS.flatMap((s) => s.items.flatMap((i) => i.a)).join("\n");
const buyer = BUYER_HELP.flatMap((i) => i.a).join("\n");

const LINK_TTL_SECONDS = sourceNumber("lib/auth.ts", "LINK_TTL_SECONDS");
const PAID_SECONDS = sourceNumber("lib/learn.ts", "PAID_SECONDS");
const OPEN_SECONDS = sourceNumber("lib/community-access.ts", "OPEN_SECONDS");

/** [what the claim is about, the phrase built from the code's own value]. */
const HELP_CLAIMS: [string, string][] = [
  ["products per store", `up to ${n(MAX_PRODUCTS)} products`],
  ["links on a store page", `up to ${MAX_STORE_LINKS} links`],
  ["tracked links per store", `A store can have up to ${MAX_LINKS} links`],
  ["products per store page", `${STORE_PAGE_SIZE} products a page`],
  ["long description", `long description of up to ${n(MAX_ABOUT_LENGTH)} characters`],
  ["file size", `Up to ${gb(MAX_FILE_BYTES)} GB`],
  ["upload in parts", `Anything over about ${mb(MULTIPART_ABOVE_BYTES)} MB is uploaded in parts`],
  ["plan trial", `The ${TRIAL_DAYS}-day free trial`],
  ["any dates window", `any stretch of the last ${KEPT_DAYS} days`],
  ["welcome offer percents", `a discount of ${Math.min(...WELCOME_PERCENTS)}% to ${Math.max(...WELCOME_PERCENTS)}%`],
  ["withdrawal record kept", `in our record of that order for ${WITHDRAWAL_KEEP_DAYS} days`],
  ["withdrawal window", `has ${WITHDRAWAL_DAYS} days to cancel`],
  ["invite lifetime", `original ${INVITE_COOKIE_DAYS}-day lifetime`],
  ["download allowance", `covers ${gb(DELIVERY_ALLOWANCE_BYTES)} GB of downloads a month`],
  ["room grant", `counts by the ${ROOM_GRANT_MINUTES} minutes it is open`],
  ["room live check", `checks every ${LIVE_MS / 1000} seconds`],
  ["room idle", `nobody has touched for ${AWAY_AFTER_MS / 60_000} minutes`],
  ["translation unit", `one for every ${n(TRANSLATE_PART_CHARS)} characters`],
  ["store sale length", `(at most ${MAX_SALE_DAYS} days)`],
  ["fair price ceiling", `(${Math.min(...FAIR_MAX_CHOICES)}% to ${Math.max(...FAIR_MAX_CHOICES)}% off)`],
  ["fair price levels", `from ${Math.min(...real(FAIR_LEVEL_CHOICES))}% to ${Math.max(...FAIR_LEVEL_CHOICES)}% off`],
  ["blog size", `up to ${MAX_POSTS} posts of up to ${n(MAX_POST_BODY)} characters`],
  ["membership trial", `free trial of ${MIN_TRIAL_DAYS} to ${MAX_TRIAL_DAYS} days`],
  ["intro price months", `first 1 to ${MAX_INTRO_COUNT} months`],
  ["payment retries", `then ${REMINDER_DAYS[1]} and ${REMINDER_DAYS[2]} days after the first`],
  ["card expiry notice", `up to ${CARD_NOTICE_DAYS} days ahead`],
  ["membership tiers", `pick ${MIN_TIERS} to ${MAX_TIERS} memberships`],
  ["calendar look-ahead", `up to ${LOOKAHEAD_DAYS} days ahead`],
  ["meeting link switch", `more than ${hours(SWITCH_BEFORE_MS / 3_600_000)} before`],
  ["package expiry", `${list(real(PACKAGE_DAYS))} days, or no limit`],
  ["cart deal percent", `from ${DEAL_MIN_PERCENT}% to ${DEAL_MAX_PERCENT}%`],
  ["collections", `up to ${MAX_COLLECTIONS} collections of up to ${MAX_COLLECTION_PRODUCTS} products`],
  ["campaign names", `Names are limited to ${CAMPAIGN_TAG_MAX} characters`],
  ["attribution windows", list(ATTRIBUTION_DAYS.map((d) => (d === DEFAULT_ATTRIBUTION_DAYS ? `${d} (until you change it)` : String(d)))) + " days"],
  ["first channel window", `in the ${FIRST_CHANNEL_DAYS} days before`],
  ["lesson files", `up to ${word(MAX_LESSON_FILES)} downloads`],
  ["quiz questions", `up to ${MAX_QUESTIONS} questions`],
  ["assignment file", `a file of up to ${mb(MAX_TASK_FILE_BYTES)} MB`],
  ["library link", `for ${LIBRARY_LINK_SECONDS / 3600} hours, every store`],
  ["flow history", `history for up to ${RUN_KEEP_SECONDS / DAY} days`],
  ["review ask", `${MIN_ASK_DAYS} to ${MAX_ASK_DAYS} days after buying`],
  ["review text", `up to ${n(MAX_REVIEW_TEXT)} characters`],
  ["member pass", `stays in for ${PASS_SECONDS / DAY} days`],
  ["community post", `up to ${n(MAX_POST_TEXT)} characters and one picture`],
  ["community levels", `points make ${LEVELS.length} levels`],
  ["event lengths", `from ${Math.min(...EVENT_LENGTHS)} minutes to ${word(Math.max(...EVENT_LENGTHS) / 60)} hours`],
  ["event way in", `from ${JOIN_EARLY_MINUTES} minutes before the start`],
  ["affiliate commission", `commission of ${MIN_COMMISSION}% to ${MAX_COMMISSION}%`],
  ["affiliates", `Up to ${n(MAX_AFFILIATES)} people`],
  ["recurring commission", `${list(RECURRING_OPTIONS.filter((m) => m > 1 && m < 100))} months`],
  ["affiliate bonuses", `up to ${word(MAX_BONUSES)} monthly bonuses`],
  ["lead hold", `hold of ${MIN_LEAD_HOLD_DAYS} to ${MAX_LEAD_HOLD_DAYS} days`],
  ["second tier", `second tier of ${Math.min(...real(SECOND_TIER_OPTIONS))}% to ${Math.max(...SECOND_TIER_OPTIONS)}%`],
  ["committed share", `never passes ${MAX_COMMITTED_SHARE}%`],
  ["PDF stamp", `PDFs up to ${mb(MAX_STAMP_BYTES)} MB are stamped`],
  ["recent sales", `for ${RECENT_DAYS} days each: up to ${SHOWN} a visit`],
  ["form questions", `up to ${MAX_FIELDS} questions`],
  ["inbox keep", `kept ${INBOX_KEEP_DAYS} days after their last message, the newest ${MAX_CONVERSATIONS}`],
  ["released address", `leads nowhere for ${RELEASE_QUARANTINE_DAYS} days`],
  ["sign-in link", `stops working after ${LINK_TTL_SECONDS / 60} minutes`],
  ["two-step reset", `locked for ${RESET_DAYS} days`],
  ["access after paying", `the course within ${PAID_SECONDS / 60} minutes, the community within ${OPEN_SECONDS / 60}`],
  ["event ahead", MAX_EVENT_AHEAD_DAYS === 365 ? "up to a year ahead" : `up to ${MAX_EVENT_AHEAD_DAYS} days ahead`],
];

test("each number the help center types by hand is the value the code enforces", () => {
  const missing = HELP_CLAIMS.filter(([, phrase]) => !help.includes(phrase)).map(([what, phrase]) => `${what}: "${phrase}"`);
  assert.deepEqual(missing, []);
});

test("the welcome offer's lengths are said exactly as the studio offers them", () => {
  // Built separately and plainly: 24, 48 or 72 hours, or 7 days (168 hours).
  const shortOnes = WELCOME_HOURS.filter((h) => h < 168);
  const longOnes = WELCOME_HOURS.filter((h) => h >= 168).map((h) => `${h / 24} days`);
  assert.ok(help.includes(`${list(shortOnes)} hours, or ${longOnes.join(", or ")}`));
});

test("the checkout limit the help states is the limit the checkout route applies", () => {
  const route = readFileSync("app/api/store/checkout/route.ts", "utf8");
  const m = /withinLimit\("checkout",[^,]+,\s*(\d+),\s*(\d+)\)/.exec(route);
  assert.ok(m, "the checkout rate limit was not found");
  assert.ok(help.includes(`Checkouts are limited to ${m[1]} per ${Number(m[2]) / 60} minutes per connection per store`));
});

test("the buyer help says the library's own store count and link lifetime", () => {
  assert.ok(buyer.includes(`up to the ${MAX_LIBRARY_STORES} most recent`));
  assert.ok(buyer.includes(`more than ${MAX_LIBRARY_STORES} stores`));
});

test("no public help text makes a claim AX274 item 7 prohibits", () => {
  const banned = /fully accessible|ADA compliant|WCAG AAA certified|the most accessible platform/i;
  assert.doesNotMatch(help, banned);
  assert.doesNotMatch(buyer, banned);
});
