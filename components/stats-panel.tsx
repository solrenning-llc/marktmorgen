"use client";

import { useEffect, useRef, useState } from "react";

import type { AllTimeSales, Ranked, RangeKey, StatsData, Today } from "@/lib/stats";
import { StoreField } from "@/components/studio-store-pin";
import { dashboardPaidComplete, dashboardProducts } from "@/lib/dashboard-coverage";
import { ledgerPaymentsComplete } from "@/lib/payment-ledger-coverage";
import { paidFiguresComplete } from "@/lib/paid-coverage";
import { formatMoney } from "@/lib/money";
import { channelName, sourceName } from "@/lib/channel-names";
import type { StatsNote } from "@/lib/stats-notes";
import { type AdSpend, SPEND_FIGURES_UNREAD, type SpendUnread, paybackOf, spendBy } from "@/lib/ad-spend-rules";
import { channelCashflows, cashflowStatus } from "@/lib/channel-cashflow";
import { creativeResultsReport } from "@/lib/channel-reports";
import { ReportDownload } from "@/components/report-download";
import { CampaignResultsPanel } from "@/components/campaign-results";
import { PromotionPlanner } from "@/components/promotion-planner";
import { PaymentComparisonPanel } from "@/components/payment-comparison";
import { PaymentMixPanel } from "@/components/payment-mix";
import { DailyCashflowPanel } from "@/components/daily-cashflow";
import { RefundActivityPanel } from "@/components/refund-activity";
import { KeptByCurrency } from "@/components/kept-by-currency";
import { TaxCollected } from "@/components/tax-collected";
import { WeeklyCohortsPanel } from "@/components/weekly-cohorts";
import { RevenueQuality, BuyerChannelsPanel } from "@/components/revenue-quality";
import { READ_MIN_VISITORS, READ_SAMPLE } from "@/lib/page-read-sample";
import { NumbersNotes } from "@/components/numbers-notes";
import { AdSpendEditor } from "@/components/ad-spend-editor";
import type { MetaAdsView } from "@/lib/meta-ads";
import { HEARD_NAMES, isHeardAnswer } from "@/lib/heard-rules";
import { toast } from "@/components/toast";
import { type InsightContext, insightsFrom } from "@/lib/insights";
import { WeeklyTeamPicker } from "@/components/weekly-team-picker";
import { SalesGoalCard } from "@/components/sales-goal-card";
import { ChatSummaryEditor } from "@/components/chat-summary-editor";
import { goalMoneyByDay } from "@/lib/sales-goal-rules";
import type { ChatKind } from "@/lib/chat-summary";
import { NoCountToggle } from "@/components/no-count-toggle";
import { BuyerNumbers } from "@/components/buyer-numbers";
import { DiscountImpact } from "@/components/discount-impact";
import { BuyingHours } from "@/components/buying-hours";
import { CustomRange } from "@/components/custom-range";
import { NumbersAsk } from "@/components/numbers-ask";
import { CustomerVoice } from "@/components/customer-voice";
import { BesideStores } from "@/components/beside-stores";
import type { Band, Comparison } from "@/lib/benchmark-rules";
import type { VoiceSummary } from "@/lib/customer-voice";
import type { AutoMark, MarkKind } from "@/lib/auto-marks";
import { useStudioStore } from "@/components/studio-store-pin";
import { WeeklyAiToggle } from "@/components/weekly-ai-toggle";
import { AttributionTable } from "@/components/attribution-table";
import { footnoteWords, LIVE_TIMEOUT_MS, headlineWords, newLiveBox, readingAnswered, readingFailed, startReading, todayFailedWords, type LiveBox } from "@/lib/live-box-rules";
import { LocalClock, UtcAndLocal } from "@/components/local-clock";

/**
 * The store's funnel for the range: people, then the ones who started a
 * checkout, then the ones who paid — with how many went on at each step,
 * which is the number a creator can change (a clearer page, a better price).
 * Only counts the store already keeps; nothing new is recorded for it.
 */
function Funnel({
  visitors,
  checkouts,
  sales,
  salesHere,
  before = null,
  span = "",
}: {
  visitors: number;
  checkouts: number;
  sales: number;
  salesHere: boolean;
  /** The same stretch just before (added 11 October 2026, as Plausible compares funnels over time): each step's rate then, beside its rate now. */
  before?: { visitors: number; checkouts: number; sales: number | null } | null;
  span?: string;
}) {
  // A step's rate in the stretch before, and whether it went up or down; nothing where there was nothing to divide.
  const then = (part: number | null | undefined, whole: number, now: number) => {
    if (!before || part === null || part === undefined || !whole) return null;
    const was = part / whole;
    const tone = Math.abs(now - was) < 0.0005 ? "flat" : now > was ? "up" : "down";
    // "↓ from 67%" reads as where it came from; a bare "↓ 67%" read as a fall of 67 percent.
    return { text: tone === "flat" ? `same as the ${span} before` : `from ${rate(part, whole)} in the ${span} before`, tone };
  };
  const steps = [
    { label: "Visitors", value: visitors, note: "", then: null },
    {
      label: "Started a checkout",
      value: checkouts,
      note: rate(checkouts, visitors) + " of visitors",
      then: visitors ? then(before?.checkouts, before?.visitors ?? 0, checkouts / visitors) : null,
    },
    ...(salesHere
      ? [{ label: "Paid", value: sales, note: rate(sales, checkouts) + " of checkouts", then: checkouts ? then(before?.sales, before?.checkouts ?? 0, sales / checkouts) : null }]
      : []),
  ];
  const top = Math.max(1, visitors);
  return (
    <div className="mt-6" role="group" aria-labelledby="numbers-funnel">
      <p id="numbers-funnel" className="text-sm font-bold text-ink">
        From visit to sale
      </p>
      <ol className="mt-3 space-y-2">
        {steps.map((step) => (
          <li key={step.label} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-semibold text-ink">{step.label}</span>
              <span className="shrink-0 tabular-nums text-ink-soft">
                {count(step.value)}
                {step.note ? ` · ${step.note}` : ""}
              </span>
            </div>
            {step.then ? (
              <p className={`text-right text-xs tabular-nums ${step.then.tone === "up" ? "text-mint-deep" : step.then.tone === "down" ? "text-danger" : "text-ink-soft"}`}>
                {step.then.tone === "up" ? "↑ " : step.then.tone === "down" ? "↓ " : ""}
                {step.then.text}
              </p>
            ) : null}
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-paper ring-1 ring-line" aria-hidden="true">
              <div className="h-full rounded-full bg-violet-brand/70" style={{ width: `${Math.max(1, Math.min(100, (step.value / top) * 100))}%` }} />
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-ink-soft">
        A visitor is counted once a day, so somebody who comes back on another day and pays is one more visitor too. A free
        product&apos;s checkouts are the addresses asked for, and are never paid.
      </p>
    </div>
  );
}

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "d7", label: "7 days" },
  { key: "d30", label: "30 days" },
  { key: "d90", label: "90 days" },
  { key: "all", label: "All time" },
];


const count = (n: number) => n.toLocaleString("en-US");

/**
 * How a figure moved against the same stretch just before: "↑ 23%", "↓ 8%",
 * or nothing to say. A stretch with none of it before says so rather than
 * claiming an infinite rise.
 */
function change(now: number, before: number | null | undefined, span: string): { text: string; tone: "up" | "down" | "flat" } | null {
  if (before === null || before === undefined) return null;
  if (before === 0) return now > 0 ? { text: `None in the ${span} before`, tone: "flat" } : null;
  const value = ((now - before) / before) * 100;
  if (Math.abs(value) < 0.5) return { text: `Same as the ${span} before`, tone: "flat" };
  const shown = Math.abs(value) < 10 ? Math.abs(value).toFixed(1) : String(Math.round(Math.abs(value)));
  return { text: `${value > 0 ? "↑" : "↓"} ${shown}% on the ${span} before`, tone: value > 0 ? "up" : "down" };
}

function rate(part: number, whole: number): string {
  if (!whole) return "—";
  const value = (part / whole) * 100;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

function shortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const COUNTRY = typeof Intl !== "undefined" && "DisplayNames" in Intl ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
function countryName(code: string): string {
  try {
    return COUNTRY?.of(code) ?? code;
  } catch {
    return code;
  }
}
const DEVICE_NAMES: Record<string, string> = { mobile: "Phone", tablet: "Tablet", desktop: "Computer" };

/** One list of where visits came from, with a bar each. */
function Breakdown({
  title,
  rows,
  named = false,
  label,
}: {
  title: string;
  rows: Ranked;
  named?: boolean;
  /** How a row's name is shown, when it is a code (a country, a device). */
  label?: (name: string) => string;
}) {
  const total = rows.reduce((sum, s) => sum + s.visits, 0) || 1;
  return (
    <div className="min-w-0">
      <p className="text-sm font-bold text-ink">{title}</p>
      <ul className="mt-3 space-y-2">
        {rows.slice(0, 8).map((row) => {
          const share = Math.round((row.visits / total) * 100);
          return (
            <li key={row.name} className="text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-semibold text-ink">{label ? label(row.name) : named ? sourceName(row.name) ?? row.name : row.name}</span>
                <span className="shrink-0 tabular-nums text-ink-soft">{`${count(row.visits)} · ${share}%`}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-paper ring-1 ring-line" aria-hidden="true">
                <div className="h-full rounded-full bg-violet-brand/70" style={{ width: `${Math.max(2, share)}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * What buyers answered when asked, after paying, where they heard of the
 * store (lib/heard.ts): the channels no link can see — a friend, a message, a
 * podcast. With the switch for the question itself.
 */
function HeardTable({
  rows,
  money,
  ask,
  canSet,
}: {
  rows: { answer: string; buyers: number; cents: number }[];
  money: (cents: number) => string;
  ask: boolean;
  canSet: boolean;
}) {
  const [asking, setAsking] = useState(ask);
  const [busy, setBusy] = useState(false);
  const total = rows.reduce((n, r) => n + r.buyers, 0);
  async function toggle() {
    setBusy(true);
    try {
      const response = await fetch("/api/store/heard-ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ask: !asking }) });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; ask?: boolean };
      if (body.ok && typeof body.ask === "boolean") {
        setAsking(body.ask);
        toast(body.ask ? "Buyers are asked again." : "Buyers are no longer asked.");
      } else toast("That did not save. Try again.");
    } catch {
      toast("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-6">
      <p className="text-sm font-bold text-ink">Where buyers say they heard of you</p>
      {rows.length ? (
        <ul className="mt-2 divide-y divide-line text-sm">
          {rows.map((row) => (
            <li key={row.answer} className="flex items-baseline justify-between gap-3 py-1.5">
              <span className="min-w-0 truncate text-ink">{isHeardAnswer(row.answer) ? HEARD_NAMES[row.answer] : row.answer}</span>
              <span className="shrink-0 tabular-nums text-ink-soft">
                {`${count(row.buyers)} ${row.buyers === 1 ? "buyer" : "buyers"} · ${Math.round((row.buyers / Math.max(1, total)) * 100)}%${row.cents ? ` · ${money(row.cents)}` : ""}`}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-ink-soft">{asking ? "No answers in these days yet." : "Buyers are not being asked."}</p>
      )}
      <p className="mt-2 text-xs text-ink-soft">
        {asking
          ? "After paying, buyers are asked this one question, which they can skip. It finds what no link can: a friend who told them, a message, a podcast. Only the answer and the sale's amount are kept, nothing about the buyer. "
          : "When it is on, buyers are asked this one question after paying, and can skip it. "}
        {canSet ? (
          <button type="button" className="font-semibold text-violet-deep underline underline-offset-4" disabled={busy} onClick={() => void toggle()}>
            {asking ? "Stop asking" : "Ask buyers"}
          </button>
        ) : null}
      </p>
    </div>
  );
}

type LiveNow = { visitors: number; sources: { source: string; visitors: number }[]; today: Today | null };

/**
 * Who is on the store right now: asked every half minute while the page is
 * open and in view, and not at all from a tab in the background. Each ask is
 * one of the store's studio requests (lib/store-allowance-rules.ts), so it
 * stops after LIVE_ASKS of them (lib/live-box-rules.ts), ten minutes, until the page is opened again. What it says about a
 * next reading comes from the same count of readings made that decides whether there is one.
 */
export function RightNow({ currency, initialBox, timeZone, now }: { currency: string; initialBox?: LiveBox<LiveNow>; timeZone?: string; now?: number }) {
  // initialBox and timeZone are for tests that draw the box in a given state; the studio passes neither.
  const [box, setBox] = useState<LiveBox<LiveNow>>(() => initialBox ?? newLiveBox<LiveNow>());
  // The machine in lib/live-box-rules.ts holds the count, the last good reading and what to say; the ref lets each
  // event see the newest state without waiting for a render.
  const boxRef = useRef(box);
  // The time of the last event, so what the box says about the age of its numbers is not read from the clock during a render.
  const [clock, setClock] = useState(0);
  const apply = (next: LiveBox<LiveNow>) => {
    boxRef.current = next;
    setBox(next);
    setClock(Date.now());
  };
  useEffect(() => {
    let stopped = false;
    const ask = async () => {
      const started = startReading(boxRef.current, document.visibilityState === "visible");
      if (!started) return;
      apply(started.box);
      // A reading that does not come back is a failed one, so the box can never be left waiting for it.
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
      try {
        const response = await fetch("/api/store/live", { cache: "no-store", signal: controller.signal });
        const body = (await response.json().catch(() => ({}))) as { ok?: boolean } & Partial<LiveNow>;
        if (stopped) return;
        if (body.ok) apply(readingAnswered(boxRef.current, started.seq, { visitors: body.visitors ?? 0, sources: body.sources ?? [], today: body.today ?? null }, Date.now()));
        else apply(readingFailed(boxRef.current, started.seq));
      } catch {
        // A missed reading is simply the next one's to make; until one comes, the box says so.
        if (!stopped) apply(readingFailed(boxRef.current, started.seq));
      } finally {
        window.clearTimeout(timeout);
      }
    };
    void ask();
    const timer = window.setInterval(() => void ask(), 30_000);
    const seen = () => void ask();
    document.addEventListener("visibilitychange", seen);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", seen);
    };
  }, []);
  const live = box.last?.data ?? null;
  const failed = box.failed;
  // Drawn from the first paint with the shape it keeps (inbox C4-28): the answer fills it in rather than pushing the
  // rest of the studio down under a finger or a pointer already on its way (WCAG 2.4.3, 3.2.5). Only the list of where
  // people came from, there when someone is on the store, adds lines.
  const today = live?.today ?? null;
  // Shown as an ellipsis, read as a word.
  const waiting = (
    <>
      <span aria-hidden="true">…</span>
      <span className="sr-only">Loading</span>
    </>
  );
  return (
    <div className="mt-6 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line">
      {/* Only this sentence is a live region: it is the one that changes, and it carries the time when the numbers are old. */}
      <p className="flex items-center gap-2 text-sm font-bold text-ink" aria-live="polite" aria-busy={live === null && !failed}>
        <span className={`inline-block h-2 w-2 rounded-full ${live?.visitors ? "bg-emerald-500" : "bg-line"}`} aria-hidden="true" />
        {headlineWords(box, timeZone, now ?? clock)}
      </p>
      {live && live.visitors > 0 && live.sources.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm">
          {live.sources.map((s) => (
            <li key={s.source} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-ink">{`From ${s.source === "direct" ? "a direct visit or an app that hides it" : sourceName(s.source) ?? s.source}`}</span>
              <span className="shrink-0 tabular-nums text-ink-soft">{count(s.visitors)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {/* One line either way, so the pause never adds one above the rest of the studio. */}
      <p className="mt-2 text-xs text-ink-soft">
        {footnoteWords(box, timeZone)}
      </p>
      <div className="mt-4 border-t border-line pt-3">
        <p className="text-sm font-bold text-ink">Today so far</p>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {[
            { label: "Visitors", value: today ? count(today.visitors) : live ? "—" : waiting },
            { label: "Checkouts started", value: today ? count(today.checkouts) : live ? "—" : waiting },
            { label: "Sales", value: today?.sales ? count(today.sales.sales) : live ? "—" : waiting },
            { label: "Revenue", value: today?.sales ? formatMoney(today.sales.cents, currency) : live ? "—" : waiting },
          ].map((tile) => (
            <div key={tile.label}>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-mute">{tile.label}</dt>
              <dd className="text-lg font-semibold tabular-nums text-ink">{tile.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-ink-soft">
          {today?.sources.length
            ? `Visits from ${today.sources.map((s) => `${channelName(s.source)} ${count(s.visits)}`).join(", ")}.`
            : today
              ? "No visits from a known source yet today."
              : live
                ? // Only a reading that failed leaves today out (app/api/store/live/route.ts): said as one, with when it
                  // is read again, never as numbers that do not exist (inbox C4-34).
                  todayFailedWords(box)
                : "Reading today's numbers."}
        </p>
        <p className="mt-1 text-xs text-ink-soft">The day in UTC, like every day here. Sales are paid ones, read from Stripe every two minutes.</p>
      </div>
    </div>
  );
}

/** The color of each kind of mark the store makes on its own (lib/auto-marks.ts); the creator's own notes are amber. */
const MARK_COLORS: Record<MarkKind, string> = { email: "bg-sky-brand", product: "bg-mint-deep", sale: "bg-coral" };

/** A store's visits, checkouts and sales, for the last week, month, quarter or all time. */
/** When a store's numbers were read, as the studio's page says it (app/studio/page.tsx). */
export type NumbersReading = {
  /** When the oldest of the numbers shown was read, in milliseconds; null when none was. */
  at: number | null;
  /** The day still has a reading to read them again. */
  canRefresh: boolean;
  /** The studio's page with the numbers read again. */
  refreshHref: string;
  /** When the day's readings come back: the next 00:00 UTC. */
  backAt: number;
  /** None of the sales kept and none may be read today. */
  salesUsed: boolean;
  /** The biggest buyers left out of the kept sales for lack of a list (components/buyer-numbers.tsx says when they come back). */
  buyersLater?: "on-their-own" | "after-change";
  /** The last try failed after calling Stripe, and was counted (inbox C4-53). */
  failed?: boolean;
  /** Readings of this kind left today. */
  left?: number;
};

/**
 * The time the numbers shown were read, on the creator's own clock, and either
 * a way to read them again or when they will be (inbox C4-33 (2), (3)). A kept
 * reading is shown as it is: never called incomplete, never "no numbers".
 */
export function ReadingLine({ reading }: { reading: NumbersReading }) {
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft" data-numbers-reading>
      {reading.at !== null ? (
        <span>
          Updated at <LocalClock ms={reading.at} />.
        </span>
      ) : null}
      {reading.failed ? (
        <span>{`The last reading failed and was counted; ${reading.left ?? 0} ${(reading.left ?? 0) === 1 ? "reading" : "readings"} left today.`}</span>
      ) : null}
      {reading.salesUsed ? <span>Your sales could not be read again today.</span> : null}
      {reading.canRefresh ? (
        <a href={reading.refreshHref} className="link inline-flex min-h-11 items-center font-semibold">
          Update now
        </a>
      ) : (
        <span>
          {"Today's readings are used. Your numbers update again at "}
          <UtcAndLocal ms={reading.backAt} />.
        </span>
      )}
    </p>
  );
}

export function StatsPanel({
  data,
  canExport = true,
  notes: notesGiven = [],
  spends: spendsGiven = [],
  spendsUnread: spendsUnreadGiven = null,
  askHeard = true,
  canSetHeard = false,
  canSetAttribution = false,
  weeklyTeam = null,
  goal = 0,
  chat,
  chatSales = false,
  deviceMarked = null,
  canAsk = false,
  weeklyAi,
  insightContext,
  voice,
  marks = [],
  meta = null,
  canConnectMeta = false,
  pin = "",
  beside = null,
  reading = null,
}: {
  data: StatsData;
  /** When the numbers shown were read, and whether they may be read again today (lib/store-readings.ts; inbox C4-33). */
  reading?: NumbersReading | null;
  canExport?: boolean;
  notes?: StatsNote[];
  spends?: AdSpend[];
  /** Which part of the spend could not be read (lib/ad-spend-rules.ts): every figure that uses ad spend is left out then. */
  spendsUnread?: SpendUnread;
  /** Whether buyers are asked where they heard of the store (lib/heard.ts). */
  askHeard?: boolean;
  /** Whether this person may switch that question on or off. */
  canSetHeard?: boolean;
  /** Whether this person may choose how long after a visit a sale is credited to it (lib/attribution-rules.ts). */
  canSetAttribution?: boolean;
  /** For whoever runs the team: members who see the numbers, and those who get the weekly email too. */
  weeklyTeam?: { members: string[]; chosen: string[] } | null;
  /** The month's goal (lib/sales-goal-rules.ts), 0 for none. */
  goal?: number;
  /** For whoever may change settings: the chat the numbers are posted to (lib/chat-summary.ts); undefined for anybody else. */
  chat?: ChatKind | null;
  /** Whether each sale and each alert is posted to that chat too (lib/sale-events.ts, lib/store-alerts.ts). */
  chatSales?: boolean;
  /** Whether this browser is marked not to be counted on the store (lib/no-count.ts); null to leave the switch out. */
  deviceMarked?: boolean | null;
  /** Whether "Ask your numbers" is offered (lib/numbers-ask.ts): writing help configured. */
  canAsk?: boolean;
  /** For whoever may change settings, with writing help configured: whether the weekly email opens with an AI summary; undefined for anybody else. */
  weeklyAi?: boolean;
  /** What "Worth knowing" needs to offer its steps (lib/insights.ts): the store's address, its reminders, what this person may do. */
  insightContext?: InsightContext;
  /** What customers are saying (lib/customer-voice.ts): the latest summary, null for none yet; undefined to leave it out. */
  voice?: VoiceSummary | null;
  /** Marks the store recorded on its own: emails sent, products added, sales (lib/auto-marks.ts). */
  marks?: AutoMark[];
  /** The store's Meta ad account (lib/meta-ads.ts); null when the deployment has no Meta app. */
  meta?: MetaAdsView | null;
  /** Whether this person may connect or disconnect it ("settings"). */
  canConnectMeta?: boolean;
  /** "?store=<id>", carried on the forms that post to the studio's routes. */
  pin?: string;
  /** The store's rates beside stores its size (lib/benchmark-rules.ts); null when there is nothing to set them beside. */
  beside?: { band: Band; rows: Comparison[] } | null;
}) {
  const [range, setRange] = useState<RangeKey>("d7");
  const [pickDates, setPickDates] = useState(false);
  const [notes, setNotes] = useState(notesGiven);
  const [spends, setSpends] = useState(spendsGiven);
  const [spendsUnread, setSpendsUnread] = useState<SpendUnread>(spendsUnreadGiven);
  // The spend the figures use: none while a part is unread, and those figures are left out (Claude 5 on #2924).
  const spendsKnown = spendsUnread ? null : spends;
  const [all, setAll] = useState<{ state: "idle" | "loading" | "error" } | { state: "ok"; sales: AllTimeSales }>({ state: "idle" });
  const salesKnown = data.sales === "ok";

  async function loadAll() {
    if (!salesKnown || all.state === "loading" || all.state === "ok") return;
    setAll({ state: "loading" });
    try {
      const response = await fetch("/api/store/stats?range=all", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; sales?: AllTimeSales };
      setAll(body.ok && body.sales ? { state: "ok", sales: body.sales } : { state: "error" });
    } catch {
      setAll({ state: "error" });
    }
  }

  function choose(key: RangeKey) {
    setRange(key);
    if (key === "all") loadAll();
  }

  // All-time sales arrive when asked for; until then they are shown as coming.
  const allSales = all.state === "ok" ? all.sales : null;
  const salesHere = dashboardPaidComplete(data, range, allSales);
  // Every amount here is in the store's currency (lib/stats.ts leaves sales in
  // any other out of the totals and counts them).
  const money = (cents: number) => formatMoney(cents, data.currency ?? "usd");
  const elsewhere = range === "all" ? allSales?.elsewhere ?? 0 : data.elsewhere ?? 0;
  const totals =
    range === "all" && allSales ? { ...data.totals.all, sales: allSales.totals.sales, cents: allSales.totals.cents } : data.totals[range];
  const days = range === "d7" ? data.days.slice(-7) : range === "d30" ? data.days.slice(-30) : data.days;
  const peak = Math.max(1, ...days.map((d) => d.visitors));
  const empty = data.totals.all.views === 0 && data.totals.d90.checkouts === 0 && data.totals.d90.sales === 0;
  const salesNote = !salesKnown
    ? data.sales === "none"
      ? "Once Stripe is connected"
      : "Stripe did not answer"
    : range === "all" && !allSales
      ? all.state === "error"
        ? "Stripe did not answer"
        : "Reading Stripe…"
      : !salesHere
        ? "Incomplete reading; paid totals unavailable"
        : "Paid, from your Stripe";

  // The same stretch just before the one chosen, to set each figure beside.
  const before = range === "all" ? null : data.previous?.[range] ?? null;
  const beforeTraffic = range === "all" || data.previousTrafficAvailable?.[range] === false ? null : before;
  const span = range === "d7" ? "7 days" : range === "d30" ? "30 days" : "90 days";
  const moved = (now: number, then: number | null | undefined) => (before ? change(now, then, span) : null);

  const tiles: { label: string; value: string; note?: string; moved?: ReturnType<typeof change> }[] = [
    { label: "Visitors", value: count(totals.visitors), note: "People, each counted once a day", moved: moved(totals.visitors, beforeTraffic?.visitors) },
    { label: "Page views", value: count(totals.views), note: "Every time your store was opened", moved: moved(totals.views, beforeTraffic?.views) },
    { label: "Checkouts started", value: count(totals.checkouts), note: "Pressed buy, book or get it free", moved: moved(totals.checkouts, beforeTraffic?.checkouts) },
    { label: "Sales", value: salesHere ? count(totals.sales) : "—", note: salesNote, moved: salesHere ? moved(totals.sales, before?.sales) : null },
    { label: "Revenue", value: salesHere ? money(totals.cents) : "—", note: "Before Stripe's fee", moved: salesHere ? moved(totals.cents, before?.cents) : null },
    // Memberships renewed and later plan payments: money the sales above leave out (lib/stats.ts).
    // Shown once there is any in the last 90 days, so a store without memberships sees no empty tile.
    ...(data.renewals && (data.renewals.d90.payments > 0 || data.renewals.partial)
      ? [
          range === "all"
            ? { label: "Renewals", value: "—", note: "Shown for up to 90 days; all of them are in your Stripe" }
            : {
                label: "Renewals",
                value: data.renewals.partial ? "—" : money(data.renewals[range].cents),
                note: data.renewals.partial ? "Incomplete invoice reading; renewals unavailable" : `${count(data.renewals[range].payments)} ${data.renewals[range].payments === 1 ? "payment" : "payments"} after the first: memberships renewed and plan payments`,
              },
        ]
      : []),
    { label: "Conversion", value: salesHere ? rate(totals.sales, totals.visitors) : "—", note: "Sales for every 100 visitors" },
    {
      label: "Per visitor",
      value: salesHere && totals.visitors > 0 ? money(Math.round(totals.cents / totals.visitors)) : "—",
      note: "What the average visitor was worth",
    },
  ];

  const shownProducts = dashboardProducts(data, range, allSales);
  // Refunds have their own coverage and are only read for 90 days.
  const withProductRefunds = range === "d90" && data.cashflowComplete === true && Object.keys(data.refundsByProduct ?? {}).length > 0;
  const withRenewalColumn = data.revenueBySource.some((row) => row.renewals > 0);
  // Refunds over the 90 days, by the channel of the sale given back (lib/stats.ts, readRefunds).
  const refunds90 = new Map((data.refunds?.d90 ?? []).map((row) => [row.source || "direct", row]));
  const withRefundColumn = refunds90.size > 0;
  // Disputes the bank holds or the buyer won, by the channel of the sale disputed; only once every page was read.
  const disputes90 = new Map((data.disputesComplete ? data.disputes?.d90 ?? [] : []).map((row) => [row.source || "direct", row]));
  const withDisputeColumn = disputes90.size > 0;
  // The few things worth acting on, in words (lib/insights.ts).
  const insights = range === "all" ? [] : insightsFrom(data, range, spendsKnown ?? [], 4, insightContext);
  const sid = useStudioStore();
  // A studio screen for the store being looked at, when the person runs several.
  const studioHref = (href: string) => {
    if (!sid || !href.startsWith("/studio")) return href;
    const [path, hash = ""] = href.split("#");
    return `${path}${path.includes("?") ? "&" : "?"}store=${encodeURIComponent(sid)}${hash ? `#${hash}` : ""}`;
  };
  // Notes by day, for the marks under the chart.
  const notesOn = new Map<string, string[]>();
  for (const note of notes) notesOn.set(note.day, [...(notesOn.get(note.day) ?? []), note.text]);
  // And what the store recorded on its own, by day.
  const marksOn = new Map<string, AutoMark[]>();
  for (const mark of marks) marksOn.set(mark.day, [...(marksOn.get(mark.day) ?? []), mark]);
  // What was spent on ads inside the days shown (lib/ad-spend-rules.ts); none for "all".
  const spent = range === "all" || !days.length || !spendsKnown ? null : spendBy(spendsKnown, days[0].date, days[days.length - 1].date);
  const withSpend = Boolean(spent && spent.total > 0);
  const cashflows = range === "all" || !days.length ? [] : channelCashflows(data, range, data.channels?.[range] ?? [], spent?.channels ?? new Map(), days[0].date, days[days.length - 1].date);
  // Each channel for the range chosen; "all" has none, because sales are read for 90 days.
  // A channel money was spent on is shown even when it brought nobody: that is the row that most needs reading.
  const channelsCounted = range === "all" ? [] : data.channels?.[range] ?? [];
  const channels = [
    ...channelsCounted,
    ...[...(spent?.channels.keys() ?? [])]
      .filter((name) => !channelsCounted.some((row) => row.source === name))
      .map((source) => ({ source, visits: 0, checkouts: 0, free: 0, sales: 0, cents: 0 })),
  ];
  // The channels offered when adding what was spent: the ones the store already counts, then the usual ones.
  const spendChannels = [
    ...new Set([...(data.channels?.d90 ?? []).map((row) => row.source), "instagram", "tiktok", "youtube", "facebook", "pinterest", "x", "google", "newsletter", "podcast"]),
  ]
    .filter((name) => name !== "direct" && name !== "unrecorded")
    .map((value) => ({ value, label: channelName(value) }));
  // Which ad sold, and money by the buyer's country, for the window.
  const ads = range === "all" ? [] : data.ads?.[range] ?? [];
  const moneyCountries = range === "all" ? [] : data.salesCountries?.[range] ?? [];
  // What buyers said when asked where they heard of the store.
  const heard = range === "all" ? [] : data.heard?.[range] ?? [];
  // The store page item by item, once enough visits were measured to say anything.
  const reach = range === "all" ? null : data.reach?.[range] ?? null;
  const withFreeColumn = channels.some((row) => row.free > 0);
  // Page views by country and device, kept by the day: none for "all".
  const countries = data.countries?.[range] ?? [];
  const devices = data.devices?.[range] ?? [];
  // Each channel's money by the last visit, the first and what buyers said, for the window.
  const attribution = range === "all" ? null : data.attribution?.[range] ?? null;
  const sources = data.sources[range];
  const mediums = data.mediums[range];
  const campaigns = data.campaigns[range];

  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="numbers-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="numbers-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Your numbers
        </h2>
        <div className="inline-flex max-w-full flex-wrap rounded-full bg-paper p-1 ring-1 ring-line" role="group" aria-label="Period">
          {RANGES.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-pressed={range === key}
              onClick={() => choose(key)}
              className={`inline-flex min-h-11 items-center rounded-full px-3 py-1.5 text-sm font-semibold transition ${
                range === key ? "bg-white text-ink shadow-sm ring-1 ring-line" : "text-ink-soft hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={pickDates}
            onClick={() => setPickDates((open) => !open)}
            className={`inline-flex min-h-11 items-center rounded-full px-3 py-1.5 text-sm font-semibold transition ${
              pickDates ? "bg-white text-ink shadow-sm ring-1 ring-line" : "text-ink-soft hover:text-ink"
            }`}
          >
            Any dates
          </button>
        </div>
      </div>

      {reading ? <ReadingLine reading={reading} /> : null}

      {pickDates ? <CustomRange today={data.days[data.days.length - 1]?.date ?? new Date().toISOString().slice(0, 10)} currency={data.currency ?? "usd"} /> : null}

      {empty ? (
        <p className="mt-3 text-ink-soft">
          Nothing counted yet. Share your store&apos;s address and the first visits show up here within seconds.
        </p>
      ) : null}
      {range === "all" ? (
        <p className="mt-3 text-sm text-ink-soft">
          {`Visits since ${data.since ? longDate(data.since) : "the first one counted"}. `}
          {allSales && !allSales.partial
            ? allSales.since
              ? `Sales since ${longDate(allSales.since)}, the first one on your Stripe account.`
              : "No sales on your Stripe account yet."
            : null}
          {allSales?.partial ? " The all-time purchase reading is incomplete. Paid totals, rates and product rankings wait for complete figures." : ""}
        </p>
      ) : null}
      {salesHere && elsewhere > 0 ? (
        <p className="mt-3 text-sm text-ink-soft">
          {`${count(elsewhere)} ${elsewhere === 1 ? "sale was" : "sales were"} paid in another currency, from before your store charged in ${(data.currency ?? "usd").toUpperCase()}. ${elsewhere === 1 ? "It is" : "They are"} left out of these numbers, because amounts in two currencies do not add up, and ${elsewhere === 1 ? "it is" : "they are"} in the sales download with ${elsewhere === 1 ? "its" : "their"} own currency.`}
        </p>
      ) : null}
      {salesHere && range === "d90" && ((data.takenBackElsewhere?.refunds ?? 0) > 0 || (data.takenBackElsewhere?.disputes ?? 0) > 0) ? (() => {
        // 22 [E5], unit 2b: refunds and disputes in another currency were dropped without a word. Counted over the 90 days, so said there.
        const refunds = data.takenBackElsewhere?.refunds ?? 0;
        const disputes = data.takenBackElsewhere?.disputes ?? 0;
        const what = [refunds > 0 ? `${count(refunds)} ${refunds === 1 ? "refund" : "refunds"}` : "", disputes > 0 ? `${count(disputes)} ${disputes === 1 ? "dispute" : "disputes"}` : ""].filter(Boolean).join(" and ");
        const one = refunds + disputes === 1;
        return (
          <p className="mt-3 text-sm text-ink-soft">
            {`${what} in the last 90 days ${one ? "was" : "were"} in a currency other than ${(data.currency ?? "usd").toUpperCase()}. ${one ? "It is" : "They are"} left out of these numbers${elsewhere > 0 ? " too" : ""}, and ${one ? "it is" : "they are"} in your Stripe account in ${one ? "its" : "their"} own currency.`}
          </p>
        );
      })() : null}

      {range !== "all" && !beforeTraffic ? <p className="mt-3 text-sm text-ink-soft" role="status">Previous traffic figures are unavailable. Current visitors, page views and checkouts remain available.</p> : null}

      <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-[12px] bg-paper px-4 py-3 ring-1 ring-line">
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-mute">{tile.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums text-ink">{tile.value}</dd>
            {tile.moved ? (
              <dd
                className={`mt-0.5 text-xs font-semibold tabular-nums ${
                  tile.moved.tone === "up" ? "text-mint-deep" : tile.moved.tone === "down" ? "text-danger" : "text-ink-soft"
                }`}
              >
                {tile.moved.text}
              </dd>
            ) : null}
            {tile.note ? <dd className="mt-0.5 text-xs text-ink-soft">{tile.note}</dd> : null}
          </div>
        ))}
      </dl>

      {canAsk && !empty ? (
        <NumbersAsk
          onShow={(chosen, section) => {
            choose(chosen);
            // After the panel is drawn for that window: to the part that shows the figures.
            setTimeout(() => document.getElementById(`numbers-${section || "title"}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
          }}
        />
      ) : null}

      {salesKnown && data.days.length ? (
        <SalesGoalCard goal={goal} byDay={goalMoneyByDay(data)} today={data.days[data.days.length - 1].date} currency={data.currency ?? "usd"} />
      ) : null}

      {range !== "all" && insightContext?.promotionProducts?.length ? (
        <PromotionPlanner key={range} data={data} range={range} products={insightContext.promotionProducts} />
      ) : null}

      {range !== "all" && insights.length ? (
        <div className="mt-5 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line" role="region" aria-labelledby="numbers-insights">
          <p id="numbers-insights" className="text-sm font-bold text-ink">
            Worth knowing
          </p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {insights.map((item) => (
              <li key={item.text} className="flex gap-2">
                <span
                  aria-hidden="true"
                  className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${item.tone === "good" ? "bg-mint-deep" : item.tone === "bad" ? "bg-danger" : "bg-violet-brand"}`}
                />
                <span className="min-w-0">
                  <span className="text-ink">{item.text}</span>
                  {item.math ? <span className="mt-0.5 block text-xs text-ink-soft" data-insight-math>{item.math}</span> : null}
                  {item.action ? (
                    "href" in item.action ? (
                      <a
                        href={studioHref(item.action.href)}
                        {...(item.action.href.startsWith("/") ? {} : { target: "_blank", rel: "noopener" })}
                        className="inline-flex min-h-11 items-center text-sm font-semibold text-violet-deep underline underline-offset-4"
                        data-insight-action
                      >
                        {item.action.label}
                      </a>
                    ) : (
                      <button
                        type="button"
                        className="inline-flex min-h-11 items-center text-sm font-semibold text-violet-deep underline underline-offset-4"
                        data-insight-action
                        onClick={() => document.getElementById(`numbers-${(item.action as { section: string }).section}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                      >
                        {item.action.label}
                      </button>
                    )
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-soft">
            Read from the numbers below by fixed rules, only when they are big enough to mean something. Where money is at stake, the
            arithmetic beside it is made from those numbers alone: a sum, not a promise of what a change would bring.
          </p>
        </div>
      ) : null}

      {range !== "all" ? (
        <div className="mt-6">
          <p className="text-sm font-bold text-ink">Visitors a day</p>
          <div className={`mt-3 flex h-28 items-end ${days.length > 30 ? "gap-px" : "gap-[3px]"}`} aria-hidden="true">
            {days.map((day) => (
              <div
                key={day.date}
                className="flex h-full min-w-0 flex-1 flex-col justify-end"
                title={`${shortDate(day.date)}: ${day.visitors} visitors, ${day.sales} sales${[...(notesOn.get(day.date) ?? []), ...(marksOn.get(day.date) ?? []).map((m) => m.text)].map((t) => `\n${t}`).join("")}`}
              >
                <div
                  className="w-full rounded-t-[3px] bg-violet-brand/80"
                  style={{ height: `${Math.max(day.visitors ? 4 : 1, (day.visitors / peak) * 100)}%`, opacity: day.visitors ? 1 : 0.25 }}
                />
              </div>
            ))}
          </div>
          {/* Days with a note (components/numbers-notes.tsx): a mark under the day's bar, the words in the list below. */}
          {days.some((day) => notesOn.has(day.date) || marksOn.has(day.date)) ? (
            <div className={`mt-0.5 flex ${days.length > 30 ? "gap-px" : "gap-[3px]"}`} aria-hidden="true">
              {days.map((day) => {
                const kinds = [...new Set((marksOn.get(day.date) ?? []).map((m) => m.kind))];
                return (
                  <div
                    key={day.date}
                    className="flex min-w-0 flex-1 flex-col items-center gap-px"
                    title={[...(notesOn.get(day.date) ?? []), ...(marksOn.get(day.date) ?? []).map((m) => m.text)].join("\n")}
                  >
                    {notesOn.has(day.date) ? <span className="block h-1.5 w-1.5 rounded-full bg-amber-brand" /> : null}
                    {kinds.map((kind) => (
                      <span key={kind} className={`block h-1.5 w-1.5 rounded-full ${MARK_COLORS[kind]}`} />
                    ))}
                  </div>
                );
              })}
            </div>
          ) : null}
          <div className="mt-1 flex justify-between text-xs text-ink-mute" aria-hidden="true">
            <span>{shortDate(days[0].date)}</span>
            <span>{shortDate(days[days.length - 1].date)}</span>
          </div>
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer font-semibold text-ink-soft">See each day</summary>
            <div className="max-h-80 overflow-y-auto" tabIndex={0} role="region" aria-label="Each day">
              <table className="mt-2 w-full text-left text-sm">
                <thead>
                  <tr className="text-ink-mute">
                    <th scope="col" className="py-1 font-semibold">Day (UTC)</th>
                    <th scope="col" className="py-1 text-right font-semibold">Visitors</th>
                    <th scope="col" className="py-1 text-right font-semibold">Checkouts</th>
                    <th scope="col" className="py-1 text-right font-semibold">Sales</th>
                  </tr>
                </thead>
                <tbody>
                  {[...days].reverse().map((day) => (
                    <tr key={day.date} className="border-t border-line">
                      <td className="py-1">{shortDate(day.date)}</td>
                      <td className="py-1 text-right tabular-nums">{count(day.visitors)}</td>
                      <td className="py-1 text-right tabular-nums">{count(day.checkouts)}</td>
                      <td className="py-1 text-right tabular-nums">{salesKnown ? count(day.sales) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          {(() => {
            const shown = marks.filter((m) => m.day >= days[0].date && m.day <= days[days.length - 1].date);
            if (!shown.length) return null;
            return (
              <details className="mt-2 text-sm" data-auto-marks>
                <summary className="cursor-pointer font-semibold text-ink-soft">{`Marked on their own: ${shown.length} ${shown.length === 1 ? "event" : "events"}`}</summary>
                <ul className="mt-2 space-y-1">
                  {[...shown].reverse().map((m, i) => (
                    <li key={`${m.day}-${i}`} className="flex items-baseline gap-2" data-mark>
                      <span aria-hidden="true" className={`mt-1.5 block h-1.5 w-1.5 shrink-0 rounded-full ${MARK_COLORS[m.kind]}`} />
                      <span className="shrink-0 tabular-nums text-ink-soft">{shortDate(m.day)}</span>
                      <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{m.text}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-ink-soft">From your store&apos;s own records: emails sent to your list, products added, and when a store sale began and ended. Your own notes are the amber marks.</p>
              </details>
            );
          })()}
          <NumbersNotes notes={notes} onChange={setNotes} from={days[0].date} to={days[days.length - 1].date} today={data.days[data.days.length - 1]?.date ?? days[days.length - 1].date} />
        </div>
      ) : null}

      {/*
        Money by link, above the visitor counts rather than below them.

        The visitor list was always here and never answered the question a
        creator actually has on a Monday morning: not where people came from,
        but which of those places paid. Those were two numbers that never met
        — four hundred visits from a newsletter in one list, six hundred
        dollars in another — and you cannot decide where to spend the week on
        the first one alone. Only the last ninety days, because that is as far
        back as the sales reading goes, and it says so.
      */}
      <RightNow currency={data.currency ?? "usd"} />

      {range !== "all" && totals.visitors > 0 ? (
        <Funnel
          visitors={totals.visitors}
          checkouts={totals.checkouts}
          sales={totals.sales}
          salesHere={salesHere}
          before={beforeTraffic ? { visitors: beforeTraffic.visitors, checkouts: beforeTraffic.checkouts, sales: beforeTraffic.sales } : null}
          span={span}
        />
      ) : null}

      {data.revenueBySource.length > 0 && (!paidFiguresComplete(data) || data.renewals?.partial || data.cashflowComplete !== true) ? <p className="mt-6 text-sm text-ink-soft" role="status">The 90-day money-by-source table waits for complete purchase, renewal and refund readings.</p> : null}
      {paidFiguresComplete(data) && !data.renewals?.partial && data.cashflowComplete === true && data.revenueBySource.length ? (
        <div className="mt-6 overflow-x-auto" tabIndex={0} role="region" aria-labelledby="numbers-revenue-source">
          <table className="w-full text-left text-sm">
            <caption id="numbers-revenue-source" className="text-left text-sm font-bold text-ink">
              Where the money came from, last 90 days
            </caption>
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                <th scope="col" className="py-1 font-semibold">Channel</th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold">Sales</th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold">Revenue</th>
                {withRenewalColumn ? (
                  <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Memberships renewed and later plan payments, by the channel the subscription was sold through">
                    Renewals
                  </th>
                ) : null}
                {withRefundColumn ? (
                  <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Refunds given in these 90 days, under the channel of the sale they gave back">
                    Refunded
                  </th>
                ) : null}
                {withDisputeColumn ? (
                  <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Disputes opened in these 90 days that the bank holds or the buyer won, under the channel of the sale disputed">
                    Disputed
                  </th>
                ) : null}
                {withRenewalColumn || withRefundColumn || withDisputeColumn ? (
                  <>
                    <th scope="col" className="py-1 pl-3 text-right font-semibold">Total</th>
                    <th scope="col" className="py-1 pl-3 text-right font-semibold" title="The total for each sale: what one buyer from the channel came to, renewals in and refunds out">
                      Per buyer
                    </th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {data.revenueBySource.map((row) => (
                <tr key={row.source} className="border-b border-line/60">
                  <th scope="row" className="py-1 pr-3 font-medium text-ink">
                    {channelName(row.source)}
                  </th>
                  <td className="py-1 pl-3 text-right tabular-nums">{count(row.sales)}</td>
                  <td className="py-1 pl-3 text-right tabular-nums">{money(row.cents)}</td>
                  {withRenewalColumn ? <td className="py-1 pl-3 text-right tabular-nums">{row.renewals ? money(row.renewalCents) : "—"}</td> : null}
                  {withRefundColumn ? (
                    <td className="py-1 pl-3 text-right tabular-nums">{refunds90.get(row.source)?.cents ? `−${money(refunds90.get(row.source)!.cents)}` : "—"}</td>
                  ) : null}
                  {withDisputeColumn ? (
                    <td className="py-1 pl-3 text-right tabular-nums">{disputes90.get(row.source)?.cents ? `−${money(disputes90.get(row.source)!.cents)}` : "—"}</td>
                  ) : null}
                  {withRenewalColumn || withRefundColumn || withDisputeColumn ? (
                    (() => {
                      const total = row.cents + row.renewalCents - (refunds90.get(row.source)?.cents ?? 0) - (disputes90.get(row.source)?.cents ?? 0);
                      return (
                        <>
                          <td className="py-1 pl-3 text-right font-semibold tabular-nums text-ink">{money(total)}</td>
                          <td className="py-1 pl-3 text-right tabular-nums">{row.sales > 0 ? money(Math.round(total / row.sales)) : "—"}</td>
                        </>
                      );
                    })()
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-soft">
            Read from your own Stripe account, so it is the money that actually arrived. A sale counts under the tags on the
            page it was bought from; without tags, under the last place the buyer came from in the {data.attributionDays ?? 30} days before — a link
            you shared, a site, or the Instagram or TikTok app — so somebody who found you on Instagram and came back later by
            typing your address is still counted under Instagram. Where the law asks visitors first (the EU, the UK,
            Switzerland and Brazil), or a browser asks not to be followed, only the page&apos;s tags count.
            {withRenewalColumn ? " A renewal counts under the channel its membership or plan was sold through." : ""}
            {withRefundColumn ? " A refund counts under the channel of the sale it gave back, on the day it was given." : ""}
            {withDisputeColumn ? " A dispute counts under the channel of the sale it takes back, on the day it was opened, before Stripe's dispute fee." : ""}
            {!data.disputesComplete ? " Disputes could not all be read, so the totals do not take them out." : ""}
            {refunds90.get("unrecorded")?.cents
              ? ` Refunds of renewals, or of sales from before the last 180 days, are not under any channel: ${money(refunds90.get("unrecorded")!.cents)} in these 90 days.`
              : ""}
          </p>
        </div>
      ) : null}

      {range !== "all" && data.buyers ? (
        <BuyerNumbers windows={data.buyers} range={range} span={span} currency={data.currency ?? "usd"} top={data.topBuyers} buyersLater={reading?.buyersLater} />
      ) : null}

      {salesKnown && data.hours ? <BuyingHours hours={data.hours.sales} /> : null}

      {beside ? <BesideStores band={beside.band} rows={beside.rows} /> : null}

      {range !== "all" && salesKnown && data.discounts?.rows ? (
        <DiscountImpact rows={data.discounts.rows} refundsRead={data.discounts.refundsRead} currency={data.currency ?? "usd"} />
      ) : null}

      {channels.length ? (
        <div className="mt-6 overflow-x-auto" tabIndex={0} role="region" aria-labelledby="numbers-channels">
          <table className="w-full text-left text-sm">
            <caption id="numbers-channels" className="text-left text-sm font-bold text-ink">
              Each channel, from visit to sale
            </caption>
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                <th scope="col" className="py-1 font-semibold">Channel</th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold">Visits</th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Pressed buy, book or get it free">
                  Checkouts
                </th>
                {withFreeColumn ? (
                  <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Addresses left: for a free product, in your sign-up box or on a waitlist">
                    Signups
                  </th>
                ) : null}
                <th scope="col" className="py-1 pl-3 text-right font-semibold">Sales</th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold">Revenue</th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Sales for every 100 visits from the channel">
                  Converts
                </th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Revenue divided by visits: what one visit from the channel was worth">
                  Per visit
                </th>
                {withSpend ? (
                  <>
                    <th scope="col" className="py-1 pl-3 text-right font-semibold" title="What you typed in as spent on ads there, for these days">
                      Ad spend
                    </th>
                    <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Revenue less ad spend, before Stripe's fee">
                      Left
                    </th>
                    <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Revenue for every unit of currency spent on ads there">
                      Back per 1
                    </th>
                    <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Payments including renewals, less matched refunds and recorded ad spend, before fees and other costs; not a budget recommendation">
                      Recorded result
                    </th>
                    <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Days from the first day of spend until the channel's money, renewals included, covered it">
                      Paid back
                    </th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {channels.map((row) => (
                <tr key={row.source} className="border-b border-line/60">
                  <th scope="row" className="py-1 pr-3 font-medium text-ink">
                    {channelName(row.source)}
                  </th>
                  <td className="py-1 pl-3 text-right tabular-nums">{count(row.visits)}</td>
                  <td className="py-1 pl-3 text-right tabular-nums">{count(row.checkouts)}</td>
                  {withFreeColumn ? <td className="py-1 pl-3 text-right tabular-nums">{count(row.free)}</td> : null}
                  <td className="py-1 pl-3 text-right tabular-nums">{salesHere ? count(row.sales) : "—"}</td>
                  <td className="py-1 pl-3 text-right font-semibold tabular-nums text-ink">{salesHere ? money(row.cents) : "—"}</td>
                  <td className="py-1 pl-3 text-right tabular-nums">{salesHere && row.visits >= row.sales ? rate(row.sales, row.visits) : "—"}</td>
                  <td className="py-1 pl-3 text-right tabular-nums">{salesHere && row.visits > 0 && row.visits >= row.sales ? money(Math.round(row.cents / row.visits)) : "—"}</td>
                  {withSpend ? (
                    (() => {
                      const cost = spent?.channels.get(row.source) ?? 0;
                      const left = row.cents - cost;
                      const cash = cashflows.find((c) => c.source === row.source);
                      const payback = salesHere && ledgerPaymentsComplete(data) && cost ? paybackOf(spendsKnown ?? [], row.source, data.channelDays?.[row.source], days[0].date, days[days.length - 1].date) : null;
                      return (
                        <>
                          <td className="py-1 pl-3 text-right tabular-nums">{cost ? money(cost) : "—"}</td>
                          <td className={`py-1 pl-3 text-right font-semibold tabular-nums ${cost && salesHere && left < 0 ? "text-danger" : "text-ink"}`}>
                            {cost && salesHere ? money(left) : "—"}
                          </td>
                          <td className="py-1 pl-3 text-right tabular-nums">{cost && salesHere ? (row.cents / cost).toFixed(2) : "—"}</td>
                          <td
                            className={`py-1 pl-3 text-right font-semibold ${cash?.afterAds !== null && cash?.afterAds !== undefined && cash.afterAds < 0 ? "text-danger" : "text-ink"}`}
                          >
                            {salesHere && cash ? cashflowStatus(cash) : "—"}
                          </td>
                          <td className="whitespace-nowrap py-1 pl-3 text-right tabular-nums">
                            {payback
                              ? payback.days !== null
                                ? `${payback.days} ${payback.days === 1 ? "day" : "days"}`
                                : `Not yet, ${Math.min(99, Math.floor((payback.back / payback.spent) * 100))}%`
                              : "—"}
                          </td>
                        </>
                      );
                    })()
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-soft">
            Visits are counted under where each visit came from; checkouts, signups and sales under the channel the buyer is
            credited to, so a buyer who first came from Instagram and returned later still counts there. Checkouts and
            signups by channel are counted from October 11, 2026.
            {withSpend
              ? " Left and Back per 1 use initial sales before refunds and payment fees; renewals are not in them. Recorded result instead includes renewals and matched refunds, and waits when figures are incomplete. Neither is profit or a recommendation to increase a budget. Paid back counts gross payments, including renewals and organic sales, until they cover recorded ad spend; refunds and fees may delay actual payback."
              : ""}
          </p>
        </div>
      ) : null}
      {range !== "all" && spendsUnread ? (
        <p className="mt-6 text-sm text-ink" role="status" data-spend-unread>
          {SPEND_FIGURES_UNREAD}
        </p>
      ) : null}
      {range !== "all" && spendsKnown ? (
        <RevenueQuality data={data} range={range} spends={spendsKnown} />
      ) : null}
      {range !== "all" ? <PaymentMixPanel data={data} range={range} /> : null}
      {range !== "all" ? <PaymentComparisonPanel data={data} range={range} /> : null}
      {range !== "all" && spendsKnown ? <DailyCashflowPanel data={data} range={range} spends={spendsKnown} /> : null}
      {range !== "all" ? <KeptByCurrency data={data} range={range} /> : null}
      {data.sales !== "none" && range !== "all" ? <TaxCollected data={data} range={range} /> : null}
      {range !== "all" ? <RefundActivityPanel data={data} range={range} /> : null}
      {salesHere && range !== "all" && days.length > 0 && data.buyerChannels ? (
        <BuyerChannelsPanel window={data.buyerChannels[range]} currency={data.currency} historyPartial={data.buyerChannels.historyPartial} period={{ from: days[0].date, to: days[days.length - 1].date }} />
      ) : null}
      {salesHere && data.buyerChannels?.weekly ? <WeeklyCohortsPanel cohorts={data.buyerChannels.weekly} historyPartial={data.buyerChannels.historyPartial} /> : null}
      {range !== "all" && spendsUnread !== "typed" ? (
        <AdSpendEditor
          spends={spends}
          spendsUnread={spendsUnread === "meta"}
          onChange={(next, metaUnread) => {
            setSpends(next);
            setSpendsUnread(metaUnread ? "meta" : null);
          }}
          channels={spendChannels}
          meta={meta}
          canConnectMeta={canConnectMeta}
          pin={pin}
          currency={data.currency ?? "usd"}
          today={data.days[data.days.length - 1]?.date ?? ""}
        />
      ) : null}

      {range !== "all" && spendsKnown ? <CampaignResultsPanel data={data} range={range} spends={spendsKnown} /> : null}

      {ads.length && salesHere && !data.partial ? (
        <div className="mt-6 overflow-x-auto" tabIndex={0} role="region" aria-labelledby="numbers-ads">
          <table className="w-full text-left text-sm">
            <caption id="numbers-ads" className="text-left text-sm font-bold text-ink">
              Paid records by ad or link variant
            </caption>
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                <th scope="col" className="py-1 font-semibold">Ad (utm_content)</th>
                <th scope="col" className="py-1 pl-3 font-semibold">Campaign</th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold">Paid records</th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold">Gross amount</th>
              </tr>
            </thead>
            <tbody>
              {ads.slice(0, 15).map((row) => (
                <tr key={JSON.stringify([row.source, row.campaign, row.content])} className="border-b border-line/60">
                  <th scope="row" className="py-1 pr-3 font-medium text-ink">
                    {row.content}
                    <span className="ml-1.5 text-xs font-normal text-ink-soft">{channelName(row.source)}</span>
                  </th>
                  <td className="py-1 pl-3 text-ink-soft">{row.campaign || "—"}</td>
                  <td className="py-1 pl-3 text-right tabular-nums">{count(row.sales)}</td>
                  <td className="py-1 pl-3 text-right font-semibold tabular-nums text-ink">{money(row.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-soft">
            Use Share to create a campaign link with an optional ad or link variant. Each row keeps the channel, campaign and <span className="font-mono">utm_content</span> together, so reused names do not merge different ads. Paid records include purchases and one-click extras, not unique buyers; gross amounts are before refunds and fees, with renewals excluded.
          </p>
          <p className="mt-2 text-xs text-ink-soft">Showing {Math.min(15, ads.length)} of {ads.length} variants. The download includes every row in this period.</p>
          {days.length ? <ReportDownload csv={creativeResultsReport(ads, { from: days[0].date, to: days[days.length - 1].date, currency: data.currency ?? "usd" })} filename={"marktmorgen-variants-" + days[0].date + "-to-" + days[days.length - 1].date + ".csv"}>Download all variant results</ReportDownload> : null}
        </div>
      ) : null}

      {ads.length > 0 && data.partial ? <p className="mt-6 text-sm text-ink-soft" role="status">The purchase reading is incomplete. Variant totals and downloads wait for complete figures.</p> : null}

      {range !== "all" ? <HeardTable rows={heard} money={money} ask={askHeard} canSet={canSetHeard} /> : null}

      {range !== "all" && (data.searchMisses?.[range] ?? []).length ? (
        <div className="mt-6">
          <p className="text-sm font-bold text-ink">Searched for in your store, and not found</p>
          <ul className="mt-2 divide-y divide-line text-sm">
            {(data.searchMisses?.[range] ?? []).slice(0, 15).map((row) => (
              <li key={row.name} className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate text-ink [overflow-wrap:anywhere]">{`“${row.name}”`}</span>
                <span className="shrink-0 tabular-nums text-ink-soft">{`${count(row.visits)} ${row.visits === 1 ? "search" : "searches"}`}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-soft">
            What visitors typed in your store&apos;s search and found nothing for: a product to make, or a word your titles are missing. Only the words are kept.
          </p>
        </div>
      ) : null}

      {voice !== undefined && canAsk ? <CustomerVoice initial={voice} /> : null}

      {countries.length || devices.length ? (
        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          {countries.length ? <Breakdown title="Where in the world" rows={countries} label={countryName} /> : null}
          {devices.length ? <Breakdown title="On what" rows={devices} label={(name) => DEVICE_NAMES[name] ?? name} /> : null}
        </div>
      ) : null}

      {moneyCountries.length && salesHere ? (
        <div className="mt-6">
          <p className="text-sm font-bold text-ink">Sales by the buyer&apos;s country</p>
          <ul className="mt-2 divide-y divide-line text-sm">
            {moneyCountries.slice(0, 10).map((row) => (
              <li key={row.country} className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate text-ink">{countryName(row.country)}</span>
                <span className="shrink-0 tabular-nums text-ink-soft">{`${count(row.sales)} ${row.sales === 1 ? "sale" : "sales"} · ${money(row.cents)}`}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-soft">
            The country on the buyer&apos;s payment, as your Stripe account has it; a sale whose payment gave none is not in this list.
            Set beside where your visitors are, it shows where people come and do not buy, which is where a fair price by country can help.
          </p>
        </div>
      ) : null}

      {attribution && salesHere && !data.partial ? (
        <AttributionTable
          table={attribution}
          period={days.length ? { from: days[0].date, to: days[days.length - 1].date, currency: data.currency ?? "usd" } : undefined}
          days={data.attributionDays ?? 30}
          canSet={canSetAttribution}
          span={span}
          money={money}
          count={count}
        />
      ) : null}

      {attribution && data.partial ? <p className="mt-6 text-sm text-ink-soft" role="status">The purchase reading is incomplete. Attribution comparisons and downloads wait for complete figures.</p> : null}

      {sources.length ? (
        <div className="mt-6">
          <Breakdown title="Where visitors came from" rows={sources} named />
          <p className="mt-2 text-xs text-ink-soft">
            Add <span className="font-mono">?utm_source=newsletter</span> (or any word) to a link you share and its visits are counted under that word.
          </p>
        </div>
      ) : null}

      {mediums.length || campaigns.length ? (
        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          {mediums.length ? <Breakdown title="By medium (utm_medium)" rows={mediums} /> : null}
          {campaigns.length ? <Breakdown title="By campaign (utm_campaign)" rows={campaigns} /> : null}
        </div>
      ) : sources.length ? (
        <p className="mt-4 text-xs text-ink-soft">
          Tag links with <span className="font-mono">utm_medium</span> and <span className="font-mono">utm_campaign</span> too (say
          <span className="font-mono"> ?utm_source=instagram&amp;utm_medium=story&amp;utm_campaign=launch</span>) and each gets a list of its own here.
        </p>
      ) : null}

      {reach && reach.visitors > 0 ? (
        reach.visitors >= READ_MIN_VISITORS ? (
          <div className="mt-6 overflow-x-auto" tabIndex={0} role="region" aria-labelledby="numbers-reach">
            <table className="w-full text-left text-sm">
              <caption id="numbers-reach" className="text-left text-sm font-bold text-ink">
                Your store page, item by item
              </caption>
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                  <th scope="col" className="py-1 font-semibold">Item, top first</th>
                  <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Of the visitors measured, the share who got at least as far down as it">
                    Reached it
                  </th>
                  <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Of those who reached it, the share who clicked it">
                    Clicked it
                  </th>
                </tr>
              </thead>
              <tbody>
                {reach.rows.slice(0, 40).map((row) => (
                  <tr key={row.item} className="border-b border-line/60">
                    <th scope="row" className="max-w-[12rem] truncate py-1 pr-3 font-medium text-ink sm:max-w-[22rem]">
                      {row.title}
                      <span className="ml-1.5 text-xs font-normal text-ink-soft">{row.kind === "product" ? "product" : row.kind === "link" ? "link" : "part"}</span>
                    </th>
                    <td className="py-1 pl-3 text-right tabular-nums">{rate(row.reached, reach.visitors)}</td>
                    <td className="py-1 pl-3 text-right tabular-nums">{row.kind === "part" ? "—" : rate(row.clicks, row.reached)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-ink-soft">
              {`Measured on one visitor in ${READ_SAMPLE}, chosen at random: ${count(reach.visitors)} so far for these days. `}
              An item low on the page that is clicked by most of the few who reach it is worth moving up. Measured from
              October 11, 2026, with nothing about who.
            </p>
          </div>
        ) : (
          <p className="mt-6 text-xs text-ink-soft">
            {`How far down your store page people go, and what they click there, is shown once ${READ_MIN_VISITORS} visits are measured (one visitor in ${READ_SAMPLE} is): ${count(reach.visitors)} so far for these days.`}
          </p>
        )
      ) : null}

      {data.products.length ? (
        // Scrolls sideways on a narrow phone, so it can be reached from the keyboard too.
        <div className="mt-6 overflow-x-auto" tabIndex={0} role="region" aria-labelledby="numbers-products">
          <table className="w-full text-left text-sm">
            <caption id="numbers-products" className="text-left text-sm font-bold text-ink">
              What you sell, best first
            </caption>
            <thead>
              <tr className="text-ink-mute">
                <th scope="col" className="py-1.5 font-semibold">Product</th>
                <th scope="col" className="whitespace-nowrap py-1.5 pl-3 text-right font-semibold" title="Times the product's own page was opened">
                  Page views
                </th>
                <th scope="col" className="whitespace-nowrap py-1.5 pl-3 text-right font-semibold">Checkouts</th>
                <th scope="col" className="whitespace-nowrap py-1.5 pl-3 text-right font-semibold">Sales</th>
                <th scope="col" className="whitespace-nowrap py-1.5 pl-3 text-right font-semibold">Revenue</th>
                <th scope="col" className="whitespace-nowrap py-1.5 pl-3 text-right font-semibold" title="Sales for every 100 checkouts started">
                  Paid
                </th>
                <th scope="col" className="whitespace-nowrap py-1.5 pl-3 text-right font-semibold" title="Sales for every 100 times its page was opened">
                  Bought
                </th>
                {withProductRefunds ? (
                  <th scope="col" className="whitespace-nowrap py-1.5 pl-3 text-right font-semibold" title="Refunds given in the last 90 days">
                    Refunded
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {shownProducts.map((product, index) => (
                <tr key={product.id} className="border-t border-line">
                  <td className="max-w-[7rem] truncate py-1.5 pr-2 font-semibold text-ink sm:max-w-[14rem]">
                    {index < 3 && product.cents !== null && product.cents > 0 ? <span className="mr-1.5 tabular-nums text-violet-deep">{index + 1}.</span> : null}
                    {product.title}
                  </td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">{product.views < 0 ? "—" : count(product.views)}</td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">{count(product.checkouts)}</td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">{salesHere && product.sales !== null ? count(product.sales) : "—"}</td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">{salesHere && product.cents !== null ? money(product.cents) : "—"}</td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">{salesHere && product.sales !== null ? rate(product.sales, product.checkouts) : "—"}</td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">{salesHere && product.sales !== null && product.views > 0 && product.views >= product.sales ? rate(product.sales, product.views) : "—"}</td>
                  {withProductRefunds ? (
                    <td className="py-1.5 pl-3 text-right tabular-nums">
                      {data.refundsByProduct?.[product.id] ? `${data.refundsByProduct[product.id].refunds} · ${money(data.refundsByProduct[product.id].cents)}` : "—"}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-soft">
            Page views are the times the product&apos;s own page was opened, counted from October 8, 2026, for 7, 30 and 90 days.
            Paid is sales for every 100 checkouts started; Bought is sales for every 100 page views, and is left out while a
            product sells more than its page is visited, as when buyers pay from your store&apos;s front page. A free product&apos;s
            checkouts are the addresses asked for, and it has no sales.
          </p>
        </div>
      ) : null}

      {data.links.length ? (
        <div className="mt-6">
          <p className="text-sm font-bold text-ink">Your links, opened</p>
          <ul className="mt-2 divide-y divide-line text-sm">
            {data.links.map((link) => (
              <li key={link.id} className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate text-ink">{link.title}</span>
                <span className="shrink-0 tabular-nums text-ink-soft">{count(link[range])}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-6 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line">
        <p className="text-sm font-bold text-ink">Take your numbers with you</p>
        <p className="mt-1 text-xs text-ink-soft">CSV files that open in Excel, Numbers and Google Sheets.</p>
        {/* Plain GET forms rather than links, so nothing prefetches a file that reads Stripe. */}
        <div className="mt-3 flex flex-wrap items-end gap-3">
          {/* The sales file carries buyers' addresses: only for a role that may take them. */}
          {salesKnown && canExport ? (
            <form action="/api/store/export" method="get" className="flex flex-wrap items-end gap-2">
              <StoreField />
              <input type="hidden" name="what" value="sales" />
              <label className="text-sm">
                <span className="field-label">Sales</span>
                <select name="range" defaultValue="30" className="field mt-1 w-auto py-2">
                  <option value="30">Last 30 days</option>
                  <option value="90">Last 90 days</option>
                  <option value="all">All</option>
                </select>
              </label>
              <button type="submit" className="btn btn-primary btn-sm">
                Download sales
              </button>
            </form>
          ) : null}
          <form action="/api/store/export" method="get">
            <StoreField />
            <input type="hidden" name="what" value="visits" />
            <button type="submit" className="btn btn-secondary btn-sm">
              Visits by day
            </button>
          </form>
          <form action="/api/store/export" method="get">
            <StoreField />
            <input type="hidden" name="what" value="sources" />
            <button type="submit" className="btn btn-secondary btn-sm">
              Sources and campaigns
            </button>
          </form>
        </div>
        {canExport ? (
          <div className="mt-4 border-t border-line pt-4">
            <p className="text-sm font-bold text-ink">Your buyers, for ad audiences</p>
            <p className="mt-1 text-xs text-ink-soft">
              One column of email addresses, the file Meta (Audiences, Custom audience, Customer list) and TikTok (Audiences,
              Customer file) take. Use it to stop showing ads to people who already bought, or to ask for more people like them.
              Only buyers who selected the box to hear from you and have not left your list are in it, and nothing but their
              address. Upload it only where your buyers&apos; permission covers it: that is yours to answer for.
            </p>
            <form action="/api/store/audience" method="get" className="mt-3">
              <StoreField />
              <button type="submit" className="btn btn-secondary btn-sm">
                Download buyers for ads
              </button>
            </form>
          </div>
        ) : null}
        {/*
          The sales file is described only where its button is. Without Stripe
          connected there is no button, and a sentence about a file nobody can
          find sends the creator looking for it; they are told instead when it
          will appear.
        */}
        <p className="mt-3 text-xs text-ink-soft">
          {data.sales === "none"
            ? "A third file, your sales, appears here once your Stripe account is connected. "
            : data.sales === "error"
              ? "Your sales could not be read from Stripe just now, so their file is not offered; it comes back when they can be. "
            : !canExport
              ? "Downloading sales, which carry buyers' addresses, is for the owner and Admins. "
              : "The sales file has one row per paid checkout or one-click extra, with the buyer's email and name, and reads up to 5,000 of each from your Stripe account. "}
          Visits go back as far as they are kept, 400 days.
        </p>
        {weeklyTeam ? <WeeklyTeamPicker members={weeklyTeam.members} chosen={weeklyTeam.chosen} /> : null}
        {weeklyAi !== undefined ? <WeeklyAiToggle on={weeklyAi} /> : null}
        {chat !== undefined ? <ChatSummaryEditor kind={chat} sales={chatSales} /> : null}
      </div>

      {deviceMarked !== null ? <NoCountToggle marked={deviceMarked} /> : null}

      <p className="mt-6 text-xs leading-relaxed text-ink-soft">
        Counted without cookies, and your own visits and your team&apos;s while logged in are not counted, nor those of a device you marked. A visitor is one person on one
        device on one day. Days run midnight to midnight UTC. Sales are read from your own Stripe account: new
        purchases and new members, before Stripe&apos;s fee and any refund. Renewals are the payments after the first of
        memberships and payment plans, from the paid invoices of your store&apos;s subscriptions over the last 90 days;
        all of them are in your Stripe dashboard.
        {data.partial ? " The recent purchase reading is incomplete. Paid totals, rates and product rankings wait for complete figures; visits and checkouts remain available." : ""}
        {data.renewals?.partial ? " The invoice reading is incomplete, so renewal totals are unavailable." : ""}
      </p>
    </section>
  );
}
