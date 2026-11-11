/**
 * Marktmorgen Path, as rules (added 18 October 2026; docs/marktmorgen-path.md
 * has the inventory of what a store already records and every decision).
 *
 * A path of missions that takes a creator from a published store to the
 * first real sale, with levels after it. Three rules hold everything here:
 *
 *   - Every mission ends on a fact the store already records, never on a
 *     box somebody ticks: a title and a line on the public page, a product
 *     with what the buyer gets, a test purchase Stripe marks as test mode, a
 *     visit counted from a social network, short links made for posts, an
 *     address left on the store, a paid order Stripe confirms. `PathFacts`
 *     is the only input; nothing in this file can mark a mission done.
 *   - Nothing here is a forecast. The income goal is the person's own figure
 *     and is only ever shown as "your goal"; no sentence projects, promises
 *     or compares earnings.
 *   - Nothing here fails. A day not done is the day to do next; there is no
 *     "missed", no "behind", no screen that says a person fell short.
 *
 * Pure, so the studio page, the reminder job and the tests read it the same
 * way, and a browser can import it.
 */
import { formatMoney, isCurrency, currencyRule } from "@/lib/money";
import { readGoal } from "@/lib/sales-goal-rules";

// ---- The words every Path page and message stands on -------------------------

/** The feature's own line, as the owner wrote it. */
export const PATH_SLOGAN = "Every step is real. Every sale is yours.";
/** The page's title. */
export const PATH_TITLE = "From first light to first sale.";
/** Its name in the studio. */
export const PATH_NAME = "Path";

/**
 * Phrases no Path text may ever carry (FTC's rules on earnings claims, and
 * Stripe's restricted-business list, which names "get rich" offers):
 * tests/path-words.test.ts reads every Path file for them. Matched without
 * regard to case.
 */
export const FORBIDDEN_PHRASES: readonly RegExp[] = [
  /make money online/i,
  /financial freedom/i,
  /replace your (job|income|salary)/i,
  /quit your job/i,
  /passive income/i,
  /get rich/i,
  /six[- ]figure/i,
  /seven[- ]figure/i,
  /\bearn(ed|s|ing)?\s+(up to\s+)?\$/i,
  /\bmade\s+\$\d/i,
  /guaranteed (income|results|sales)/i,
  /\bwork from anywhere\b/i,
  // The old commission list's "Studio pays for itself from $3,629" and "Scale
  // from $7,273" (today a sale carries 0%): a plan change is only ever shown
  // near a limit, with the person's own usage (lib/path-plan.ts).
  /pays for itself/i,
  /\$\s?3,?629\b/,
  /\$\s?7,?273\b/,
];

/** Words that are other companies' marks in this category (Kajabi Hero, Skool Games): never used. */
export const FORBIDDEN_MARKS: readonly RegExp[] = [/\bhero(es)?\b/i, /\bgames?\b/i];

/** The first forbidden phrase or mark a text carries, or null. */
export function forbiddenIn(text: string): string | null {
  for (const pattern of [...FORBIDDEN_PHRASES, ...FORBIDDEN_MARKS]) {
    const found = text.match(pattern);
    if (found) return found[0];
  }
  return null;
}

// ---- The four questions ------------------------------------------------------

export const AUDIENCES = ["instagram", "tiktok", "youtube", "email", "none"] as const;
export type Audience = (typeof AUDIENCES)[number];
export const AUDIENCE_WORDS: Record<Audience, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  email: "An email list",
  none: "Nowhere yet",
};

export const MINUTES = [15, 30, 60] as const;
export type Minutes = (typeof MINUTES)[number];

/** The longest a person's own words may be. */
export const MAX_SKILLS = 120;
export const MAX_SUBJECT = 80;
export const MAX_TIME_ZONE = 64;

export type PathAnswers = {
  /** The person's own monthly goal, in the store's currency's smallest unit; 0 for none. Only ever shown as their goal. */
  goalCents: number;
  /** The currency it was typed in: a goal in another currency is not shown as this one. */
  goalCurrency: string;
  /** What they know how to do, in their words. */
  skills: string;
  /** What they want to make something about. */
  subject: string;
  minutes: Minutes;
  audience: Audience;
  /** Their time zone, as their browser names it ("America/Sao_Paulo"): days and quiet hours are theirs. */
  timeZone: string;
};

/** A line of text as typed: no control characters, spaces collapsed, cut to `max`. */
export function cleanLine(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** Whether a time zone is one this runtime knows. */
export function validTimeZone(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw || raw.length > MAX_TIME_ZONE || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(raw)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** The answers as sent, or the first thing wrong with them, in a sentence. */
export function readAnswers(raw: unknown, currency: string): { ok: true; answers: PathAnswers } | { ok: false; message: string } {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const goal = readGoal(value.goalCents ?? 0);
  if (goal === null) return { ok: false, message: "Your monthly goal has to be a whole amount, or left empty." };
  const minutes = Number(value.minutes);
  if (!MINUTES.includes(minutes as Minutes)) return { ok: false, message: "Choose 15, 30 or 60 minutes a day." };
  const audience = typeof value.audience === "string" && (AUDIENCES as readonly string[]).includes(value.audience) ? (value.audience as Audience) : null;
  if (!audience) return { ok: false, message: "Choose where your audience is today, or Nowhere yet." };
  const timeZone = validTimeZone(value.timeZone) ? value.timeZone : "UTC";
  return {
    ok: true,
    answers: {
      goalCents: goal,
      goalCurrency: isCurrency(currency) ? currency : "usd",
      skills: cleanLine(value.skills, MAX_SKILLS),
      subject: cleanLine(value.subject, MAX_SUBJECT),
      minutes: minutes as Minutes,
      audience,
      timeZone,
    },
  };
}

/** The goal, as it may be said: the person's own figure, never a forecast. Empty when none, or set in another currency. */
export function goalWords(answers: Pick<PathAnswers, "goalCents" | "goalCurrency">, currency: string): string {
  if (!answers.goalCents || answers.goalCurrency !== currency) return "";
  return `Your goal: ${formatMoney(answers.goalCents, currency)} a month. It is yours, and nothing here predicts it.`;
}

// ---- What the store records -----------------------------------------------------

/**
 * The facts the path is read from, each from a record the store already
 * keeps (lib/path-facts.ts says where). Nothing a person ticks.
 */
export type PathFacts = {
  /** The store's name and the line under it, as its public page shows them. */
  titlePublished: boolean;
  /** Products listed (not drafts). */
  listedProducts: number;
  /** A listed product with something to hand over: a file, a course or a link. */
  productWithFile: boolean;
  /**
   * A paid checkout Stripe marks as test mode (livemode false). "unavailable"
   * where the store's checkout runs live: Stripe has no test mode for a live
   * store here, and a real purchase of one's own is never asked for.
   */
  testPurchase: "done" | "open" | "unavailable";
  /** Visits counted from social networks, all time (lib/stats.ts, the all-time record). */
  socialVisits: number;
  /** Visitors, all time. */
  visitors: number;
  /** Short links made for posts (lib/short-links.ts). */
  postLinks: number;
  /** Addresses left on the store: a free product asked for, the sign-up box, a waitlist. */
  leads: number;
  /** Real (live mode) paid orders Stripe confirms that are not refunded in full. */
  realSales: number;
  /**
   * Real money kept: paid orders less refunds, in the store's currency's
   * smallest unit; null when it could not be read in full, so no level moves
   * on a figure that is not known.
   */
  revenueCents: number | null;
  /** The store's currency. */
  currency: string;
  /** Whether the store's checkout runs in Stripe's test mode (lib/stripe-connect.ts, sellsInTestMode). */
  testMode: boolean;
};

export const NO_FACTS: PathFacts = {
  titlePublished: false,
  listedProducts: 0,
  productWithFile: false,
  testPurchase: "open",
  socialVisits: 0,
  visitors: 0,
  postLinks: 0,
  leads: 0,
  realSales: 0,
  revenueCents: null,
  currency: "usd",
  testMode: false,
};

/** The sources counted as social networks, as lib/source-rules.ts names them. */
export const SOCIAL_SOURCES: readonly string[] = ["instagram", "tiktok", "youtube", "facebook", "x", "threads", "linkedin", "pinterest", "snapchat", "reddit"];

// ---- Missions ---------------------------------------------------------------------

/** Where a mission is done in the studio: a place on its page ("#…") or one of its pages. */
export type Place = { label: string; hash?: string; page?: string; store?: true };

export type MissionId = "title" | "product" | "test" | "social" | "posts" | "lead" | "sale" | `traffic-${number}`;

export type Mission = {
  id: MissionId;
  /** The day of the seven it is, 0 for a traffic mission after them. */
  day: number;
  title: string;
  why: string;
  /** What to do, in the time the person has. */
  steps: string[];
  /** The event that closes it, in a sentence. */
  closesOn: string;
  place: Place;
  state: "done" | "open" | "unavailable";
  /** For a mission with a count, how far along: shown as "2 of 3". */
  progress?: { now: number; of: number };
};

/** Three post links close the fifth day. */
export const POST_LINKS_DAY = 3;

const where: Record<Audience, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  email: "a social network you already use",
  none: "one social network",
};

/** "about cooking", or nothing when there is no subject. */
function about(subject: string): string {
  return subject ? ` about ${subject}` : "";
}

/** The seven days' missions, in order, read against the facts. Ready-made words, at no cost. */
export function dayMissions(facts: PathFacts, answers: Pick<PathAnswers, "minutes" | "audience" | "subject" | "skills">): Mission[] {
  const long = answers.minutes >= 30;
  const hour = answers.minutes >= 60;
  const net = where[answers.audience];
  const social = answers.audience === "instagram" || answers.audience === "tiktok" || answers.audience === "youtube";
  const missions: Mission[] = [
    {
      id: "title",
      day: 1,
      title: "Publish your store's title and one line about it",
      why: "The first thing a visitor reads is who you are and what the store is for.",
      steps: [
        "Write your store's name the way you want people to say it.",
        answers.subject ? `Add one line under it that says what you make${about(answers.subject)}.` : "Add one line under it that says what you make and who it is for.",
        ...(long ? ["Open your store as a visitor would and read the top of the page aloud."] : []),
      ],
      closesOn: "Closes when your store's public page shows a name and the line under it.",
      place: { label: "Your store's details", hash: "#details" },
      state: facts.titlePublished ? "done" : "open",
    },
    {
      id: "product",
      day: 2,
      title: "Prepare your first digital product",
      why: "One product, with the file a buyer gets, is enough to start.",
      steps: [
        answers.subject ? `Make one product${about(answers.subject)}: a guide, a template, a checklist or a short course.` : "Make one product: a guide, a template, a checklist or a short course.",
        "Upload the file the buyer gets, or point it to your course or a link.",
        ...(long ? ["Give it a price and a one-line summary that says what is inside."] : []),
        ...(hour ? ["Add a picture: a card with a picture is the one a visitor looks at first."] : []),
      ],
      closesOn: "Closes when a listed product has a file, a course or a link to hand over.",
      place: { label: "Products", hash: "#products" },
      state: facts.productWithFile ? "done" : "open",
    },
    {
      id: "test",
      day: 3,
      title: "Make a test purchase in Stripe's test mode",
      why: "Use Stripe test mode to review the buying journey without a real card charge. The recorded checkout does not verify file access or delivery.",
      steps: [
        "Confirm that your store is in Stripe test mode before entering any test-card details. If it is live, skip this mission; do not use a real card.",
        "Open one of your products on your store and press its button.",
        "Pay with Stripe's test card 4242 4242 4242 4242, any future date and any three digits.",
        "Check that the thanks page hands over the file.",
      ],
      closesOn:
        facts.testPurchase === "unavailable"
          ? "Your store's checkout runs live, where Stripe has no test mode for it. This day is left open, it does not hold the path back, and you are never asked to buy from yourself with a real card."
          : "Closes when Stripe records a paid checkout in test mode on your store. File access and delivery still need a manual check.",
      place: { label: "Your store", store: true },
      state: facts.testPurchase,
    },
    {
      id: "social",
      day: 4,
      title: `Bring your first visitor from ${net}`,
      why: "People already scroll there. One link is how they find your store.",
      steps: [
        social
          ? `Put your store's address in your ${net} ${answers.audience === "youtube" ? "channel description and the next video's description" : "bio"}.`
          : `Put your store's address on your profile on ${net}.`,
        `Post once${about(answers.subject)} and say where the link is.`,
        ...(long ? ["Reply to the comments the same day: a reply brings people back to the post."] : []),
      ],
      closesOn: "Closes when your store counts a visit that came from a social network.",
      place: { label: "Share your store", hash: "#details" },
      state: facts.socialVisits > 0 ? "done" : "open",
    },
    {
      id: "posts",
      day: 5,
      title: `Make ${POST_LINKS_DAY} post links`,
      why: "A short link for each post tells you which post brought each visit, and later each sale.",
      steps: [
        "Open Share the store, then Posts, and make a short link for a post you plan.",
        `Make ${POST_LINKS_DAY} in all: one for each post, video or story.`,
        ...(long ? ["Use each link in its own post, so the numbers keep them apart."] : []),
      ],
      closesOn: `Closes when your store has ${POST_LINKS_DAY} short links for posts.`,
      place: { label: "Share the store: posts", hash: "#details" },
      state: facts.postLinks >= POST_LINKS_DAY ? "done" : "open",
      progress: { now: Math.min(facts.postLinks, POST_LINKS_DAY), of: POST_LINKS_DAY },
    },
    {
      id: "lead",
      day: 6,
      title: "Capture your first lead",
      why: "Somebody not ready to buy today can still sign up and hear from you later.",
      steps: [
        "Turn on the sign-up box on your store, or make something free that is given for an email address.",
        "Mention it in your next post with one of your post links.",
        ...(long ? ["Say in one line what they get by signing up."] : []),
      ],
      closesOn: "Closes when somebody confirms their address from the email we send them. An address that was only typed in does not count. Older sign-ups that were never confirmed no longer count either, so a store may show no leads until someone confirms.",
      place: { label: "Sign-up box", hash: "#signup" },
      state: facts.leads > 0 ? "done" : "open",
    },
    {
      id: "sale",
      day: 7,
      title: "Record your first real sale through Stripe",
      why: "A paid order from somebody else, confirmed by Stripe.",
      steps: [
        "Once your live checkout is available, share a post link and say plainly what the product is and what it costs.",
        "Answer every question you get the same day.",
        ...(long ? ["If they agreed to marketing, send the people on your list one note about the product."] : []),
      ],
      closesOn: facts.testMode
        ? "Closes when Stripe confirms a real paid order on your store. Your store's checkout runs in test mode now, so a real order can only come once it runs live."
        : "Closes when Stripe confirms a real paid order on your store. A refund in full takes it back off.",
      place: { label: "Sales", hash: "#sales" },
      state: facts.realSales > 0 ? "done" : "open",
    },
  ];
  return missions;
}

/** After the seven days with no sale yet: missions that bring people, each closed by a count the store keeps. */
export const TRAFFIC_MISSIONS: readonly { kind: "social" | "posts" | "leads" | "visitors"; of: number }[] = [
  { kind: "social", of: 10 },
  { kind: "posts", of: 5 },
  { kind: "social", of: 50 },
  { kind: "leads", of: 5 },
  { kind: "visitors", of: 100 },
  { kind: "posts", of: 10 },
  { kind: "leads", of: 25 },
  { kind: "social", of: 250 },
];

export function trafficMissions(facts: PathFacts): Mission[] {
  return TRAFFIC_MISSIONS.map((m, i) => {
    const now = m.kind === "social" ? facts.socialVisits : m.kind === "posts" ? facts.postLinks : m.kind === "leads" ? facts.leads : facts.visitors;
    const count = m.of.toLocaleString("en-US");
    const words = {
      social: {
        title: `${count} visits from social networks`,
        why: "Each post with your link is another way in.",
        steps: ["Post with one of your post links.", "Pin the post, or keep the link in your bio, so it keeps working after today."],
        closesOn: `Closes when your store has counted ${count} visits from social networks.`,
        place: { label: "Share your store", hash: "#details" } as Place,
      },
      posts: {
        title: `${count} post links`,
        why: "One link for each post shows which ones bring visitors.",
        steps: ["Make a short link for the next post you plan.", "Look at which of your links brought visits, and post more like it."],
        closesOn: `Closes when your store has ${count} short links for posts.`,
        place: { label: "Share the store: posts", hash: "#details" } as Place,
      },
      leads: {
        title: `${count} people on your list`,
        why: "People who signed up and confirmed their address are the ones most likely to buy later.",
        steps: ["Offer something free for an email address, or mention your sign-up box in a post.", "Write to them when you have something new."],
        closesOn: `Closes when ${count} people have confirmed their address from the email we send them. An address that was only typed in does not count, and older sign-ups that were never confirmed no longer count either, so a store may show fewer than it did before.`,
        place: { label: "Sign-up box", hash: "#signup" } as Place,
      },
      visitors: {
        title: `${count} visitors`,
        why: "Visitors are where every sale starts.",
        steps: ["Share your store's address where you already talk to people.", "Look at your numbers to see where they come from."],
        closesOn: `Closes when your store has counted ${count} visitors.`,
        place: { label: "Your numbers", hash: "#numbers" } as Place,
      },
    }[m.kind];
    return {
      id: `traffic-${i + 1}` as MissionId,
      day: 0,
      ...words,
      state: now >= m.of ? "done" : "open",
      progress: { now: Math.min(now, m.of), of: m.of },
    } satisfies Mission;
  });
}

export const PATH_DAYS = 7;
const DAY_MS = 86_400_000;

export type PathProgress = {
  /** The seven days, in order. */
  days: Mission[];
  /** Traffic missions, shown once the seven are behind with no sale yet. */
  traffic: Mission[];
  /** The mission to do today: the first open one, in order. Null once the path's missions are all done. */
  today: Mission | null;
  /** Missions done, of those that can be done (a test purchase on a live store cannot). */
  done: number;
  of: number;
  /** Days since the path began, the first day being 1. */
  dayOnPath: number;
  /** The first real sale is in: the path's seven are behind. */
  complete: boolean;
};

/** Where the path stands, from the facts. Nothing in here is stored or ticked. */
export function pathProgress(facts: PathFacts, answers: Pick<PathAnswers, "minutes" | "audience" | "subject" | "skills"> & {timeZone?:string}, startedAt: number, now: number): PathProgress {
  const days = dayMissions(facts, answers);
  const possible = days.filter((m) => m.state !== "unavailable");
  const sale = days.find((m) => m.id === "sale") as Mission;
  const localDates=validTimeZone(answers.timeZone)&&Number.isFinite(startedAt)&&Number.isFinite(now)&&Math.abs(startedAt)<8.64e15&&Math.abs(now)<8.64e15;
  const dayOnPath = localDates?Math.max(1,Math.round((asDate(localDay(answers.timeZone!,now)).getTime()-asDate(localDay(answers.timeZone!,startedAt)).getTime())/DAY_MS)+1):Math.max(1, Math.floor((now - startedAt) / DAY_MS) + 1);
  const beforeSale = days.filter((m) => m.id !== "sale" && m.state !== "unavailable");
  const reachedSale = beforeSale.every((m) => m.state === "done");
  const showTraffic = sale.state !== "done" && (reachedSale || dayOnPath > PATH_DAYS);
  const traffic = showTraffic ? trafficMissions(facts) : [];
  const ordered = [...days.filter((m) => m.state !== "unavailable"), ...traffic];
  // The sale is the goal of everything after the seventh day: today is the
  // first open mission that is not the sale while traffic missions are open.
  const firstOpen = ordered.find((m) => m.state === "open" && (m.id !== "sale" || !traffic.some((t) => t.state === "open")));
  const doneCount = possible.filter((m) => m.state === "done").length + traffic.filter((m) => m.state === "done").length;
  return {
    days,
    traffic,
    today: sale.state === "done" ? null : firstOpen ?? null,
    done: doneCount,
    of: possible.length + traffic.length,
    dayOnPath,
    complete: sale.state === "done",
  };
}

// ---- Levels -------------------------------------------------------------------------

export const LEVELS = ["first-light", "sunrise", "morning", "midday", "golden-hour", "zenith"] as const;
export type Level = (typeof LEVELS)[number];

/** Display names approved by the owner; stable level keys preserve existing records. */
export const LEVEL_NAMES: Record<Level, string> = {
  "first-light": "First Light",
  sunrise: "Sunrise",
  morning: "Morning",
  midday: "High Sun",
  "golden-hour": "Golden Hour",
  zenith: "Zenith",
};

/** Cumulative real money kept that reaches each level after Sunrise, in US cents. */
export const LEVEL_USD_CENTS: Record<"morning" | "midday" | "golden-hour" | "zenith", number> = {
  morning: 10_000,
  midday: 100_000,
  "golden-hour": 1_000_000,
  zenith: 10_000_000,
};

/**
 * A level's figure in the store's own currency: the dollar figure on the
 * scale lib/money.ts already sets every currency's prices on (its largest
 * price against the dollar's), so a yen store's Morning is ¥15,000 as its
 * prices run to ¥750,000. Not a conversion, and never said to be one: sales
 * in another currency than the store's are not counted, as in its numbers.
 */
export function levelCents(level: keyof typeof LEVEL_USD_CENTS, currency: string): number {
  const usd = currencyRule("usd").maxPrice;
  const rule = isCurrency(currency) ? currencyRule(currency) : currencyRule("usd");
  return Math.round((LEVEL_USD_CENTS[level] * rule.maxPrice) / usd);
}

/** What reaching a level asks, in words. */
export function levelRequirement(level: Level, currency: string): string {
  if (level === "first-light") return "Your store's title published, with one product listed.";
  if (level === "sunrise") return "Your first real sale.";
  return `${formatMoney(levelCents(level, currency), currency)} in real sales kept, refunds taken off.`;
}

/** The level the facts reach now: -1 for none yet. */
export function levelNow(facts: PathFacts): number {
  let at = -1;
  if (facts.titlePublished && facts.listedProducts > 0) at = 0;
  if (facts.realSales > 0) at = Math.max(at, 1);
  if (facts.revenueCents !== null && facts.realSales > 0) {
    if (facts.revenueCents >= levelCents("morning", facts.currency)) at = Math.max(at, 2);
    if (facts.revenueCents >= levelCents("midday", facts.currency)) at = Math.max(at, 3);
    if (facts.revenueCents >= levelCents("golden-hour", facts.currency)) at = Math.max(at, 4);
    if (facts.revenueCents >= levelCents("zenith", facts.currency)) at = Math.max(at, 5);
  }
  return at;
}

/**
 * The level kept: the best ever reached. A refund takes the money and the
 * first-sale mission back, never a level already reached (rule 4 of the
 * owner's brief): levels never go down.
 */
export function levelKept(best: number, facts: PathFacts): number {
  return Math.max(Number.isInteger(best) && best >= -1 && best < LEVELS.length ? best : -1, levelNow(facts));
}

// ---- Days in the person's own time zone, the streak and quiet hours ---------------

/** "2026-10-18": the day it is where the person is. */
export function localDay(timeZone: string, now: number): string {
  const zone = validTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The hour it is where the person is, 0 to 23. */
export function localHour(timeZone: string, now: number): number {
  const zone = validTimeZone(timeZone) ? timeZone : "UTC";
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(now));
  return Number.isInteger(hour) ? hour % 24 : 0;
}

/** No notification before 8:00 or from 21:00 in the person's own time. */
export const QUIET_FROM_HOUR = 21;
export const QUIET_UNTIL_HOUR = 8;
export function mayNotify(timeZone: string, now: number): boolean {
  const hour = localHour(timeZone, now);
  return hour >= QUIET_UNTIL_HOUR && hour < QUIET_FROM_HOUR;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (day: string) => new Date(`${day}T12:00:00Z`);
const shift = (day: string, by: number) => new Date(asDate(day).getTime() + by * DAY_MS).toISOString().slice(0, 10);
/** 0 for a Sunday, as a calendar has it. */
const weekday = (day: string) => asDate(day).getUTCDay();
/** The Monday that starts a day's week. */
const weekOf = (day: string) => shift(day, -((weekday(day) + 6) % 7));

/** Rest days a week that never break a streak, at no cost. Sundays never count against it at all. */
export const FREE_REST_DAYS = 2;

export type Streak = {
  /** Days shown up in a row, rest days and Sundays passed over. */
  days: number;
  /** Rest days left this week, Monday to Saturday. */
  restLeft: number;
  /** Whether today is already counted. */
  today: boolean;
};

/**
 * The streak: days the person opened their path, in a row, in their own days.
 * Sunday never breaks it; in each week, up to FREE_REST_DAYS other days may
 * be missed with nothing lost and nothing to pay. Today, until it is over, is
 * never a missed day.
 */
export function streakOf(checkins: readonly string[], today: string): Streak {
  const kept = new Set(checkins.filter((d) => DAY.test(d) && d <= today));
  if (!DAY.test(today) || kept.size === 0) return { days: 0, restLeft: FREE_REST_DAYS, today: false };
  const first = [...kept].sort()[0];
  const missed = new Map<string, number>();
  let count = 0;
  let day = kept.has(today) ? today : shift(today, -1);
  for (let step = 0; step < 800 && day >= first; step += 1) {
    if (kept.has(day)) count += 1;
    else if (weekday(day) !== 0) {
      const week = weekOf(day);
      const n = (missed.get(week) ?? 0) + 1;
      if (n > FREE_REST_DAYS) break;
      missed.set(week, n);
    }
    day = shift(day, -1);
  }
  // Rest days already taken in today's week, counted Monday to yesterday.
  let used = 0;
  for (let d = weekOf(today); d < today; d = shift(d, 1)) if (weekday(d) !== 0 && !kept.has(d) && d >= first) used += 1;
  return { days: count, restLeft: Math.max(0, FREE_REST_DAYS - used), today: kept.has(today) };
}

/** The days kept for the streak: the latest, at most this many. */
export const KEPT_CHECKINS = 60;

/** Adds today to the days shown up, keeping the latest KEPT_CHECKINS. */
export function withCheckin(checkins: readonly string[], today: string): string[] {
  if (!DAY.test(today)) return [...checkins];
  return [...new Set([...checkins.filter((d) => DAY.test(d)), today])].sort().slice(-KEPT_CHECKINS);
}


/** A real calendar date, using the same noon-UTC arithmetic as the streak. */
export function validPathDay(day:unknown):day is string {
 return typeof day==="string"&&DAY.test(day)&&Number.isFinite(asDate(day).getTime())&&shift(day,0)===day;
}

/** Seven creator-local date changes since the latest opening. No elapsed-hour or server-zone rule. */
export function hasPathReturnGap(checkins:readonly string[],timeZone:string,now:number):boolean {
 if(!validTimeZone(timeZone)||!Number.isFinite(now)||Math.abs(now)>=8.64e15)return false;
 const today=localDay(timeZone,now);
 if(!validPathDay(today)||!checkins.length||checkins.some(day=>!validPathDay(day)||day>today))return false;
 const latest=[...new Set(checkins)].sort().at(-1)!;
 return latest<=shift(today,-7);
}

// ---- The words a reminder carries -----------------------------------------------------

/** A reminder of today's mission: a lock screen's worth, with no amount and no name. */
export function reminderOf(progress: PathProgress, streak: Streak): { title: string; body: string } | null {
  if (!progress.today) return null;
  const mission = progress.today;
  const title = mission.day ? `Day ${mission.day} of your path` : "Your next mission on the path";
  const days = streak.days > 0 ? ` ${streak.days === 1 ? "1 day" : `${streak.days} days`} in a row so far.` : "";
  return { title, body: `${mission.title}.${days}`.slice(0, 180) };
}
