import { COMMISSION_BPS, COMMISSION_PLANS_PUBLISHED, PLAN_TITLES } from "@/lib/plan";
import { Icon, type IconName } from "@/components/icons";
import { BumpDemo, OptionsDemo } from "@/components/feature-demos";
import { FUNNEL_TYPES, choicesOf, pagesOf } from "@/lib/funnel-types";
import { MAX_BUNDLE_ITEMS, MIN_BUNDLE_ITEMS } from "@/lib/bundle-rules";
import { DEFAULT_ATTEMPTS, DEFAULT_PASS_PERCENT } from "@/lib/quiz";
import { DEFAULT_KEYS } from "@/lib/key-setup";
import { sampleKey } from "@/lib/licence-key-rules";
import { formatMoney } from "@/lib/money";
import { JOIN_EARLY_MINUTES } from "@/lib/community-text";
import { eventTime, lengthWords } from "@/lib/community-events";
import { ROLE_NAMES } from "@/lib/team-roles";
import { MAX_TEAM } from "@/lib/team";
import { stampLine } from "@/lib/pdf-stamp-line";
import { currencyLabel } from "@/lib/money";
import { MAX_ENDPOINTS, shortAddress } from "@/lib/webhook-limits";
import { LOOKAHEAD_DAYS, MAX_FEEDS } from "@/lib/calendar-limits";
import { MAX_DISCORD_PRODUCTS, MAX_PRODUCT_ROLES } from "@/lib/discord-rules";
import { BLOCK_KINDS, MAX_BLOCKS, type BlockKind } from "@/lib/sales-page";
import { AI_PLANS_WORDS } from "@/lib/ai-rules";
import { KIND_ICONS } from "@/lib/sales-page-icons";
import { DEFAULT_STAGES, FIRST_PIPELINE_NAME, pipelineLimit, type Deal } from "@/lib/crm-rules";
import { OUTREACH_COUNTRIES, pitchFooter } from "@/lib/outreach-rules";
import { SITE_URL } from "@/lib/site-url";
import { HOUSE_HANDLE } from "@/lib/house-store";
import { IMPORT_DATE, IMPORT_LEFT_WORDS, IMPORT_WORDS, OUTCOME_WORDS, type Outcome } from "@/lib/import-words";

/**
 * The pictures at the top of each feature page.
 *
 * Each one is drawn from the screen it stands for — the same labels, the same
 * order, the same rules — so what a creator sees here is what they will find.
 * Nothing in them is a figure about us: where a screen would show a number,
 * the number is an example and the caption says so.
 */
export type VisualKey =
  | "store"
  | "options"
  | "delivery"
  | "stripe"
  | "course"
  | "membership"
  | "calls"
  | "checkout"
  | "email"
  | "domain"
  | "insights"
  | "funnels"
  | "bundles"
  | "quizzes"
  | "keys"
  | "webhooks"
  | "calendar"
  | "discord"
  | "community"
  | "affiliates"
  | "events"
  | "team"
  | "emailPlatforms"
  | "stamp"
  | "ways"
  | "phone"
  | "security"
  | "salesPage"
  | "aiWriting"
  | "crm"
  | "outreach"
  | "importDone"
  | "dryRun";

/*
 * The frame every one of these mockups sits in.
 *
 * min-w-0 because these are drawings of a screen and their rows are built
 * from truncating text and nowrap badges, which together give the frame an
 * intrinsic width of about 410px. Without this the frame refuses to shrink
 * below that, and because it is a grid item in the hero it takes the heading
 * and the paragraph beside it along — the drawing wins and the words get cut
 * off. With it the rows truncate, which is what they were already written to
 * do: every one of them carries `min-w-0 flex-1 truncate` and had no ancestor
 * willing to apply the pressure.
 */
function Window({ bar, children }: { bar: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-[var(--r-xl)] border border-white/10 bg-white text-ink shadow-[var(--shadow-device)]">
      <div className="flex items-center gap-2 border-b border-line bg-paper px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-sand-deep" />
          <span className="h-2.5 w-2.5 rounded-full bg-sand-deep" />
          <span className="h-2.5 w-2.5 rounded-full bg-sand-deep" />
        </span>
        <span className="min-w-0 flex-1 truncate rounded-[6px] bg-white px-2.5 py-1 text-center text-[11px] font-medium text-ink-soft ring-1 ring-line">
          {bar}
        </span>
      </div>
      {children}
    </div>
  );
}

function Row({ icon, title, sub, end, wrap = false }: { icon: IconName; title: string; sub?: string; end?: React.ReactNode; wrap?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-[var(--r-md)] border border-line bg-white px-3.5 py-3">
      <span className="icon-tile icon-tile-sm shrink-0">
        <Icon name={icon} size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block ${wrap ? "break-words" : "truncate"} text-[13px] font-semibold text-ink`}>{title}</span>
        {sub ? <span className={`block ${wrap ? "break-words" : "truncate"} text-[12px] text-ink-soft`}>{sub}</span> : null}
      </span>
      {end}
    </div>
  );
}

const Price = ({ children }: { children: React.ReactNode }) => (
  <span className="shrink-0 rounded-full bg-lilac px-2.5 py-0.5 text-[12px] font-semibold text-violet-deep">{children}</span>
);

function StoreVisual() {
  return (
    <Window bar="marktmorgen.com/@harborkitchen">
      <div className="bg-[linear-gradient(180deg,#f3efff,transparent_55%)] px-5 pb-6 pt-7 text-center">
        <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-violet-brand text-2xl font-semibold text-white ring-4 ring-white">
          H
        </span>
        <p className="mt-3 text-[17px] font-semibold tracking-[-0.01em]">Harbor Kitchen</p>
        <p className="text-[13px] text-ink-soft">Simple family meals by Jenny, a fictional cook</p>
        <div className="mt-5 space-y-2.5 text-left">
          <Row icon="file" title="Weekly Meal Planner" sub="Two sizes, delivered as a PDF" end={<Price>from $27</Price>} />
          <Row icon="link" title="Open a store like this one" sub="marktmorgen.com" />
        </div>
        <div className="mt-5 flex items-center justify-center gap-2 text-[11px] font-semibold text-ink-soft">
          <span>Theme</span>
          {["bg-white ring-violet-brand", "bg-[#f4efe6] ring-line", "bg-[#15112e] ring-line", "bg-violet-brand ring-line"].map((c, i) => (
            <span key={i} className={`h-5 w-5 rounded-full ring-2 ${c}`} />
          ))}
        </div>
      </div>
    </Window>
  );
}

function DeliveryVisual() {
  const steps: { icon: IconName; title: string; sub: string; done?: boolean }[] = [
    { icon: "card", title: "Paid", sub: "On the creator's own Stripe account", done: true },
    { icon: "check-circle", title: "Stripe confirms it", sub: "Nothing is released before this", done: true },
    { icon: "download", title: "Download it", sub: "On the same screen, right away" },
  ];
  return (
    <Window bar="Your order">
      <div className="space-y-4 p-5">
        <ol className="space-y-2.5">
          {steps.map((s) => (
            <li key={s.title}>
              <Row
                icon={s.icon}
                title={s.title}
                sub={s.sub}
                end={s.done ? <span className="tag tag-live">Done</span> : <span className="btn btn-primary btn-sm pointer-events-none">Download</span>}
              />
            </li>
          ))}
        </ol>
        <div className="rounded-[var(--r-md)] bg-sand p-4">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <Icon name="mail" size={16} className="text-violet-deep" />
            A month later, on a new phone
          </p>
          <p className="mt-1 text-[12.5px] leading-snug text-ink-soft">
            &ldquo;Bought something here? Get it again&rdquo; &mdash; the email address they paid with receives everything they bought.
          </p>
        </div>
      </div>
    </Window>
  );
}

function StripeVisual() {
  return (
    <Window bar="Where a $27 sale goes">
      <div className="p-5">
        <div className="grid gap-2.5">
          <Row icon="user" title="The buyer pays $27" sub="By card, on a Stripe checkout" />
          <div className="flex justify-center text-ink-mute" aria-hidden="true">
            <Icon name="chevron-down" size={18} />
          </div>
          <div className="rounded-[var(--r-md)] border-2 border-violet-brand bg-lilac/60 px-4 py-3.5">
            <p className="flex items-center justify-between gap-3 text-[13px] font-semibold text-ink">
              <span className="flex items-center gap-2">
                <Icon name="bank" size={16} className="text-violet-deep" />
                Your own Stripe account
              </span>
              <span>$27.00</span>
            </p>
            <p className="mt-1 text-[12px] text-ink-soft">Stripe takes its own card fee here, as it would for any shop of yours.</p>
          </div>
          <div className="flex justify-center text-ink-mute" aria-hidden="true">
            <Icon name="chevron-down" size={18} />
          </div>
          <Row icon="receipt" title="Your bank" sub="On the payout schedule you set at Stripe" />
        </div>
        <p className="mt-4 flex items-center justify-between rounded-[var(--r-md)] bg-sand px-4 py-3 text-[12.5px] text-ink-soft">
          <span>Marktmorgen&apos;s fee on this sale</span>
          <span className="text-[15px] font-semibold text-ink">{`$${(Math.floor(2700 * (COMMISSION_PLANS_PUBLISHED ? COMMISSION_BPS.creator : 0) / 10000) / 100).toFixed(2)}`}</span>
        </p>
      </div>
    </Window>
  );
}

function CourseVisual() {
  const lessons = [
    { t: "Welcome, and what you will need", done: true, free: true },
    { t: "Your first week, planned", done: true },
    { t: "The shopping list that does the work", done: false },
  ];
  return (
    <Window bar="Batch cooking, the course">
      <div className="p-5">
        <div className="flex items-center justify-between text-[12px] font-semibold text-ink-soft">
          <span>Module 1 &middot; Start here</span>
          <span>2 of 3 done</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sand" aria-hidden="true">
          <div className="h-full w-2/3 rounded-full bg-violet-brand" />
        </div>
        <ul className="mt-4 min-w-0 space-y-2">
          {lessons.map((l) => (
            <li key={l.t} className="flex items-center gap-3 rounded-[var(--r-sm)] border border-line px-3 py-2.5 text-[13px]">
              <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${l.done ? "bg-mint-soft text-mint-deep" : "bg-sand text-ink-soft"}`}>
                {l.done ? <Icon name="check" size={12} strokeWidth={2.6} /> : <Icon name="video" size={11} />}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium text-ink">{l.t}</span>
              {l.free ? <span className="tag">Free preview</span> : null}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex items-center gap-3 rounded-[var(--r-md)] bg-sand px-3.5 py-3 text-[13px]">
          <Icon name="lock" size={16} className="shrink-0 text-violet-deep" />
          <span className="min-w-0">
            <span className="block font-semibold text-ink">Module 2 &middot; Freezer week</span>
            <span className="block text-[12px] text-ink-soft">Opens 7 days after joining, with an email that day</span>
          </span>
        </div>
      </div>
    </Window>
  );
}

function MembershipVisual() {
  return (
    <Window bar="marktmorgen.com/@harborkitchen">
      <div className="space-y-3 p-5">
        <div className="rounded-[var(--r-md)] border border-line p-4">
          <div className="flex items-start justify-between gap-3">
            <span>
              <span className="block text-[14px] font-semibold text-ink">Supper club</span>
              <span className="block text-[12.5px] text-ink-soft">A new plan and a live cook-along every month</span>
            </span>
            <Price>$8 a month</Price>
          </div>
          <span className="btn btn-primary btn-sm btn-block pointer-events-none mt-4">Subscribe &mdash; $8 a month</span>
          <p className="mt-3 text-center text-[12px] font-semibold text-violet-deep underline underline-offset-2">
            Already a member? Manage or cancel
          </p>
        </div>
        <div className="rounded-[var(--r-md)] bg-sand p-4 text-[12.5px] text-ink-soft">
          <p className="flex items-center gap-2 font-semibold text-ink">
            <Icon name="repeat" size={15} className="text-violet-deep" />
            Charged on your Stripe account
          </p>
          <p className="mt-1">Daily, weekly, monthly or yearly. The member cancels on Stripe&apos;s own page, without writing to you.</p>
        </div>
      </div>
    </Window>
  );
}

function CallsVisual() {
  const days = ["Mon 6", "Tue 7", "Wed 8", "Thu 9", "Fri 10"];
  const times = ["9:00 AM", "9:45 AM", "10:30 AM", "2:00 PM", "2:45 PM", "3:30 PM"];
  return (
    <Window bar="One hour with Marcus">
      <div className="p-5">
        <p className="text-[12px] font-semibold text-ink-soft">Pick a day, then a time</p>
        <div className="mt-3 grid grid-cols-5 gap-1.5">
          {days.map((d, i) => (
            <span
              key={d}
              className={`rounded-[var(--r-sm)] px-1 py-2 text-center text-[11.5px] font-semibold ${
                i === 2 ? "bg-violet-brand text-white" : "border border-line text-ink"
              }`}
            >
              {d}
            </span>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          {times.map((t, i) => (
            <span
              key={t}
              className={`rounded-[var(--r-sm)] py-2 text-center text-[12.5px] font-semibold ${
                i === 3 ? "border-2 border-violet-brand bg-lilac text-violet-deep" : "border border-line text-ink"
              }`}
            >
              {t}
            </span>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-ink-soft">Times are in your time zone.</p>
        <p className="mt-3 rounded-[var(--r-sm)] bg-lilac px-3 py-2 text-[12.5px] text-ink">
          <strong>Wed 8, 2:00 PM</strong> &middot; 60 minutes
        </p>
        <span className="btn btn-primary btn-block pointer-events-none mt-3">Continue to payment &mdash; $180</span>
        <p className="mt-3 flex items-center justify-center gap-2 text-[12px] text-ink-soft">
          <Icon name="clock" size={14} className="text-violet-deep" />
          The time is kept for you for 30 minutes while you pay.
        </p>
      </div>
    </Window>
  );
}

function EmailVisual() {
  return (
    <Window bar="Studio · Email">
      <div className="space-y-3 p-5 text-[13px]">
        <div className="rounded-[var(--r-md)] border border-line">
          <p className="border-b border-line px-3.5 py-2.5 text-ink-soft">
            <span className="font-semibold text-ink">To:</span> everyone who agreed to hear from you
          </p>
          <p className="border-b border-line px-3.5 py-2.5 font-semibold text-ink">This week&apos;s plan is up</p>
          <div className="space-y-1.5 px-3.5 py-3" aria-hidden="true">
            <span className="block h-2 w-11/12 rounded-full bg-sand-deep" />
            <span className="block h-2 w-10/12 rounded-full bg-sand-deep" />
            <span className="block h-2 w-7/12 rounded-full bg-sand-deep" />
          </div>
        </div>
        <div className="flex gap-2">
          <span className="btn btn-primary btn-sm pointer-events-none">Send now</span>
          <span className="btn btn-secondary btn-sm pointer-events-none">Send later</span>
        </div>
        <div className="rounded-[var(--r-md)] bg-sand p-3.5">
          <p className="flex items-center gap-2 font-semibold text-ink">
            <Icon name="refresh" size={15} className="text-violet-deep" />
            Welcome sequence
          </p>
          <ol className="mt-2 space-y-1 text-[12.5px] text-ink-soft">
            <li>1 &middot; Right after they join &middot; &ldquo;Your free recipe&rdquo;</li>
            <li>2 &middot; Two days later &middot; &ldquo;How I plan a week&rdquo;</li>
            <li>3 &middot; Five days later &middot; &ldquo;The planner, if you want it&rdquo;</li>
          </ol>
        </div>
      </div>
    </Window>
  );
}

function DomainVisual() {
  return (
    <Window bar="shop.harborkitchen.com">
      <div className="space-y-4 p-5 text-[13px]">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-ink">shop.harborkitchen.com</span>
          <span className="tag tag-live">Live</span>
        </div>
        <div className="overflow-hidden rounded-[var(--r-md)] border border-line">
          <div className="grid grid-cols-[4.5rem_4.5rem_1fr] bg-paper px-3.5 py-2 text-[11.5px] font-semibold text-ink-soft">
            <span>Type</span>
            <span>Name</span>
            <span>Value</span>
          </div>
          <div className="grid grid-cols-[4.5rem_4.5rem_1fr] border-t border-line px-3.5 py-2.5 font-mono text-[12px] text-ink">
            <span>CNAME</span>
            <span>shop</span>
            <span className="truncate">shown in your studio</span>
          </div>
        </div>
        <p className="flex items-center gap-2 text-[12.5px] text-ink-soft">
          <Icon name="lock" size={14} className="text-violet-deep" />
          The certificate is made and renewed for you.
        </p>
        <p className="flex items-center gap-2 text-[12.5px] text-ink-soft">
          <Icon name="link" size={14} className="text-violet-deep" />
          marktmorgen.com/@harborkitchen keeps working too.
        </p>
      </div>
    </Window>
  );
}

function InsightsVisual() {
  const bars = [38, 52, 44, 70, 61, 84, 76];
  const sources = ["Instagram", "TikTok", "Direct", "YouTube"];
  return (
    <Window bar="Studio · Your numbers">
      <div className="p-5">
        <div className="flex gap-1.5 text-[12px] font-semibold">
          <span className="rounded-full bg-ink px-3 py-1 text-white">7 days</span>
          <span className="rounded-full border border-line px-3 py-1 text-ink-soft">30 days</span>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-2 text-[11.5px] text-ink-soft">
          {["Visitors", "Checkouts", "Sales", "Conversion"].map((l) => (
            <span key={l} className="rounded-[var(--r-sm)] bg-paper px-2 py-2">
              {l}
              <span className="mt-1 block h-2 w-3/4 rounded-full bg-sand-deep" aria-hidden="true" />
            </span>
          ))}
        </div>
        <div className="mt-4 flex h-24 items-end gap-2" aria-hidden="true">
          {bars.map((h, i) => (
            <span key={i} className="flex-1 rounded-t-[6px] bg-violet-brand/80" style={{ height: `${h}%` }} />
          ))}
        </div>
        <ul className="mt-4 min-w-0 space-y-1.5 text-[12.5px]">
          {sources.map((s, i) => (
            <li key={s} className="flex items-center gap-3">
              <span className="w-20 shrink-0 font-medium text-ink">{s}</span>
              <span className="h-2 rounded-full bg-lilac-deep" style={{ width: `${70 - i * 16}%` }} aria-hidden="true" />
            </li>
          ))}
        </ul>
      </div>
    </Window>
  );
}

/**
 * The kinds of funnel the studio starts from (531 [VP1]), read from the same
 * list the studio and the route that builds a funnel read
 * (lib/funnel-types.ts), under the studio's own heading
 * (components/funnel-type-picker.tsx): their names, in their order, and
 * what each asks of the creator, counted from its own steps. Nothing here is
 * made up.
 */
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
function FunnelsVisual() {
  const shown = FUNNEL_TYPES.slice(0, 5);
  const more = FUNNEL_TYPES.length - shown.length;
  return (
    <Window bar="Start from a kind of funnel">
      <div className="space-y-2 p-5">
        {shown.map((type) => (
          <Row
            key={type.id}
            icon="ladder"
            title={type.label}
            sub={`${plural(choicesOf(type).length, "product")} to choose · ${plural(pagesOf(type).length, "new page")}`}
          />
        ))}
        {more > 0 ? <p className="pt-1 text-center text-[12px] font-semibold text-ink-soft">{`and ${plural(more, "more kind")}`}</p> : null}
      </div>
    </Window>
  );
}

/** The bundle editor (components/bundle-editor.tsx): its count, its rule and its choosing box. */
function BundlesVisual() {
  const items = [
    { t: "Weeknight dinners, the guide", p: 19 },
    { t: "Batch cooking, the course", p: 49 },
    { t: "The freezer planner", p: 9 },
  ];
  const price = 49;
  const worth = items.reduce((n, item) => n + item.p, 0);
  return (
    <Window bar="Bundle · Every guide, one price">
      <div className="space-y-2 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-[13px] font-bold text-ink">{`In it: ${items.length} of ${MAX_BUNDLE_ITEMS}`}</p>
          {/* The editor's own line once a bundle has at least MIN_BUNDLE_ITEMS and a price. */}
          {items.length >= MIN_BUNDLE_ITEMS ? <p className="text-[12.5px] font-semibold text-ink">{`$${worth} of products for $${price}`}</p> : null}
        </div>
        {items.map((item) => (
          <Row key={item.t} icon="file" title={item.t} end={<Price>{`$${item.p}`}</Price>} />
        ))}
        <div className="flex items-start gap-3 rounded-[var(--r-md)] bg-sand px-3.5 py-3 text-[13px]">
          <span className="mt-0.5 h-4 w-4 shrink-0 rounded-[4px] border border-line-strong bg-white" />
          <span className="min-w-0 font-semibold text-ink">Let each buyer choose which ones they get</span>
        </div>
      </div>
    </Window>
  );
}

/** A lesson's quiz, open in the course editor (components/quiz-editor.tsx), and the certificate switch under the course. */
function QuizzesVisual() {
  const answers = [
    { t: "Curl your fingertips under, like a claw", right: true },
    { t: "Hold the food flat with your fingers spread", right: false },
    { t: "Hold the food on the side you are cutting", right: false },
  ];
  return (
    <Window bar="Lesson · Slicing safely">
      <div className="space-y-3 p-5">
        <p className="text-[12px] font-semibold text-ink-soft">Quiz</p>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-[var(--r-sm)] border border-line px-3 py-2">
            <p className="text-[11.5px] font-semibold text-ink-soft">Pass mark (%)</p>
            <p className="text-[13px] font-semibold text-ink">{DEFAULT_PASS_PERCENT}</p>
          </div>
          <div className="rounded-[var(--r-sm)] border border-line px-3 py-2">
            <p className="text-[11.5px] font-semibold text-ink-soft">Tries allowed</p>
            <p className="text-[13px] font-semibold text-ink">{DEFAULT_ATTEMPTS}</p>
          </div>
        </div>
        <div className="rounded-[var(--r-md)] border border-line p-3.5">
          <p className="text-[13px] font-semibold text-ink">Which way keeps your fingers safe while you slice?</p>
          <p className="mt-2 text-[12px] font-semibold text-ink">Answers — check the right one</p>
          <ul className="mt-1.5 min-w-0 space-y-1.5">
            {answers.map((a) => (
              <li key={a.t} className="flex items-start gap-2 text-[12.5px] text-ink">
                <span className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border ${a.right ? "border-[5px] border-violet-brand" : "border-line-strong"}`} />
                <span className="min-w-0 flex-1 break-words">{a.t}</span>
              </li>
            ))}
          </ul>
        </div>
        <Row icon="scroll" title="Certificate of completion" sub="Its own page anyone can open" end={<span className="tag tag-live">On</span>} wrap />
      </div>
    </Window>
  );
}

/** A key as one given looks: the default shape, drawn from the keys' own letters, fixed so the page never shows a key that works. */
export const EXAMPLE_KEY = "K7QM-R4TX-9WHC-P2ND";

/** The license key editor (components/licence-key-editor.tsx): where keys come from, and the keys given. */
function KeysVisual() {
  const sample = sampleKey(DEFAULT_KEYS);
  return (
    <Window bar="License keys">
      <div className="space-y-3 p-5">
        <div className="grid gap-2 sm:grid-cols-2">
          {[
            { t: "Made here, one per sale", on: true },
            { t: "From a list you upload", on: false },
          ].map((o) => (
            <div key={o.t} className={`flex items-start gap-2 rounded-[var(--r-sm)] border p-3 text-[12.5px] ${o.on ? "border-violet-brand bg-lilac" : "border-line"}`}>
              <span className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border ${o.on ? "border-[5px] border-violet-brand" : "border-line-strong"}`} />
              <span className="min-w-0 font-semibold text-ink">{o.t}</span>
            </div>
          ))}
        </div>
        <p className="text-[12.5px] text-ink-soft">{`Each buyer gets a new key made for them, like ${sample}. No key is ever given twice.`}</p>
        <div>
          <p className="text-[12px] font-semibold text-ink-soft">Keys given</p>
          <div className="mt-1.5 rounded-[var(--r-sm)] border border-line px-3 py-2.5">
            <p className="break-all font-mono text-[13px] font-semibold text-ink">{EXAMPLE_KEY}</p>
            <p className="text-[12px] text-ink-soft">dana@example.com · an example order</p>
          </div>
        </div>
      </div>
    </Window>
  );
}

/** The studio's webhooks card (components/webhook-editor.tsx): one endpoint, and its deliveries, newest first, by the code's event names. */
function WebhooksVisual() {
  const where = shortAddress("https://hooks.zapier.com/hooks/catch/1234567/abcdefg/");
  const log = [
    { type: "refund.issued", when: "Nov 1, 3:04 PM", result: "Sending", ok: false },
    { type: "list.joined", when: "Nov 1, 2:51 PM", result: "Delivered (200)", ok: true },
    { type: "sale.completed", when: "Nov 1, 2:40 PM", result: "Delivered (200)", ok: true },
  ];
  return (
    <Window bar="Webhooks and Zapier">
      <div className="space-y-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[13px] font-bold text-ink">Webhooks and Zapier</p>
          <span className="tag tag-live">{`1 of ${MAX_ENDPOINTS}`}</span>
        </div>
        <div className="rounded-[var(--r-md)] bg-paper px-3.5 py-3 ring-1 ring-line">
          <p className="break-all font-mono text-[12.5px] font-semibold text-ink">{where}</p>
          <p className="text-[12px] text-ink-soft">Every event</p>
        </div>
        <div>
          <p className="text-[12.5px] font-bold text-ink">{`Last ${log.length} deliveries`}</p>
          <ul className="mt-1 min-w-0 divide-y divide-line text-[12.5px]">
            {log.map((d) => (
              <li key={d.type} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2">
                <span className="min-w-0">
                  <span className="font-mono font-semibold text-ink">{d.type}</span>
                  <span className="text-ink-soft">{` · ${d.when}`}</span>
                </span>
                <span className={`shrink-0 text-[12px] font-semibold ${d.ok ? "text-mint-deep" : "text-ink-soft"}`}>{d.result}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Window>
  );
}

/** The studio's calendars card (components/calendar-editor.tsx): a calendar read for busy times, and the bookings feed. */
function CalendarVisual() {
  return (
    <Window bar="Your calendars">
      <div className="space-y-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[13px] font-bold text-ink">Your calendars</p>
          <span className="tag tag-live">{`1 of ${MAX_FEEDS} read`}</span>
        </div>
        <div className="flex items-center gap-2.5 rounded-[var(--r-md)] bg-paper px-3.5 py-3 ring-1 ring-line">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-mint-brand" />
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-ink">Google Calendar</span>
            <span className="block break-words text-[12px] text-ink-soft">{`Read 4 min ago · 12 busy times in the next ${LOOKAHEAD_DAYS} days · added Oct 20, 2026`}</span>
          </span>
        </div>
        <div className="rounded-[var(--r-md)] border border-line px-3.5 py-3">
          <p className="break-words text-[13px] font-semibold text-ink">Your bookings in your calendar</p>
          <span className="btn btn-secondary btn-sm pointer-events-none mt-2">Copy address</span>
        </div>
      </div>
    </Window>
  );
}

/** The studio's Discord page (components/discord-studio.tsx): which products give which roles, each role a pill. */
function DiscordVisual() {
  const rows = [
    { product: "Supper club", roles: [{ name: "Members", on: true }, { name: "Students", on: false }] },
    { product: "Batch cooking, the course", roles: [{ name: "Members", on: true }, { name: "Students", on: true }] },
  ];
  return (
    <Window bar="Discord">
      <div className="space-y-3 p-5">
        <p className="text-[13px] font-bold text-ink">Which products give which roles</p>
        <p className="text-[12px] text-ink-soft">{`Up to ${MAX_PRODUCT_ROLES} roles for each product, on up to ${MAX_DISCORD_PRODUCTS} products.`}</p>
        {rows.map((row) => {
          const given = row.roles.filter((r) => r.on).length;
          return (
            <div key={row.product} className="rounded-[var(--r-sm)] border border-line p-3">
              <p className="break-words text-[13px] font-semibold text-ink">{row.product}</p>
              <p className="text-[12px] text-ink-soft">{`Gives ${given} ${given === 1 ? "role" : "roles"}.`}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {row.roles.map((role) => (
                  <span key={role.name} className={`rounded-full border px-2.5 py-1 text-[12px] ${role.on ? "border-violet-brand bg-lilac text-ink" : "border-line text-ink-soft"}`}>
                    {role.name}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Window>
  );
}

/** The studio's community card (components/community-studio.tsx): switched on, its three counts, the way in. */
function CommunityVisual() {
  const tiles = [
    { n: "48", label: "have come in" },
    { n: "112", label: "posts" },
    { n: "31", label: "want the community's emails" },
  ];
  return (
    <Window bar="Community">
      <div className="space-y-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[13px] font-bold text-ink">Your community</p>
          <span className="tag tag-live">On</span>
        </div>
        <p className="break-words text-[12.5px] text-ink-soft">Open to everyone who holds one of the products you chose below. Your store page shows the way in.</p>
        <div className="grid grid-cols-3 gap-1.5 text-center">
          {tiles.map((t) => (
            <div key={t.label} className="min-w-0 rounded-[var(--r-sm)] bg-sand px-1 py-2.5">
              <p className="text-[16px] font-semibold tabular-nums text-ink">{t.n}</p>
              <p className="break-words text-[10.5px] text-ink-soft">{t.label}</p>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="btn btn-secondary btn-sm pointer-events-none">Switch it off</span>
          <span className="btn btn-ghost btn-sm pointer-events-none">Open it</span>
        </div>
      </div>
    </Window>
  );
}

/** One affiliate in the studio (components/affiliate-studio.tsx, Member): address, link code, status, and the five tiles. */
function AffiliatesVisual() {
  const tiles = [
    { label: "Clicks", value: "120" },
    { label: "Sales", value: "6" },
    { label: "Earned", value: formatMoney(5_940, "usd") },
    { label: "Paid", value: formatMoney(3_000, "usd") },
    { label: "Owed", value: formatMoney(5_940 - 3_000, "usd"), strong: true },
  ];
  return (
    <Window bar="Affiliates">
      <div className="space-y-3 p-5">
        <p className="text-[13px] font-bold text-ink">Your affiliates</p>
        <div className="rounded-2xl border border-line p-3.5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <span className="min-w-0">
              <span className="block break-all text-[13px] font-semibold text-ink">ana@example.com</span>
              <span className="block font-mono text-[11.5px] text-ink-soft">?via=ana</span>
            </span>
            <span className="tag tag-live">Approved</span>
          </div>
          <div className="mt-2.5 grid grid-cols-3 gap-1.5 text-center sm:grid-cols-5">
            {tiles.map((t) => (
              <div key={t.label} className={`min-w-0 rounded-xl px-1.5 py-1.5 ${t.strong ? "bg-lilac" : "bg-paper"}`}>
                <p className="text-[10px] font-bold uppercase tracking-[0.06em] text-ink-mute">{t.label}</p>
                <p className={`text-[12.5px] font-semibold tabular-nums ${t.strong ? "text-violet-ink" : "text-ink"}`}>{t.value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Window>
  );
}

/**
 * The community's live events in the studio (components/community-events-studio.tsx,
 * EventRow): what is coming up, its places beside its title, when (in the
 * studio's own eventTime and lengthWords), where and for whom. Server only, as
 * every card here: lib/community-events.ts reads the store.
 */
function EventsVisual() {
  const events = [
    { title: "Monthly cook-along", start: Date.UTC(2026, 10, 10, 23), minutes: 60, where: "Private video room · every member", places: "12 of 30 places taken" },
    { title: "Q&A: your freezer questions", start: Date.UTC(2026, 10, 19, 17), minutes: 45, where: "Your meeting link · only for buyers of Batch Cooking Basics", places: "8 going" },
  ];
  return (
    <Window bar="Live events">
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] font-bold text-ink">Live events</p>
          <span className="tag tag-brand">{`${events.length} coming up`}</span>
        </div>
        <p className="text-[11.5px] font-bold uppercase tracking-[0.06em] text-ink-soft">Coming up</p>
        <ul className="min-w-0 space-y-2">
          {events.map((e) => (
            <li key={e.title} className="rounded-[var(--r-md)] border border-line p-3">
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5">
                <p className="min-w-0 break-words text-[13px] font-semibold text-ink">{e.title}</p>
                <p className="text-[12px] font-semibold text-ink">{e.places}</p>
              </div>
              <p className="break-words text-[12px] text-ink-soft">{`${eventTime({ start: e.start, tz: "America/New_York" })} · ${lengthWords(e.minutes)}`}</p>
              <p className="break-words text-[12px] text-ink-soft">{e.where}</p>
            </li>
          ))}
        </ul>
        <p className="break-words text-[12px] text-ink-soft">{`The way in shows ${JOIN_EARLY_MINUTES} minutes before the start, only to members who can come.`}</p>
      </div>
    </Window>
  );
}

/** The studio's team page (components/team-manager.tsx): the places used, the owner, a member with a role, an invitation waiting, and the invite form. */
function TeamVisual() {
  return (
    <Window bar="Team">
      <div className="space-y-2 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[13px] font-bold text-ink">People on this store</p>
          <span className="text-[12px] tabular-nums text-ink-soft">{`2 of ${MAX_TEAM} places used`}</span>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-2 rounded-[var(--r-md)] border border-line p-3">
          <span className="min-w-0">
            <span className="block break-all text-[13px] font-semibold text-ink">you@example.com</span>
            <span className="block text-[12px] text-ink-soft">You. Everything, including the plan, payments and the team.</span>
          </span>
          <span className="tag">Owner</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-md)] border border-line p-3">
          <span className="min-w-0">
            <span className="block break-all text-[13px] font-semibold text-ink">sam@example.com</span>
            <span className="block text-[12px] text-ink-soft">Joined Oct 3, 2026</span>
          </span>
          <span className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1 rounded-[var(--r-sm)] border border-line-strong px-2.5 py-1 text-[12px] font-semibold text-ink">
              {ROLE_NAMES.editor}
              <Icon name="chevron-down" size={14} />
            </span>
            <span className="text-[12px] font-bold text-ink-soft underline underline-offset-4">Remove</span>
          </span>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-2 rounded-[var(--r-md)] border border-line p-3">
          <span className="min-w-0">
            <span className="block break-all text-[13px] font-semibold text-ink-soft">lee@example.com</span>
            <span className="block text-[12px] text-ink-soft">{`Invited as ${ROLE_NAMES.support} · the link works until Nov 8`}</span>
          </span>
          <span className="tag tag-next">Waiting</span>
        </div>
        <div className="rounded-[var(--r-md)] bg-paper p-3 ring-1 ring-line">
          <p className="text-[13px] font-semibold text-ink">Invite someone</p>
          <p className="mt-1 text-[11.5px] font-semibold text-ink-soft">Their email</p>
          <p className="mt-0.5 break-all rounded-[var(--r-sm)] border border-line bg-white px-2.5 py-1.5 text-[12.5px] text-ink">kim@example.com</p>
          <span className="btn btn-primary btn-sm pointer-events-none mt-2">
            <Icon name="mail" size={16} />
            Send the invitation
          </span>
        </div>
      </div>
    </Window>
  );
}

/** Connecting an email platform in the studio (components/email-sync-editor.tsx), before anything is connected: the platform, its key, Connect. */
function EmailPlatformsVisual() {
  const platforms = [
    { name: "Mailchimp", target: "an audience", on: true },
    { name: "Kit", target: "a form", on: false },
    { name: "beehiiv", target: "a publication", on: false },
    { name: "MailerLite", target: "a group", on: false },
  ];
  return (
    <Window bar="Email platforms">
      <div className="space-y-3 p-5">
        <p className="text-[13px] font-bold text-ink">Connect your email platform</p>
        <p className="text-[12px] font-semibold text-ink-soft">Platform</p>
        <div className="grid grid-cols-2 gap-2">
          {platforms.map((p) => (
            <div key={p.name} className={`flex min-w-0 items-start gap-2 rounded-[var(--r-sm)] border p-2.5 ${p.on ? "border-violet-brand bg-lilac" : "border-line"}`}>
              <span className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border ${p.on ? "border-[5px] border-violet-brand" : "border-line-strong"}`} />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-semibold text-ink">{p.name}</span>
                <span className="block break-words text-[11.5px] text-ink-soft">{`Adds to ${p.target}`}</span>
              </span>
            </div>
          ))}
        </div>
        <div>
          <p className="text-[12px] font-semibold text-ink-soft">Mailchimp API key</p>
          <p className="mt-0.5 break-words rounded-[var(--r-sm)] border border-line bg-white px-2.5 py-1.5 text-[12px] text-ink-mute">Your Mailchimp API key (ends in -us21 or similar)</p>
        </div>
        <span className="btn btn-primary btn-sm pointer-events-none">Connect</span>
      </div>
    </Window>
  );
}

/**
 * A page of a stamped PDF as a buyer downloads it, with the one line
 * lib/pdf-stamp.ts prints along its bottom (Helvetica, gray, shrunk to fit
 * on one line), and, apart, the product's switch in the studio
 * (components/pdf-stamp-toggle.tsx): the buyer never sees the switch.
 */
function StampVisual() {
  const line = stampLine("maya@example.com", "cs_test_a1E54F2A", new Date(Date.UTC(2026, 8, 26)));
  return (
    <Window bar="Your workbook, as a buyer downloads it">
      <div className="space-y-3 p-5">
        <div className="rounded-[var(--r-sm)] border border-line bg-white p-4 shadow-sm" style={{ containerType: "inline-size" }}>
          <p className="text-[13px] font-semibold text-ink">Week 1: the plan</p>
          <div className="mt-2 space-y-1.5">
            {[100, 92, 96, 70, 88, 60].map((w, i) => (
              <span key={i} className="block h-1.5 rounded-full bg-sand" style={{ width: `${w}%` }} />
            ))}
          </div>
          <p className="mt-4 whitespace-nowrap font-sans text-ink-soft" style={{ fontSize: "min(8px, 2.3cqi)" }}>{line}</p>
        </div>
        <div className="border-t border-line pt-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-mute">In the studio, on the product</p>
          <p className="mt-1.5 flex items-start gap-2 text-[12.5px] font-semibold text-ink">
            <span className="mt-0.5 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] bg-violet-brand text-white"><Icon name="check" size={10} strokeWidth={3} /></span>
            <span className="min-w-0 break-words">Stamp each buyer&apos;s email on every page of the PDF</span>
          </p>
          <p className="mt-1 break-words text-[12px] text-ink-soft">It makes a shared copy traceable to its buyer; it cannot stop anyone from sharing.</p>
        </div>
      </div>
    </Window>
  );
}

/** The studio's "Ways to pay" card (components/payments-panel.tsx): what the creator's own Stripe has switched on, by group, and the store's currency. */
function WaysVisual() {
  const groups = [
    { title: "Cards and wallets", ways: ["Cards", "Apple Pay", "Google Pay", "Link"], note: "Apple Pay and Google Pay pay with a card; Link fills in Stripe's saved details." },
    { title: "Pay later", ways: ["Klarna", "Affirm"], note: "The buyer pays in installments; you are paid in full." },
  ];
  return (
    <Window bar="Ways to pay">
      <div className="space-y-3 p-5">
        <p className="text-[13px] font-bold text-ink">Ways to pay</p>
        {groups.map((g) => (
          <div key={g.title}>
            <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-mute">{g.title}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {g.ways.map((w) => (
                <span key={w} className="inline-flex items-center gap-1 rounded-full bg-mint-soft px-2.5 py-0.5 text-[12px] font-semibold text-mint-deep">
                  <Icon name="check" size={12} />
                  {w}
                </span>
              ))}
            </div>
            <p className="mt-1 break-words text-[11.5px] text-ink-soft">{g.note}</p>
          </div>
        ))}
        <div className="border-t border-line pt-3">
          <p className="text-[12px] font-semibold text-ink-soft">Your store&apos;s currency</p>
          <p className="mt-0.5 flex items-center justify-between gap-2 rounded-[var(--r-sm)] border border-line-strong px-2.5 py-1.5 text-[12.5px] font-semibold text-ink">
            {currencyLabel("usd")}
            <Icon name="chevron-down" size={14} />
          </p>
        </div>
      </div>
    </Window>
  );
}

/** The studio's "This device" card (components/phone-alerts-panel.tsx): notifications on, what to tell this device about, and a test. */
function PhoneVisual() {
  const kinds = [
    { label: "Sales", hint: "Every paid order: the amount and what was bought", on: true },
    { label: "Bookings", hint: "A call or a seat booked: what, when, and what was paid", on: true },
    { label: "Community reports", hint: "A member reported a post or a comment", on: true },
    { label: "Live events", hint: "A community live event starts in 15 minutes", on: false },
  ];
  return (
    <Window bar="Phone notifications">
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] font-bold text-ink">This device</p>
          <span className="tag tag-live">Notifications on</span>
        </div>
        <p className="text-[12px] font-semibold text-ink-soft">Tell this device about</p>
        <ul className="min-w-0 space-y-2">
          {kinds.map((k) => (
            <li key={k.label} className="flex items-start gap-2 text-[12.5px]">
              <span className={`mt-0.5 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] ${k.on ? "bg-violet-brand text-white" : "border border-line-strong"}`}>
                {k.on ? <Icon name="check" size={10} strokeWidth={3} /> : null}
              </span>
              <span className="min-w-0">
                <span className="block font-semibold text-ink">{k.label}</span>
                <span className="block break-words text-[11.5px] text-ink-soft">{k.hint}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <span className="btn btn-primary btn-sm pointer-events-none">
            <Icon name="phone" size={14} />
            Send a test
          </span>
          <span className="btn btn-secondary btn-sm pointer-events-none">Turn off on this device</span>
        </div>
      </div>
    </Window>
  );
}

/**
 * The studio's own sign-in protections (components/passkey-manager.tsx and
 * components/two-step-manager.tsx, in the studio's account card): a passkey
 * kept, and two-step login on with its buttons, in their own words; the
 * recovery address masked as hideAddress (lib/recovery-address.ts) does. The count of recovery codes is the code's
 * (RECOVERY_CODES in lib/two-step.ts, held by the test, not imported here:
 * that module reaches Redis and email).
 */
function SecurityVisual() {
  return (
    <Window bar="Studio · Account">
      <div className="space-y-3 p-5">
        <div>
          <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <Icon name="key" size={15} className="text-violet-deep" />
            Passkeys
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[var(--r-md)] px-3 py-2.5 ring-1 ring-line">
            <span className="min-w-0">
              <span className="block break-words text-[13px] font-semibold text-ink">iPhone</span>
              <span className="block break-words text-[11.5px] text-ink-soft">Added Oct 12, 2026 · last used Oct 30, 2026 · synced across your devices</span>
            </span>
            <span className="text-[12px] font-bold text-ink-soft underline underline-offset-4">Remove</span>
          </div>
        </div>
        <div className="border-t border-line pt-3">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <Icon name="lock" size={15} className="text-violet-deep" />
            Two-step login
          </p>
          <p className="mt-1.5 break-words text-[12px] text-ink-soft">On. Logging in with the emailed link also asks for the code in your authenticator app; a passkey needs no code. 10 recovery codes left. Lose your phone and your codes, and a link to your recovery address, m•••@e•••.com, lets you back in.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="btn btn-secondary btn-sm pointer-events-none">New recovery codes</span>
            <span className="btn btn-secondary btn-sm pointer-events-none">Turn it off</span>
          </div>
        </div>
      </div>
    </Window>
  );
}

/**
 * Part of a product's sales page in the studio's editor
 * (components/page-editor.tsx), on a saved page that is live: its heading and
 * count, the Built tag, the row with Build or Preview, Undo and Redo and the
 * live page's link, then the list of blocks. Between them the editor also
 * shows the page's coach and its test of a second version, left out here and
 * marked by the break. Each block's row is "N. Label" over the editor's
 * summary shape, with its move, duplicate and remove buttons (a hero is not
 * duplicated, and it stays first), "Add here" between two rows, and the add
 * button's count against MAX_BLOCKS. Icons from KIND_ICONS, labels from
 * BLOCK_KINDS. Save the page sits further down, off while nothing changed.
 */
export const SALES_PAGE_EXAMPLE = {
  product: "Knife skills at home",
  blocks: [
    { kind: "hero", line: "Hold, slice and sharpen a kitchen knife" },
    { kind: "benefits", line: "What you get · 5 items" },
    { kind: "inside", line: "6 items" },
    { kind: "fit", line: "3 for, 2 not for" },
    { kind: "faq", line: "4 items" },
    { kind: "cta", line: "Get the course" },
  ] satisfies { kind: BlockKind; line: string }[],
};

const kindLabel = (kind: BlockKind) => BLOCK_KINDS.find((k) => k.kind === kind)?.label ?? kind;

function SalesPageVisual() {
  const { product, blocks } = SALES_PAGE_EXAMPLE;
  const action = "grid h-6 w-6 shrink-0 place-items-center text-ink-soft";
  return (
    <Window bar="Studio · Sales pages">
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="break-words text-[13px] font-bold text-ink">{`Sales page for ${product}`}</p>
            <p className="text-[12px] text-ink-soft">{`${blocks.length} blocks live on its page.`}</p>
          </div>
          <span className="tag tag-live">Built</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex rounded-full bg-paper p-1 ring-1 ring-line">
            <span className="rounded-full bg-white px-3 py-1 text-[12px] font-semibold text-ink shadow-sm ring-1 ring-line">Build</span>
            <span className="px-3 py-1 text-[12px] font-semibold text-ink-soft">Preview</span>
          </span>
          <span className="inline-flex gap-1">
            <span className="grid h-7 w-7 place-items-center rounded-full text-ink-soft opacity-35 ring-1 ring-line"><Icon name="undo" size={14} /></span>
            <span className="grid h-7 w-7 place-items-center rounded-full text-ink-soft opacity-35 ring-1 ring-line"><Icon name="redo" size={14} /></span>
          </span>
          <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-violet-deep">
            Open the live page
            <Icon name="external" size={13} />
          </span>
        </div>
        <p className="border-t-2 border-dashed border-line pt-1 text-center text-[11px] text-ink-mute">⋯</p>
        <ol className="min-w-0">
          {blocks.map((b, i) => (
            <li key={b.kind} className="min-w-0">
              <div className="flex min-w-0 items-center gap-2 rounded-2xl border border-line bg-white p-1.5 pl-2">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-lilac text-violet-deep">
                  <Icon name={KIND_ICONS[b.kind]} size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-semibold text-ink">{`${i + 1}. ${kindLabel(b.kind)}`}</span>
                  <span className="block truncate text-[11px] text-ink-soft">{b.line}</span>
                </span>
                <span className={`${action} ${i <= 1 ? "opacity-30" : ""}`}><Icon name="chevron-down" size={13} className="rotate-180" /></span>
                <span className={`${action} ${i === blocks.length - 1 ? "opacity-30" : ""}`}><Icon name="chevron-down" size={13} /></span>
                {b.kind === "hero" ? null : <span className={action}><Icon name="copy" size={12} /></span>}
                <span className={action}><Icon name="trash" size={12} /></span>
              </div>
              {i < blocks.length - 1 ? (
                <div className="flex h-7 items-center justify-center">
                  <span className="inline-flex h-5 items-center gap-1 rounded-full bg-white px-2 text-[10.5px] font-semibold text-ink-soft ring-1 ring-line">
                    <Icon name="plus" size={11} />
                    Add here
                  </span>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
        <p className="flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line-strong p-2.5 text-[12.5px] font-semibold text-ink-soft">
          <Icon name="plus" size={15} />
          {`Add a block (${blocks.length} of ${MAX_BLOCKS})`}
        </p>
      </div>
    </Window>
  );
}

/**
 * The writing help as the sales page editor opens it (components/ai-assist.tsx,
 * with page-editor.tsx's title, hint and placeholder): the button, the jobs
 * left this month (an example; the test holds it under Studio's AI_MONTHLY) and the
 * line under it, word for word.
 */
export const AI_LEFT_EXAMPLE = 37;

function AiWritingVisual() {
  const product = SALES_PAGE_EXAMPLE.product;
  const left = AI_LEFT_EXAMPLE;
  return (
    <Window bar="Studio · Sales pages">
      <div className="p-5">
        <div className="rounded-2xl border border-violet-brand/25 bg-lilac/40 px-4 py-3">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-violet-deep">
            <Icon name="sparkle" size={15} />
            Write the whole page with AI
          </p>
          <div className="mt-2 space-y-2.5">
            <p className="break-words text-[12px] text-ink-soft">{`A full draft — headline, what the buyer gets, what is inside, questions and buttons — from ${product}'s name, price and description. Add anything else it should know below, or leave the box empty. It replaces the blocks here; nothing is saved until you press Save.`}</p>
            <p className="field min-h-16 break-words text-[12px] text-ink-mute">Who it is for, what makes it different, what buyers ask you most. Your refund promise, if you have one.</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="btn btn-secondary btn-sm pointer-events-none">Write a draft</span>
              <span className="text-[11.5px] text-ink-soft">{`${left} left this month. Started attempts count, even if they fail.`}</span>
            </div>
            <p className="break-words text-[11.5px] text-ink-soft">It uses only your own words, here and in your store, never invents reviews, numbers, results or deadlines, and saves nothing until you do. Read it before you publish: it is yours.</p>
          </div>
        </div>
      </div>
    </Window>
  );
}

/**
 * Part of the deals board in the studio (components/deals-board.tsx), as the
 * store's owner sees it on a paid Store plan, on the store's first pipeline
 * with the stages it starts with (DEFAULT_STAGES): the heading and its
 * sentence, summed from the deals drawn; the pipeline's button with its open
 * count; New pipeline, since that plan keeps more than one (pipelineLimit);
 * then, after a break where the board shows its totals and filters, the first
 * two stages' columns, each with its count and total and its deals as the
 * board writes them, Request payment on a deal with an email (the owner may
 * send). Three more stages follow on the board. The deals, people and
 * amounts are an example.
 */
export const CRM_EXAMPLE = [
  { stage: "lead00", title: "A logo for a bakery", cents: 60_000, email: "sam@example.com" },
  { stage: "talk00", title: "Six coaching sessions for Dana", cents: 120_000, nextAction: "Follow up on the proposal" },
] satisfies (Pick<Deal, "stage" | "title" | "cents"> & Partial<Pick<Deal, "email" | "nextAction">>)[];

/** The Store plan, paid and out of its trial, as the board's page counts its pipelines. */
export const CRM_PIPELINES = pipelineLimit({ tier: "creator", subscriptionActive: true, trialEnds: 0 });

function CrmVisual() {
  const money = (cents: number) => formatMoney(cents, "usd");
  const openIds = new Set(DEFAULT_STAGES.filter((s) => s.kind === "open").map((s) => s.id));
  const wonIds = new Set(DEFAULT_STAGES.filter((s) => s.kind === "won").map((s) => s.id));
  const open = CRM_EXAMPLE.filter((d) => openIds.has(d.stage));
  const won = CRM_EXAMPLE.filter((d) => wonIds.has(d.stage));
  const sum = (ds: readonly { cents: number }[]) => ds.reduce((n, d) => n + d.cents, 0);
  return (
    <Window bar="Studio · Deals">
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[13px] font-bold text-ink">Deals</p>
            <p className="break-words text-[12px] text-ink-soft">{`People you are talking to about something sold outside a checkout: a coaching package, a custom project. ${open.length} open, worth ${money(sum(open))}; won so far, ${money(sum(won))}.`}</p>
          </div>
          <span className="btn btn-primary pointer-events-none">
            <Icon name="plus" size={18} />
            New deal
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="btn btn-primary btn-sm pointer-events-none">
            {FIRST_PIPELINE_NAME}
            <span className="tabular-nums opacity-80">{` · ${open.length} open`}</span>
          </span>
          {CRM_PIPELINES > 1 ? (
            <span className="btn btn-ghost btn-sm pointer-events-none">
              <Icon name="plus" size={14} />
              New pipeline
            </span>
          ) : null}
        </div>
        <p className="border-t-2 border-dashed border-line pt-1 text-center text-[11px] text-ink-mute">⋯</p>
        {DEFAULT_STAGES.slice(0, 2).map((stage) => {
          const here = CRM_EXAMPLE.filter((d) => d.stage === stage.id);
          return (
            <div key={stage.id} className="min-w-0 rounded-2xl bg-paper p-3 ring-1 ring-line">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[12.5px] font-semibold text-ink">{stage.name}</p>
                <p className="text-[12px] tabular-nums text-ink-soft">{`${here.length} · ${money(sum(here))}`}</p>
              </div>
              {here.map((deal) => (
                <div key={deal.title} className="mt-2 rounded-xl bg-white p-2.5 text-[12px] ring-1 ring-line">
                  <p className="break-words font-semibold text-ink">{deal.title}</p>
                  <p className="mt-0.5 tabular-nums text-ink-soft">{money(deal.cents)}</p>
                  {"email" in deal ? <p className="mt-0.5 break-all text-ink-soft">{deal.email}</p> : null}
                  {"nextAction" in deal ? <p className="mt-1.5 font-semibold text-ink">{`Next: ${deal.nextAction}`}</p> : null}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="min-w-0 flex-1 basis-24 rounded-[var(--r-sm)] px-2 py-1 text-[12px] text-ink ring-1 ring-line">{stage.name}</span>
                    <span className="btn btn-secondary btn-sm pointer-events-none">Edit</span>
                    <span className="btn btn-secondary btn-sm pointer-events-none">
                      <Icon name="minus" size={14} />
                    </span>
                    {"email" in deal ? (
                      <span className="btn btn-secondary btn-sm pointer-events-none">
                        <Icon name="receipt" size={14} /> Request payment
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </Window>
  );
}

/**
 * Part of one pitch, a draft, from the list at the foot of the studio's
 * Outreach page (components/outreach-studio.tsx), for the demo store
 * (lib/house-store.ts), which has no domain of its own: the business and the
 * address, the Draft tag, where the address was printed and the day it was
 * read, the subject and the creator's words in the shape the writing help is
 * asked for (lib/ai.ts, writePitch), the lines the code's own pitchFooter
 * adds for the United States with the stop link shortened, the three ways to
 * open it, the line that nothing is sent from here, and I sent it or Delete
 * this draft. The sender is the store's own name, as readSender falls back to;
 * the business, the postal address and the words are an example.
 */
export const OUTREACH_EXAMPLE = {
  company: "Ashgrove Cookware",
  to: "partnerships@ashgrovecookware.example",
  page: "https://ashgrovecookware.example/contact",
  read: "October 28, 2026",
  subject: "A sponsored weeknight recipe with your skillet",
  body: "I'm Jenny, and I write simple family meal plans at Harbor Kitchen.\n\nYour site says your pans are made for everyday home cooking. I would like to make one weeknight recipe video with your skillet, as a paid sponsorship.\n\nWould a short call next week work for you?",
  sender: { name: "Harbor Kitchen", address: "123 Example Street, Portland, ME 04101, United States" },
  storeUrl: `${SITE_URL}/@${HOUSE_HANDLE}`,
  stopUrl: `${SITE_URL}/outreach/stop/…`,
};

function OutreachVisual() {
  const o = OUTREACH_EXAMPLE;
  const us = OUTREACH_COUNTRIES.find((c) => c.code === "US");
  const footer = us ? pitchFooter({ sender: o.sender, storeUrl: o.storeUrl, page: o.page, country: us, stopUrl: o.stopUrl }) : "";
  return (
    <Window bar="Studio · Outreach">
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[13px] font-bold text-ink">{o.company}</p>
            <p className="break-all text-[12px] text-ink-soft">{o.to}</p>
          </div>
          <span className="tag">Draft</span>
        </div>
        <p className="break-all text-[11px] text-ink-soft">{`Address printed on their own website, read ${o.read}: ${o.page}`}</p>
        <div>
          <p className="field-label">Subject</p>
          <p className="field mt-1 break-words text-[12px]">{o.subject}</p>
        </div>
        <div>
          <p className="field-label">Your email. Read it and make it yours before you send it</p>
          <p className="field mt-1 whitespace-pre-wrap break-words text-[12px]">{o.body}</p>
        </div>
        <div>
          <p className="field-label">Added under it on every email, as the law asks</p>
          <p className="mt-1 whitespace-pre-wrap break-words rounded-xl bg-sand p-2.5 text-[11px] text-ink-soft">{footer}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="btn btn-primary btn-sm pointer-events-none">Open it in Gmail</span>
          <span className="btn btn-secondary btn-sm pointer-events-none">Open it in my mail app</span>
          <span className="btn btn-secondary btn-sm pointer-events-none">Copy it</span>
        </div>
        <p className="text-[11px] text-ink-soft">Each of these opens a draft in your own mailbox. Nothing is sent until you press Send there, and nothing is ever sent from here.</p>
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <span className="btn btn-secondary btn-sm pointer-events-none">I sent it</span>
          <span className="btn btn-ghost btn-sm pointer-events-none">Delete this draft</span>
        </div>
      </div>
    </Window>
  );
}

/**
 * One of "Your last imports" in the studio (app/studio/import/page.tsx,
 * PastImports, with components/import-tool.tsx's ImportProgress, compact): an
 * email list brought in from a spreadsheet and finished, its file, its day in
 * UTC and its rows, the four counts in the tool's words for a list, which add
 * up to the rows (within a month of the Store plan, IMPORT_ALLOWANCES), and
 * the link to the rows that were not brought in. The file, the day and the
 * counts are an example.
 */
export const IMPORT_EXAMPLE = {
  file: "newsletter-subscribers.csv",
  at: Date.UTC(2026, 9, 30, 14, 5),
  counts: { added: 912, already: 41, skipped: 12, errors: 3 },
};

function ImportDoneVisual() {
  const { file, at, counts } = IMPORT_EXAMPLE;
  const rows = counts.added + counts.already + counts.skipped + counts.errors;
  const words = IMPORT_WORDS.contacts;
  const tiles = [
    { label: words.added, n: counts.added, tone: "bg-mint-soft", text: "text-mint-deep" },
    { label: words.already, n: counts.already, tone: "bg-paper", text: "text-ink-soft" },
    { label: IMPORT_LEFT_WORDS.skipped, n: counts.skipped, tone: "bg-paper", text: "text-ink-soft" },
    { label: IMPORT_LEFT_WORDS.errors, n: counts.errors, tone: counts.errors ? "bg-danger-soft" : "bg-paper", text: counts.errors ? "text-danger" : "text-ink-soft" },
  ];
  return (
    <Window bar="Studio · Import">
      <div className="space-y-2 p-5">
        <p className="text-[13px] font-bold text-ink">Your last imports</p>
        <p className="break-all text-[12.5px] font-semibold text-ink">{`Your email list: ${file}`}</p>
        <p className="text-[11.5px] text-ink-soft">{`${IMPORT_DATE.format(new Date(at))} UTC · ${rows.toLocaleString("en-US")} rows`}</p>
        <div className="rounded-2xl bg-white p-3.5 ring-1 ring-line">
          <p className="text-[12.5px] font-semibold text-ink">Finished</p>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {tiles.map((t) => (
              <div key={t.label} className={`min-w-0 rounded-xl px-2.5 py-1.5 ${t.tone}`}>
                <p className={`break-words text-[10.5px] font-semibold ${t.text}`}>{t.label}</p>
                <p className="text-[13px] font-bold tabular-nums text-ink">{t.n.toLocaleString("en-US")}</p>
              </div>
            ))}
          </div>
          {counts.errors + counts.skipped > 0 ? (
            <p className="mt-2.5 flex items-center gap-1.5 text-[12px] font-bold text-violet-deep underline underline-offset-4">
              <Icon name="download" size={13} />
              Download the rows that were not brought in
            </p>
          ) : null}
        </div>
      </div>
    </Window>
  );
}

/**
 * Part of the dry run of a products file exported from ClickFunnels
 * (components/import-tool.tsx, DryRunReport): its heading and sentence, a tile
 * for each outcome that has rows (and always the first), in the tool's words
 * for products, the rows worth a look with the notes the server writes for
 * them (lib/imports.ts), and the link to every row; the buttons to check it
 * again or import it sit under it. The products and counts are an example.
 */
export const DRY_RUN_EXAMPLE = {
  counts: { added: 12, already: 1, skipped: 1, error: 0 } as Partial<Record<Outcome, number>>,
  rows: [
    { line: 4, outcome: "already", note: "A product with this title is already in your store: no copy is made", value: "Weeknight dinners" },
    { line: 9, outcome: "skipped", note: "The same title as row 6", value: "Batch cooking basics" },
  ] satisfies { line: number; outcome: Outcome; note: string; value: string }[],
};

function DryRunVisual() {
  const words = OUTCOME_WORDS.products;
  const { counts, rows } = DRY_RUN_EXAMPLE;
  const shown = (Object.keys(words) as Outcome[]).filter((o) => (counts[o] ?? 0) > 0 || o === "added");
  return (
    <Window bar="Studio · Move from ClickFunnels">
      <div className="space-y-2.5 p-5">
        <p className="text-[13px] font-bold text-ink">Dry run: what this file will do</p>
        <p className="break-words text-[11.5px] text-ink-soft">Every row was checked the way the import checks it, against your store as it is now. Nothing was saved. The import checks every row again when it runs.</p>
        <div className="grid grid-cols-2 gap-1.5">
          {shown.map((o) => (
            <div key={o} className={`min-w-0 rounded-xl px-2.5 py-1.5 ${o === "added" ? "bg-mint-soft" : o === "error" ? "bg-danger-soft" : "bg-paper"}`}>
              <p className={`break-words text-[10.5px] font-semibold ${o === "added" ? "text-mint-deep" : o === "error" ? "text-danger" : "text-ink-soft"}`}>{words[o]}</p>
              <p className="text-[13px] font-bold tabular-nums text-ink">{(counts[o] ?? 0).toLocaleString("en-US")}</p>
            </div>
          ))}
        </div>
        <table className="w-full table-fixed text-left text-[10.5px]">
          <caption className="text-left text-[11px] font-bold text-ink-soft">Rows worth a look</caption>
          <thead>
            <tr className="text-ink-mute">
              <th className="w-8 px-1 py-1 font-semibold">Row</th>
              <th className="w-[24%] px-1 py-1 font-semibold">Becomes</th>
              <th className="px-1 py-1 font-semibold">Why</th>
              <th className="w-[24%] px-1 py-1 font-semibold">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.line} className="border-t border-line align-top">
                <td className="px-1 py-1 tabular-nums text-ink-mute">{r.line}</td>
                <td className="break-words px-1 py-1 text-ink">{words[r.outcome]}</td>
                <td className="break-words px-1 py-1 text-ink-soft">{r.note}</td>
                <td className="break-words px-1 py-1 text-ink">{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="flex items-center gap-1.5 text-[12px] font-bold text-violet-deep underline underline-offset-4">
          <Icon name="download" size={13} />
          Download the dry run, every row
        </p>
      </div>
    </Window>
  );
}

const CAPTIONS: Record<VisualKey, string> = {
  store: "A store page, drawn from the demo store you can open and buy from.",
  options: "The buyer is charged the price they picked, as the creator saved it.",
  delivery: "What the buyer sees after paying, and how they get it back later.",
  stripe: "Illustration for Store, before Stripe processing fees; paid plans are not on sale yet.",
  course: "A student's view of a course, with a module that opens on a later day.",
  membership: "A membership on a store page, with the way out under it.",
  calls: "Booking a paid call. Dates and times are an example.",
  checkout: "Check the box to add it: the total on the button changes with it.",
  email: "Writing to your list from the studio. The subject and steps are an example.",
  domain: "A store on its own domain, with the one record to add.",
  insights: "The numbers screen in the studio. The bars are an example, not our figures.",
  funnels: "The kinds of funnel the studio starts from, read from its own list.",
  bundles: "The bundle editor in the studio. The products and their prices are an example.",
  quizzes: "A lesson's quiz and the course's certificate. The lesson and its question are an example.",
  keys: "The license key editor. The key, the buyer and the order are an example. Keys made here are new for each sale.",
  webhooks: "Webhooks in the studio. The address, the times and the deliveries are an example.",
  calendar: "Your calendars in the studio. The calendar and its busy times are an example.",
  discord: "The Discord page in the studio. The products and roles are an example.",
  community: "Your community in the studio. The counts are made up as an example, not real figures.",
  affiliates: "One affiliate in the studio. The person and every figure are made up as an example, not anyone's real results.",
  events: "Live events in the studio. The events, dates and counts are made up as an example.",
  team: "The team page in the studio. The people and the dates are made up as an example.",
  emailPlatforms: "Connecting an email platform in the studio, before anything is connected. The platform picked is an example.",
  stamp: "A page of a stamped PDF, with the line every page carries, and the product's switch in the studio. The workbook, the buyer and the order are made up as an example.",
  ways: "Ways to pay in the studio. Which ways show depends on what is switched on in each creator's own Stripe account; these are an example.",
  phone: "Phone notifications in the studio, as a Support team member sees them: each person is offered only what their role may hear. The choices checked are an example.",
  security: "Passkeys and two-step login in the studio's account card. The device, the dates and the recovery address are made up as an example.",
  salesPage: "Part of a product's sales page in the studio's editor; the page's score and its test sit at the break. The product and its blocks are made up as an example.",
  crm: `Part of the deals board in the studio, as the store's owner sees it on the ${PLAN_TITLES.creator} plan, on the pipeline a store starts with; its totals and filters sit at the break, and three more stages follow. The deals, the people and the amounts are made up as an example: values recorded on deals, not revenue.`,
  outreach: "Part of one pitch, a draft, from the list at the foot of the studio's Outreach page, for a store without its own domain, with the lines the code adds under every email to a business in the United States and its stop link shortened. The business, the postal address and the words are made up as an example.",
  importDone: "One of your last imports in the studio: an email list from a spreadsheet, finished, with what came of every row. The file, the day and the counts are made up as an example.",
  dryRun: "Part of the dry run of a products file from ClickFunnels, before anything is saved; the buttons to import it sit under it. The products and the counts are made up as an example.",
  aiWriting: `The writing help in the sales page editor, on ${AI_PLANS_WORDS}. The product and the jobs left are made up as an example.`,
};

/**
 * @param tone Which surface it is standing on. The drawings themselves are
 *   white either way; only the hairline around them and the caption under
 *   them change, because a caption in white on sand is a caption nobody reads.
 */
export function FeatureVisual({ visual, tone = "dark" }: { visual: VisualKey; tone?: "dark" | "light" }) {
  const body = {
    store: <StoreVisual />,
    options: <OptionsDemo />,
    delivery: <DeliveryVisual />,
    stripe: <StripeVisual />,
    course: <CourseVisual />,
    membership: <MembershipVisual />,
    calls: <CallsVisual />,
    checkout: <BumpDemo />,
    email: <EmailVisual />,
    domain: <DomainVisual />,
    insights: <InsightsVisual />,
    funnels: <FunnelsVisual />,
    bundles: <BundlesVisual />,
    quizzes: <QuizzesVisual />,
    keys: <KeysVisual />,
    webhooks: <WebhooksVisual />,
    calendar: <CalendarVisual />,
    discord: <DiscordVisual />,
    community: <CommunityVisual />,
    affiliates: <AffiliatesVisual />,
    events: <EventsVisual />,
    team: <TeamVisual />,
    emailPlatforms: <EmailPlatformsVisual />,
    stamp: <StampVisual />,
    ways: <WaysVisual />,
    phone: <PhoneVisual />,
    security: <SecurityVisual />,
    salesPage: <SalesPageVisual />,
    aiWriting: <AiWritingVisual />,
    crm: <CrmVisual />,
    outreach: <OutreachVisual />,
    importDone: <ImportDoneVisual />,
    dryRun: <DryRunVisual />,
  }[visual];
  const interactive = visual === "options" || visual === "checkout";
  return (
    <figure className="w-full min-w-0 max-w-[26rem]">
      {interactive ? body : <div aria-hidden="true">{body}</div>}
      <figcaption className={`mt-3 text-center text-sm ${tone === "light" ? "text-ink-mute" : "text-white/70"}`}>
        {CAPTIONS[visual]}
      </figcaption>
    </figure>
  );
}

export { Window as VisualWindow };
