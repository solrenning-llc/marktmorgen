/**
 * Queue item 256 [KJ1], unit 1: the rules of the studio demo, a studio any
 * visitor opens without signing up, on a sandbox copy of the fictional demo
 * store, to see how a product, a page, an offer, a subscription and an email
 * are made. The design is docs/studio-demo.md.
 *
 * Nothing here is reachable: no route, no page and no write uses it yet, and
 * STUDIO_DEMO_ON stays false until the session door, the sandbox store, the
 * studio guard and the screens are built, every cost below is known and the
 * whole is reviewed. Pure and browser-safe: no environment, no network, no
 * database; the only import is the table of supplier rates.
 *
 * What it holds:
 *   - the caps, every one checked before anything is spent: a demo session's
 *     life, actions and bytes, and the whole site's demo sessions and database
 *     commands in a day;
 *   - the closed list of what a demo session may never reach (email, AI,
 *     payments, uploads, webhooks, API keys, team, export, publish, domains,
 *     import), as a typed union so a new capability has to be classified;
 *   - the fixed example AI answers, each labelled as an example;
 *   - the one shape of a demo key: its own namespace, one session, one family
 *     from a short allow-list, and nothing else.
 */
import {
  UPSTASH_MICRO_USD_PER_GB_MONTH, UPSTASH_MICRO_USD_PER_GB_TRANSFER, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS,
  VERCEL_CALL_MICRO_USD_PER_MILLION, VERCEL_CPU_MICRO_USD_PER_HOUR, VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR,
} from "@/lib/spend-cost-table";

/** The switch. False until every unit of 256 [KJ1] is built and reviewed and no cost below is unknown. */
export const STUDIO_DEMO_ON: boolean = false;

// ---------------------------------------------------------------- the caps

/** How long a demo session lives, from the moment it opens; never extended. Every key it wrote expires at that moment. */
export const DEMO_SESSION_SECONDS = 30 * 60;
/** Requests one demo session may make, pages drawn and saves alike. */
export const DEMO_ACTIONS_PER_SESSION = 60;
/** Bytes one demo session may write in all, across its drafts. */
export const DEMO_BYTES_PER_SESSION = 256 * 1024;
/** Bytes one action may write: a draft at the most. */
export const DEMO_ACTION_MAX_BYTES = 32 * 1024;
/** Database commands one action may send at the most, its counting included. */
export const DEMO_COMMANDS_PER_ACTION = 12;
/**
 * Database commands opening a session sends, as billed (scripts' inner commands
 * one by one): the address limit (2), the day's counting script (6) and the
 * script that writes the session's record and first drafts (9). Held against
 * what the door really sends in tests/studio-demo.test.ts.
 */
export const DEMO_START_COMMANDS = 17;
/** Bytes opening a session moves through the database at the most, both ways (held in tests/studio-demo.test.ts). */
export const DEMO_START_DB_BYTES = 4_096;
/** Bytes an action's own check and count move through the database at the most, both ways (held in tests/studio-demo.test.ts). */
export const DEMO_TAKE_DB_BYTES = 2_048;
/** What one answer of the demo may send to the browser, as it travels; the screens' unit holds its pages under it. */
export const DEMO_RESPONSE_MAX_BYTES = 120_000;
/** Demo sessions the whole site opens in a day (UTC). */
export const DEMO_SESSIONS_PER_DAY = 500;
/** Database commands all demo sessions together may send in a day (UTC). */
export const DEMO_COMMANDS_PER_DAY = 250_000;
/** Demo sessions one address may open in a day, through the existing per-address limit (lib/request-guard.ts, withinLimit). */
export const DEMO_SESSIONS_PER_ADDRESS_PER_DAY = 5;

/** The most a session can send, start included. */
export const DEMO_SESSION_WORST_COMMANDS = DEMO_START_COMMANDS + DEMO_ACTIONS_PER_SESSION * DEMO_COMMANDS_PER_ACTION;

// ---------------------------------------------------------------- the session

/** A demo session's id: "sd" and 32 hex digits. Never the shape of a store id (lib/store.ts, 32 hex digits only). */
export const DEMO_SESSION_ID_PATTERN = /^sd[0-9a-f]{32}$/;
/** The demo's cookie: never the sign-in cookie (nl_session) nor the store switcher's (nl_store). */
export const DEMO_COOKIE = "nl_studio_demo";
/** Where every demo key lives, and nothing else does. */
export const DEMO_NAMESPACE = "nl:sdemo:";

export function isDemoSessionId(id: unknown): id is string {
  return typeof id === "string" && DEMO_SESSION_ID_PATTERN.test(id);
}

/** The families of keys a demo session may write: its record, its drafts and the steps it finished. */
export const DEMO_KEY_FAMILIES = ["session", "product", "page", "offer", "subscription", "email", "steps"];
export type DemoKeyFamily = (typeof DEMO_KEY_FAMILIES)[number];
const KEY_PART = /^[a-z0-9-]{1,40}$/;

/**
 * The only way a demo key is made: `nl:sdemo:{<session>}:<family>[:<part>]`.
 * The braces keep one session's keys together on one shard. Null for a
 * session id that is not a demo one, a family outside the allow-list, or a
 * part that is not a short plain name (a colon, a brace, a space or another
 * namespace never gets through).
 */
export function sandboxKey(sessionId: string, key: string): string | null {
  if (!isDemoSessionId(sessionId) || typeof key !== "string") return null;
  const [family, part, ...rest] = key.split(":");
  if (rest.length || !(DEMO_KEY_FAMILIES as readonly string[]).includes(family)) return null;
  if (part !== undefined && !KEY_PART.test(part)) return null;
  return `${DEMO_NAMESPACE}{${sessionId}}:${family}${part === undefined ? "" : `:${part}`}`;
}

/** The day's counts of every demo session together: sessions opened, commands sent and the conversion counts. */
export function demoDayKey(day: string): string | null {
  return DAY.test(day) ? `${DEMO_NAMESPACE}day:${day}` : null;
}
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// ---------------------------------------------------------------- the checks

export type DemoRefusal = "off" | "unknown" | "sessions" | "commands" | "expired" | "actions" | "bytes" | "too_big";
export type DemoVerdict = { ok: true } | { ok: false; reason: DemoRefusal };

const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const no = (reason: DemoRefusal): DemoVerdict => ({ ok: false, reason });

/**
 * Whether one more demo session may open today. It opens only while the day
 * has a session left and room for the whole of its worst commands, so a
 * session that opens is never cut short by the day's commands for want of
 * room the opening already saw. A count that is not known refuses.
 */
export function demoSessionAllowed(
  input: { today: string; sessionsToday: number; commandsToday: number },
  on: boolean = STUDIO_DEMO_ON,
): DemoVerdict {
  if (!on) return no("off");
  if (!DAY.test(input.today) || !count(input.sessionsToday) || !count(input.commandsToday)) return no("unknown");
  if (input.sessionsToday >= DEMO_SESSIONS_PER_DAY) return no("sessions");
  if (input.commandsToday + DEMO_SESSION_WORST_COMMANDS > DEMO_COMMANDS_PER_DAY) return no("commands");
  return { ok: true };
}

/**
 * Whether one more action of a session may run, before anything is written.
 * `actions` and `bytes` are what the session has used, `startedAt` and `now`
 * are milliseconds, `commandsToday` is the whole day's so far, and `cost` is
 * what this action will take at the most. An action dearer than the worst
 * the costs were worked out for is refused, never let through.
 */
export function demoActionAllowed(
  session: { actions: number; bytes: number; startedAt: number; now: number; commandsToday: number },
  cost: { commands: number; bytes: number },
  on: boolean = STUDIO_DEMO_ON,
): DemoVerdict {
  if (!on) return no("off");
  const { actions, bytes, startedAt, now, commandsToday } = session;
  if (![actions, bytes, startedAt, now, commandsToday, cost.commands, cost.bytes].every(count) || now < startedAt) return no("unknown");
  if (now >= startedAt + DEMO_SESSION_SECONDS * 1000) return no("expired");
  if (cost.commands > DEMO_COMMANDS_PER_ACTION || cost.bytes > DEMO_ACTION_MAX_BYTES) return no("too_big");
  if (actions >= DEMO_ACTIONS_PER_SESSION) return no("actions");
  if (bytes + cost.bytes > DEMO_BYTES_PER_SESSION) return no("bytes");
  if (commandsToday + cost.commands > DEMO_COMMANDS_PER_DAY) return no("commands");
  return { ok: true };
}

// ---------------------------------------------------------------- what a demo may reach

/**
 * Every capability a studio screen may ask for, each classified once. A new
 * capability added to the union without a line here does not compile, and a
 * name that is not on the list at run time is refused.
 */
export type DemoCapability =
  | "email" | "ai" | "payments" | "uploads" | "webhooks" | "apiKeys" | "team" | "export" | "publish" | "domains" | "import"
  | "draftProduct" | "draftPage" | "draftOffer" | "draftSubscription" | "draftEmail" | "aiExample" | "preview";

export const DEMO_CAPABILITIES: Record<DemoCapability, "forbidden" | "sandbox"> = {
  email: "forbidden",
  ai: "forbidden",
  payments: "forbidden",
  uploads: "forbidden",
  webhooks: "forbidden",
  apiKeys: "forbidden",
  team: "forbidden",
  export: "forbidden",
  publish: "forbidden",
  domains: "forbidden",
  import: "forbidden",
  draftProduct: "sandbox",
  draftPage: "sandbox",
  draftOffer: "sandbox",
  draftSubscription: "sandbox",
  draftEmail: "sandbox",
  aiExample: "sandbox",
  preview: "sandbox",
};

/** Whether the demo refuses a capability: everything on the closed list, and anything not classified. */
export function demoForbids(capability: DemoCapability | string): boolean {
  return !Object.hasOwn(DEMO_CAPABILITIES, capability) || DEMO_CAPABILITIES[capability as DemoCapability] !== "sandbox";
}

// ---------------------------------------------------------------- what the screens say

/** Drawn above every example answer by the page, never by a model. */
export const DEMO_AI_LABEL = "Example answer — the demo does not call the AI";

export type DemoAiExampleKind = "productDescription" | "pageHeadline" | "offerLine" | "emailSubject" | "emailBody";

/** Fixed answers about the fictional demo store's own products (lib/demo-seed.ts). No figure, deal, urgency or testimonial. */
export const DEMO_AI_EXAMPLES: Record<DemoAiExampleKind, string> = {
  productDescription:
    "A plan for cooking on the weekend, so that dinners on weekdays take less work. It lists what to buy, what to cook first, and how to keep each dish in the fridge.",
  pageHeadline: "Cook on the weekend, eat well all week",
  offerLine: "Add the Grocery List Pack to your order, to take a printed list to the store.",
  emailSubject: "Your Weekly Meal Planner is ready",
  emailBody:
    "Thanks for buying from Harbor Kitchen. Your planner is waiting in your library. Print the first week and put it on the fridge.",
};

export function demoAiExample(kind: DemoAiExampleKind): { label: string; text: string } {
  return { label: DEMO_AI_LABEL, text: DEMO_AI_EXAMPLES[kind] };
}

/** What a turned-off button says when it is pressed. */
export const DEMO_OFF_WORDS = {
  send: "Sending is off in the demo, so no email leaves. In your own studio, this button sends the email to your list.",
  publish: "Publishing is off in the demo, so nobody else sees this. In your own studio, this button puts it on your store.",
} as const;

/** The end of the demo: one button to sign up. `from=demo` is only counted, as a number, when an account is made. */
export const DEMO_SIGN_UP = { words: "Start your own store", href: "/signin?from=demo" } as const;

/** The conversion counts, one number each a day, nothing about who. */
export const DEMO_COUNTS = ["opened", "product", "page", "offer", "subscription", "email", "finished", "signUpClicked", "signedUp"];
export type DemoCount = (typeof DEMO_COUNTS)[number];

// ---------------------------------------------------------------- what it costs

/**
 * What the code can bound of a day's worst, in micro-USD, from the table of
 * supplier rates: a function call held at 2 GB, CPU, database commands and
 * the bytes they move, and what a session keeps for its life. The CDN's own
 * request and the bytes a function sends it are priced in tests/traffic-cost.ts
 * and added by tests/studio-demo-rules.test.ts. What no rate covers yet is in
 * DEMO_UNKNOWN_COSTS, and while it is not empty the demo stays off.
 */
const ACTION_SECONDS = 1.5;
const START_SECONDS = 4;
const CPU_SECONDS = 0.2;
const MONTH_SECONDS = 30 * 86_400;

function functionMicroUsd(seconds: number, commands: number, dbBytes: number): number {
  return VERCEL_CALL_MICRO_USD_PER_MILLION / 1e6
    + (VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR * VERCEL_FUNCTION_GB * seconds) / 3600
    + (VERCEL_CPU_MICRO_USD_PER_HOUR * CPU_SECONDS) / 3600
    + (UPSTASH_MICRO_USD_PER_MILLION_COMMANDS * commands) / 1e6
    + (UPSTASH_MICRO_USD_PER_GB_TRANSFER * dbBytes) / 1e9;
}

/** One action at its worst: 1.5 s at 2 GB, 0.2 CPU-second, its commands, a draft read and written, and its own check and count. */
export const DEMO_ACTION_FUNCTION_MICRO_USD = functionMicroUsd(ACTION_SECONDS, DEMO_COMMANDS_PER_ACTION, 2 * DEMO_ACTION_MAX_BYTES + DEMO_TAKE_DB_BYTES);
/** Opening a session at its worst: the bot check waited on up to 2.5 s, then the session written. */
export const DEMO_START_FUNCTION_MICRO_USD = functionMicroUsd(START_SECONDS, DEMO_START_COMMANDS, DEMO_START_DB_BYTES);
/** A session's bytes kept for its whole life. */
export const DEMO_SESSION_KEPT_MICRO_USD = (UPSTASH_MICRO_USD_PER_GB_MONTH * DEMO_BYTES_PER_SESSION * DEMO_SESSION_SECONDS) / (1e9 * MONTH_SECONDS);

/** The most actions a day can hold: every session opened, and the commands left after their openings. */
export function demoDayWorstActions(): number {
  const byCommands = Math.floor((DEMO_COMMANDS_PER_DAY - DEMO_SESSIONS_PER_DAY * DEMO_START_COMMANDS) / DEMO_COMMANDS_PER_ACTION);
  return Math.min(DEMO_SESSIONS_PER_DAY * DEMO_ACTIONS_PER_SESSION, byCommands);
}

/** A day's worst of what the rates above price, in micro-USD (the CDN's part is added by the test). */
export function demoDayFunctionWorstMicroUsd(): number {
  return DEMO_SESSIONS_PER_DAY * (DEMO_START_FUNCTION_MICRO_USD + DEMO_SESSION_KEPT_MICRO_USD)
    + demoDayWorstActions() * DEMO_ACTION_FUNCTION_MICRO_USD;
}

/**
 * Costs with no price or no measurement in the repository yet. Each keeps
 * the demo off; none is counted as zero.
 */
export const DEMO_UNKNOWN_COSTS: readonly string[] = [
  "The script and style files a demo studio page loads from the CDN: not measured for the studio (tests/traffic-cost.ts measured 13 on a store's page).",
  "The bot check at its basic level: lib/bot-check.ts records no charge per check, without a dated official source in the repository.",
  "Requests refused after a cap: each is still a function call and a read, bounded per address by the existing limit but not by the demo's own caps.",
];
