/**
 * Which studio alert emails a creator gets, event by event (queue item 601
 * [KB22], unit U6; added 6 November 2026). Browser-safe: the studio's panel
 * (components/notify-prefs-panel.tsx), the store record (lib/store.ts,
 * alertEmailsOff) and the alert jobs read the same catalog.
 *
 * Optional: the alerts about a store's numbers (lib/store-alerts.ts, each
 * kind) and the email when sales stop (lib/quiet-sales.ts). Each is on until
 * the creator switches it off, so a store that never opens the page gets
 * exactly what it got before. Switching one off stops its email only: the
 * phone (lib/phone-alerts.ts, each device's own choices) and the team's chat
 * (chatSales) keep their own settings. The stop link at the foot of the
 * weekly email still stops all of these at once, as it always did.
 *
 * Where the choice is kept, and why there: in the store record itself, which
 * every alert job already holds before it decides anything. So the choice a
 * job follows is always the creator's last saved one, read with the store,
 * and there is no second reading that could come back unknown and force a
 * guess between sending against an "off" and losing an alert. No job can
 * run without the store record, so none decides without the choice. A list
 * in the record that names an event this code no longer has keeps the rest
 * (keptOff); one that is not a list at all reads as nothing switched off.
 *
 * Always on, shown as such with the reason: what keeps the account safe, what
 * says buyers cannot pay or the plan cannot be paid, what comes before a
 * charge or a closing, and the notices the law asks to be given. Their code
 * never reads the choice (tests/notify-prefs.test.ts checks each file), so
 * nothing about it can hold one back.
 *
 * Left out of this unit, for a later one: the weekly and monthly emails and
 * the busy-day email are sent from lib/stats-report.ts and its cron routes
 * (another agent's file, and an open pull request on the routes); they stay
 * under the weekly email's own stop link. Emails a buyer or a teammate starts
 * (a message, a booking, an assignment, a signed agreement) are not alerts
 * about the store and come as before.
 */

export const OPTIONAL_EVENTS = ["traffic", "conversion", "refunds", "goal-pace", "goal-reached", "quiet-sales"] as const;
export type OptionalEvent = (typeof OPTIONAL_EVENTS)[number];

export type OptionalRow = { id: OptionalEvent; title: string; text: string };
export type AlwaysOnRow = { id: string; title: string; text: string; reason: string; sources: readonly string[] };

export const OPTIONAL_ROWS: readonly OptionalRow[] = [
  { id: "traffic", title: "Visits fell", text: "Your store had far fewer visitors in the last 3 days than usual. At most once a week." },
  { id: "conversion", title: "Fewer sales from the same visits", text: "Visits held up, but the last 7 days sold far less than usual. At most once a week." },
  { id: "refunds", title: "Refunds piling up", text: "At least 3 refunds in 7 days, and far more than usual. At most once a week." },
  { id: "goal-pace", title: "Monthly goal off pace", text: "From the 10th, when your month is on pace to end under 85% of your goal. At most once a month." },
  { id: "goal-reached", title: "Monthly goal reached", text: "The day your sales reach your goal for the month. At most once a month." },
  { id: "quiet-sales", title: "Sales stopped", text: "Your store has gone much longer than usual without a sale. Once for each quiet stretch." },
];

export const ALWAYS_ON_ROWS: readonly AlwaysOnRow[] = [
  {
    id: "account",
    title: "Changes to your account",
    text: "A change to where your sales are paid, your currency, your domain, your team or where buyers' details are sent, and API keys paused for safety.",
    reason: "This is how you find out if somebody else changed where your money or your buyers go.",
    sources: ["lib/account-notice.ts", "lib/api-key-pause.ts"],
  },
  {
    id: "payments",
    title: "Payment problems",
    text: "Stripe would not open a checkout, or your plan's payment failed.",
    reason: "Until it is fixed, buyers cannot pay you, or your plan cannot be paid.",
    sources: ["lib/checkout-trouble.ts", "lib/billing-reminders.ts"],
  },
  {
    id: "plan",
    title: "Your plan and your store",
    text: "Before your trial ends or your plan renews, and before your store closes.",
    reason: "We tell you before we charge you and before your store or its files change.",
    sources: ["lib/billing-reminders.ts", "lib/plan-closing.ts"],
  },
  {
    id: "legal",
    title: "Notices about your content",
    text: "Content taken down from your store after a notice, and when it is back on.",
    reason: "Copyright law and the EU's Digital Services Act ask that you be told, with the reason.",
    sources: ["lib/takedown.ts"],
  },
];

const KNOWN: ReadonlySet<string> = new Set(OPTIONAL_EVENTS);

export function isOptionalEvent(value: unknown): value is OptionalEvent {
  return typeof value === "string" && KNOWN.has(value);
}

/** Whether `value` names an always-on notice, so the route can say why it cannot be switched off. */
export function isAlwaysOn(value: unknown): boolean {
  return typeof value === "string" && ALWAYS_ON_ROWS.some((row) => row.id === value);
}

/**
 * The events switched off, read exactly: a plain list of distinct optional
 * events, put in the catalog's order. Anything else (an object, a number, an
 * always-on or unknown event, a repeat, a list longer than the catalog) is
 * not a list this code wrote, so it is null, never "nothing off".
 */
export function parseOff(value: unknown): OptionalEvent[] | null {
  if (!Array.isArray(value) || value.length > OPTIONAL_EVENTS.length) return null;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isOptionalEvent(item) || seen.has(item)) return null;
    seen.add(item);
  }
  return OPTIONAL_EVENTS.filter((event) => seen.has(event));
}

/**
 * The events switched off as the store record keeps them: the known ones,
 * once each, in the catalog's order. Lenient where parseOff is strict, because
 * this reads what the store already saved: an event retired since is dropped
 * and the rest of the creator's choice kept; anything not a list is nothing off.
 */
export function keptOff(value: unknown): OptionalEvent[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set(value.filter(isOptionalEvent));
  return OPTIONAL_EVENTS.filter((event) => seen.has(event));
}

/** Whether a store's owner wants `event` by email, from the store record's list. */
export function wantsAlertEmail(off: readonly string[] | undefined, event: OptionalEvent): boolean {
  return !(off ?? []).includes(event);
}

/** The studio page where the choices are made, for a store's own id. */
export function notifyPrefsPath(sid: string | null | undefined): string {
  return sid ? `/studio/notifications?store=${sid}` : "/studio/notifications";
}
