"use client";

import { type ImportReportLine, type ImportedStep, SequenceImportBox, reportWords } from "@/components/sequence-import-box";
import type { LibraryEmailDraft, LibrarySequenceDraft } from "@/lib/template-library-intents";
import { AiAssist, AiOn } from "@/components/ai-assist";
import { sendCount } from "@/lib/send-count";
import { afterSwitch, emailName, setAsideCount, setAsideNote, takeNewest } from "@/lib/set-aside";
import { EMAIL_GOALS, type EmailGoal } from "@/lib/ai-rules";
import { appendSequenceDraft, sequenceDraftSlots, DEFAULT_SEQUENCE_DRAFT, type DraftedStep, SEQUENCE_DRAFT_COUNTS } from "@/lib/sequence-draft";
import { PRO_MONTHLY_EMAILS, TRIAL_MONTHLY_EMAILS } from "@/lib/plan";
import { emailEquivalence } from "@/lib/email-equivalence";

import { useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLeaveGuard } from "@/components/leave-guard";
import { isAiEmailCopy, isAiSequenceDraft } from "@/lib/ai-response";
import { RFM_GROUPS, type RfmGroup } from "@/lib/rfm-rules";
import { MAX_TAG_LENGTH, readTags } from "@/lib/contact-rules";
import { confirmedRecipientCount, confirmedDraftId, draftRemovalAnswer, confirmedMailCopy, keptWaitHours, mailAnswer, type MailAnswer } from "@/lib/mail-response";
import { toast } from "@/components/toast";
import { MailAccent, MailBodyEditor } from "@/components/mail-designer";
import { flowConfigurationIssues } from "@/lib/flow-review";
import type { Flow, FlowCounts, FlowStep } from "@/lib/flows";
import { flowWaitHours, type FlowAction, type FlowGoal, type FlowTrigger, MAX_CONDITION_TAG, type StepCondition, type StepIf, isCourseIf } from "@/lib/flow-rules";
import { MAX_FLOWS, MAX_STEPS } from "@/lib/flow-limits";
import { type MapStep, WorkflowMap, WorkflowPreview, WorkflowRuns } from "@/components/workflow-tools";
import type { MailSettings } from "@/lib/store";
import { StoreField } from "@/components/studio-store-pin";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { formatMoney } from "@/lib/money";
import { MIN_TEST_REACH, TEST_HOURS, TEST_SHARES, type SubjectTest, type TestBy } from "@/lib/mail-test";
import { type Currency, plainAmount } from "@/lib/money";
import { mailAudienceWords, type MailAudienceSelection } from "@/lib/mail-audience-summary";
import { campaignHistoryView, HISTORY_STATUSES, type HistoryStatus } from "@/lib/broadcast-history-view";
import { broadcastAnswer, cancellationAnswer } from "@/lib/broadcast-response";
import type { DraftSubjectTest } from "@/lib/mail-draft-test";
import { subjectTestPreview, type SubjectTestPreview } from "@/lib/mail-test-preview";
import { readMailSchedule } from "@/lib/mail-schedule";
import { PUBLISH_WARNING } from "@/lib/letter-rules";
import { channelName } from "@/lib/channel-names";
import { type Narrow, ACTIVE_DAYS, MAX_SPENT, readSegmentSpend, QUIET_DAYS, type Segment } from "@/lib/segments-rules";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  from_name: "Type the name your emails are from.",
  address: "Type a postal address where you can be reached: a street address or a PO box. The law in the United States asks for one in every email like this.",
  confirm: "Check the box to confirm the people you are importing agreed to hear from you.",
  no_addresses: "No email addresses were found in what you pasted.",
  too_many: "That is more than one import takes. Split it into files of 5,000 addresses or fewer.",
  subject: "Write a subject line.",
  body: "Write the email itself.",
  placeholder: "Part of the template is still in ⟦brackets⟧. Replace each with your own words, or remove it, before it can go out.",
  when: "Pick a time between now and a year from now.",
  broadcast_cancel_unconfirmed: "The cancellation could not be confirmed. The campaign may still go out. Reload Sent and scheduled to check its current status.",
  broadcast_write_unconfirmed: "The campaign could not be confirmed. Your text is still here. It may already have been created; check Sent and scheduled before trying again.",
  product: "That product is not in your store anymore.",
  empty: "Nobody on your list matches, so there is nobody to send it to yet.",
  test_subject: "Write a second subject line that is different from the first, or uncheck the test.",
  test_small: `Trying two subject lines needs at least ${MIN_TEST_REACH} people, or each line reaches too few for the result to mean anything. Send it without the test, or to a bigger group.`,
  test_links:
    "Two subject lines are compared by the visits and sales the email's links bring, and this email has no link to your store. Add a link to your store or to a product, or send it without the test.",
  allowance: "This goes to more people than this month's emails have left. Send it to a smaller group, or next month.",
  day: "Today's sending is full. A test can go out again tomorrow.",
  sender: "Email is waiting on our side: the service that sends it has reached the volume it allows us for now. Nothing was sent; it opens again by itself as soon as there is room.",
  setup: "Save the name and postal address your emails carry first, at the top of this page.",
  plan: "Email to your list is part of Pro.",
  name: "Give the sequence a name.",
  trigger: "Choose what starts the sequence.",
  steps: `A workflow has between one and ${MAX_STEPS} steps.`,
  route: "A branch must go forward: choose a later step of this workflow, or the end.",
  active_limit: "Your plan has as many workflows switched on as it allows. Pause one first, or save this one paused.",
  email: "Type an email address.",
  step: "Every email needs a subject, some text, and a wait of up to a year. A condition needs its product, or its label, and one on the email before needs an email right before it. A label needs its words, and another sequence has to still be there. A field needs a value it keeps, a deal a stage, and a note its words.",
  tag: "Write the label that starts the sequence.",
  form: "Choose one of your forms that asks for an email address.",
  stage: "Choose one of your pipelines' stages.",
  stage_taken: "Another workflow already starts from that stage. A stage starts one workflow; that one can start others with a step.",
  unknown: "That is not there anymore. Reload the page.",
  send: "The email service did not take it just now. Nothing was sent; try again in a moment.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Email is not switched on yet, so nothing was sent.",
  draft_remove_conflict: "A newer version of this draft was saved. It was not deleted. Reload saved drafts and review the latest version before deleting it.",
  draft_conflict: "A newer version of this draft was saved. Your text is still here. Keep a copy of it, then reload saved drafts and open the latest version before saving again.",
  draft_busy: "This draft is being changed. Your text is still here. Try saving again shortly.",
  draft_test: "The subject test settings could not be saved. Review the second subject, share, wait and selection criterion.",
  audience: "The audience filters could not be saved. Review the recipient choices and try again.",
  full: "A store keeps 20 drafts at most. Send or delete one first.",
  list: "This store has no list yet, so there is nowhere to keep a draft.",
  role: "Your role on this store does not include this.",
  draft_remove_unconfirmed: "The draft removal could not be confirmed. Reload your saved drafts to check whether it was removed before trying again.",
  draft_read_unavailable: "Your saved drafts could not be checked before saving. Your text is still here. Try saving again in a moment.",
  draft_write_unconfirmed: "The draft save could not be confirmed. Your text is still here. Check your saved drafts before saving again; the draft may already exist.",
  flow_write_unconfirmed: "The sequence change could not be confirmed. Reload the saved sequences and check the result before trying again. The change may already have happened.",
  starters_nothing: "Your store already has a sequence for each of those moments. They are under Sequences.",
  keep_unsent: "Only an email that has finished going out can be kept sending.",
  keep_excludes:
    "This email was narrowed two ways at once, and an email in a sequence keeps one condition. Write it again instead, and choose who it goes to.",
  goal: "That ending would stop the sequence before its first email, or the trigger needs one. A workflow about an abandoned checkout must end once they buy. Choose another ending.",
  keep_money:
    "This email was sent to people chosen by what they spent, where they came from, when they last bought or the kind of buyer they are, and a sequence cannot choose that way. Write it again instead.",
  stripe: "Your Stripe account could not be read just now, so spending, channels and last purchases cannot be counted. Try again in a moment.",
  segment_name: "Give the group a name.",
  segment_empty: "Choose who the group is first: a kind of reader, a product, someone to leave out, a label, or one of the five ways below.",
  segment_product: "That product is not in your store anymore.",
  segment_full: "A store keeps 20 saved groups at most. Remove one first.",
  keep_already: "This email is already going to new people by itself. It is under Sequences.",
  keep_full: `That sequence already holds ${MAX_STEPS} steps. Remove one under Sequences first.`,
  too_many_flows: `A store keeps ${MAX_FLOWS} sequences at most. Remove one under Sequences first.`,
  server_error: "Something went wrong on our side. Try again in a moment.",
};

type Answer = MailAnswer;

async function call(payload: Record<string, unknown>): Promise<Answer> {
  const sequenceWrite = ["keep", "flow", "flow-remove", "starters", "flow-activate", "flow-resolve"].includes(String(payload.action));
  const draftWrite = payload.action === "draft-save";
  try {
    const response = await fetch("/api/store/mail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const raw = await response.json().catch(() => null);
    if (payload.action === "broadcast") return broadcastAnswer(response.ok, raw, payload);
    if (payload.action === "cancel") return cancellationAnswer(response.ok, raw, payload.id);
    if (payload.action === "draft-remove") return draftRemovalAnswer(response.ok, raw, payload.id, payload.expectedSavedAt);
    return mailAnswer(response.ok, raw, sequenceWrite, draftWrite);
  } catch {
    if (payload.action === "broadcast") return broadcastAnswer(false, null, payload);
    if (payload.action === "cancel") return cancellationAnswer(false, null, payload.id);
    if (payload.action === "draft-remove") return draftRemovalAnswer(false, null, payload.id, payload.expectedSavedAt);
    return mailAnswer(false, null, sequenceWrite, draftWrite);
  }
}

const message = (a: Answer) => MESSAGES[a.error ?? ""] ?? MESSAGES.server_error;
const n = (x: number) => x.toLocaleString("en-US");

type BroadcastRow = {
  id: string;
  subject: string;
  status: string;
  sendAt: number;
  finishedAt: number;
  total: number;
  sent: number;
  note: string;
  productId: string | null;
  /** Everybody, only buyers, or only people who have not bought yet (lib/contacts.ts). */
  who: Who;
  /** Left out the people who own this product. */
  notProductId: string | null;
  /** Narrowed by spending, first channel, quiet days, recent purchase or kind of buyer (lib/segments.ts); null for none. */
  narrow?: Narrow | null;
  /** Only people with this label (lib/contacts.ts, 99 [E2-TAG-BROADCAST]); null or absent for none. */
  label?: string | null;
  /** Whether its links carry its tag, so its sales can be counted at all (lib/mail-links.ts). */
  tagged: boolean;
  /** What it sold, from the creator's own Stripe account; null when nothing is counted for it. */
  money: Money | null;
  /** Pages of the store opened through its links; null when that could not be read. */
  visits: number | null;
  /** The second subject line it tried, and how that went (lib/mail-test.ts). */
  test: SubjectTest | null;
  /** Where it is published on the store, or null when it is not (lib/letters.ts). */
  published?: string | null;
};
type Money = { sales: number; cents: number; elsewhere?: number };
type FlowRow = Flow & { stats: FlowCounts; statsAvailable?: boolean; money: Money | null };

/**
 * "3 sales · $117.00 from its links in the last 90 days", in the store's own
 * currency; a sale in another currency than the store's is counted after it,
 * its amount never added (22 [E5], unit 2d).
 */
function soldWords(money: Money, currency: string): string {
  const others = money.elsewhere ?? 0;
  const one = others === 1;
  if (!money.sales && !others) return "No sale from its links yet";
  if (!money.sales) return `${n(others)} ${one ? "sale" : "sales"} in another currency from its links in the last 90 days. ${one ? "Its amount is" : "Their amounts are"} not shown, since amounts here count only your store's currency`;
  return `${n(money.sales)} ${money.sales === 1 ? "sale" : "sales"} · ${formatMoney(money.cents, currency)} from its links in the last 90 days${others ? `, plus ${n(others)} more ${one ? "sale" : "sales"} in another currency, ${one ? "whose amount is" : "whose amounts are"} not in this total` : ""}`;
}

/**
 * What a sent email brought: "42 visits · 3 sales · $117.00 from its links in
 * the last 90 days". Visits are left out, never shown as none, when they
 * could not be read.
 */
function broughtWords(visits: number | null, money: Money | null, currency: string): string {
  const came = visits === null ? "" : `${n(visits)} ${visits === 1 ? "visit" : "visits"}`;
  if (money) return `${came ? `${came} · ` : ""}${soldWords(money, currency)}`;
  if (came && visits) return `${came} from its links in the last 90 days · no sale yet`;
  return came ? "No visit or sale from its links yet" : "No sale from its links yet";
}

/**
 * Who a sent email goes on reaching once it is kept sending (lib/mail-reuse.ts):
 * "Everyone who joins and has not bought yet".
 */
function keptWords(b: Pick<BroadcastRow, "who" | "productId" | "notProductId" | "label">, products: { id: string; title: string }[]): string {
  const title = (id: string | null) => products.find((p) => p.id === id)?.title ?? "that product";
  const start =
    b.who === "buyers" && !b.productId
      ? "Everyone who buys something for the first time"
      : b.productId
        ? `Everyone who gets ${title(b.productId)}`
        : "Everyone who joins";
  if (b.notProductId) return `${start} and does not have ${title(b.notProductId)}`;
  if (b.label) return `${start} and has the label \u201c${b.label}\u201d`;
  if (b.who === "leads") return `${start} and has not bought yet`;
  if (b.who === "buyers" && b.productId) return `${start} and has paid`;
  return start;
}

/** Whether a sent email can be kept sending: narrowed at most one way beyond what starts its sequence. */
/** How an email was narrowed by money, in one line (lib/segments.ts). */
function narrowWords(narrow: Narrow, currency: string): string {
  const parts = [
    narrow.minSpent ? `spent at least ${formatMoney(narrow.minSpent, currency)}` : "",
    narrow.channel ? `first came through ${channelName(narrow.channel)}` : "",
    narrow.quietDays ? `had not bought in ${narrow.quietDays} days` : "",
    narrow.activeDays ? `bought in the last ${narrow.activeDays} days` : "",
    narrow.group ? `are among your \u201c${RFM_GROUPS.find((g) => g.id === narrow.group)?.name ?? narrow.group}\u201d` : "",
  ].filter(Boolean);
  return `Only those who ${parts.join(", ")}.`;
}

/** Shared wording keeps saved drafts, history and the final review consistent. */
function AudienceSummary({ audience, products, currency }: {
  audience: MailAudienceSelection & { narrow?: Narrow | null; label?: string | null };
  products: readonly { id: string; title: string }[];
  currency: string;
}) {
  const narrow = audience.narrow;
  const narrowed = narrow && Boolean(narrow.minSpent || narrow.channel || narrow.quietDays || narrow.group || narrow.activeDays);
  return <div className="mt-1 break-words text-sm text-ink-soft">
    <p><span className="font-semibold">Audience criteria: </span>{mailAudienceWords(audience, products)}</p>
    {audience.label ? <p className="mt-1">{`Only people with the label “${audience.label}”.`}</p> : null}
    {narrowed ? <p className="mt-1">{narrowWords(narrow, currency)}</p> : null}
  </div>;
}

/** A preview describes allocation, never a forecast or a statistically proven winner. */
function SubjectTestReview({ preview }: { preview: SubjectTestPreview | null }) {
  if (!preview || preview.state !== "ready") return null;
  return <div className="mt-3 space-y-2 break-words text-sm text-ink-soft">
    <p className="font-semibold text-ink">Subject test estimate for the currently confirmed audience</p>
    <dl className="space-y-1">
      <div><dt className="font-semibold">First subject (A) · {n(preview.a)} people</dt><dd>{preview.subjectA}</dd></div>
      <div><dt className="font-semibold">Second subject (B) · {n(preview.b)} people</dt><dd>{preview.subjectB}</dd></div>
    </dl>
    <p>{n(preview.rest)} people wait for the selected subject. The {hoursWords(preview.hours)} comparison window starts after the test emails finish going out.</p>
    <p>{preview.by === "sales" ? "Sales per email decide; visits decide if sales are tied or unavailable." : "Visits to the store per email decide."} If the available counts do not distinguish the subjects, the first subject is used. This does not establish statistical significance.</p>
    <p>The audience is checked again when sending starts, so these numbers can change. If fewer than {n(MIN_TEST_REACH)} people remain, the first subject is used without a test.</p>
  </div>;
}

function keepable(b: Pick<BroadcastRow, "who" | "productId" | "notProductId" | "narrow" | "label">): boolean {
  // Chosen by spending, a channel, quiet days, a recent purchase or a kind of buyer: a sequence cannot choose that way (lib/mail-reuse.ts).
  if (b.narrow) return false;
  return [Boolean(b.notProductId), b.who === "leads", b.who === "buyers" && Boolean(b.productId), Boolean(b.label)].filter(Boolean).length < 2;
}

/** "a day", "4 hours": how long the rest of a list waits for a subject test. */
function hoursWords(hours: number): string {
  return hours === 24 ? "a day" : `${hours} hours`;
}
export type DraftRow = {
  subjectTest?: DraftSubjectTest | null;
  id: string;
  subject: string;
  body: string;
  productId: string | null;
  by: string;
  savedAt: string;
  /** Set when a sent email is written again, so it starts addressed to the same people. */
  who?: Who;
  notProductId?: string | null;
  narrow?: Narrow | null;
  label?: string | null;
};
type Who = "all" | "buyers" | "leads";

const TIME: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

/**
 * A time in the reader's own time zone. The server does not know it, so the
 * first render says UTC and the browser swaps in local time straight after.
 */
const noSubscription = () => () => {};
function When({ seconds }: { seconds: number }) {
  const inBrowser = useSyncExternalStore(noSubscription, () => true, () => false);
  const date = new Date(seconds * 1000);
  return <>{inBrowser ? date.toLocaleString("en-US", TIME) : `${date.toLocaleString("en-US", { ...TIME, timeZone: "UTC" })} UTC`}</>;
}

function Feedback({ error, done }: { error: string | null; done: string | null }) {
  if (error) return <p className="notice notice-error mt-3" role="alert">{error}</p>;
  if (done) return <p className="notice notice-success mt-3" role="status">{done}</p>;
  return null;
}

/**
 * The studio's email page. What a role may do here is decided by the server
 * (lib/team-roles.ts); these switches only leave out what it may not, so an
 * Editor sees a composer that keeps drafts, and the owner or an Admin sends
 * them.
 */
export function EmailStudio(props: {
  initialTemplate?: LibraryEmailDraft;
  initialSequence?: LibrarySequenceDraft;
  email: string;
  name: string;
  mail: MailSettings | null;
  counts: { total: number; agreed: number; left: number; mailable: number };
  used: number;
  allowance: number;
  /** Whether the plan's month can be told (lib/allowance-window.ts windowId); without it no count before sending is shown. */
  monthKnown?: boolean;
  trial: boolean;
  products: { id: string; title: string }[];
  broadcasts: BroadcastRow[];
  broadcastsReadFailed?: boolean;
  /** The store's currency, for what each email sold. */
  currency: string;
  /** The plan above this one, when the store is on Pro and this person may change its plan. */
  moveUp: { action: string; cycle: "month" | "year"; price: string; emails: number; trial: boolean } | null;
  /** Whether anything on the store is sold for money. */
  sells: boolean;
  flows: FlowRow[];
  flowsReadFailed?: boolean;
  drafts: DraftRow[];
  draftsReadFailed?: boolean;
  canSend: boolean;
  canSettings: boolean;
  canExport: boolean;
  /** Each product's own address, for an email about it. */
  links?: Record<string, string>;
  /** Whether the writing help is on, and what is left of the month (lib/ai.ts). */
  ai?: { on: boolean; left: number };
  /** The store's saved groups (lib/segments.ts). */
  segments?: Segment[];
  /** The products that are courses (lib/catalog.ts, "course"). */
  courses?: string[];
  /** The products that are calls: a sequence that starts with one says "books" (548 [TR1]). */
  calls?: string[];
  /** Paid products in the selected store catalog, for sequence ending checks. */
  paidProducts?: string[];
  /** The store's forms that ask for an address, its own fields and its deal stages, for the sequences (lib/flows.ts). */
  automation?: { forms: { id: string; name: string; outcomes?: { id: string; title: string }[] }[]; fields: { id: string; name: string; type: string; options: string[] }[]; stages: { id: string; name: string }[] };
  /** The plan's workflow limits and today's runs (lib/flow-limits.ts, lib/flow-runs.ts). */
  workflowLimits?: WorkflowLimits;
  /** Who may be made responsible for a deal: the owner and teammates who can see orders. */
  assignees?: string[];
  /** Who a new email goes to, when opened from "Worth knowing" (lib/insights.ts). */
  preset?: { who: Who };
  /** The store's colour for a button in its emails (lib/store-look.ts), so the designer's preview is what is sent. */
  accent?: string;
}) {
  const ready = props.mail !== null;
  const [libraryEmail, setLibraryEmail] = useState(props.initialTemplate);
  const [broadcastUnconfirmed, setBroadcastUnconfirmed] = useState(false);
  const [draftCleanupUnconfirmed, setDraftCleanupUnconfirmed] = useState(false);
  // The draft open in the composer; a new key starts the composer afresh.
  const [open, setOpen] = useState<DraftRow | null>(null);
  const [composeRevision, setComposeRevision] = useState(0);
  const composerState = useRef<ComposerHandle | null>(null);
  // Unsaved changes set aside by opening another email, with the email they belonged to (485 [IT2]): kept in this page only, never sent
  // or saved. A list, newest last, so a second switch never drops what an earlier one set aside.
  const [setAside, setSetAside] = useState<{ snapshot: ComposerSnapshot; from: DraftRow | null }[]>([]);
  const [restore, setRestore] = useState<ComposerSnapshot | undefined>(undefined);
  // What the polite region says: a different sentence for each thing that happened, so each is read out.
  const [asideNote, setAsideNoteText] = useState("");
  // Leaving the page would lose what was set aside, so it asks as for changes on screen (components/leave-guard.ts).
  useLeaveGuard(setAside.length > 0);
  const switchTo = (draft: DraftRow | null, restoring?: ComposerSnapshot, rest = setAside) => {
    // Opening another email over unsaved changes no longer asks first: they are set aside, and one press brings them back.
    const current = composerState.current;
    const kept = current?.dirty ? current.snapshot() : null;
    setSetAside(afterSwitch(rest, kept, open));
    setAsideNoteText(setAsideNote(kept, restoring ?? null));
    setLibraryEmail(undefined);
    setOpen(draft);
    setRestore(restoring);
    setComposeRevision((value) => value + 1);
  };
  const openDraft = (draft: DraftRow | null) => {
    if (draft && open?.id === draft.id && open.savedAt === draft.savedAt) return;
    if (composerState.current?.busy) {
      toast("Wait for the current email operation to finish before opening another email.");
      return;
    }
    switchTo(draft);
  };
  const bringBack = () => {
    if (composerState.current?.busy) return;
    // The newest set aside; a draft deleted since comes back as a new email (lib/set-aside.ts).
    const newest = takeNewest(setAside, props.drafts);
    if (newest) switchTo(newest.from, newest.snapshot, newest.rest);
  };
  const [uncertainList, setUncertainList] = useState<FlowRow[] | null>(null);
  const writeUnconfirmed = uncertainList === props.flows;
  const onWriteUnconfirmed = () => setUncertainList(props.flows);
  return (
    <MailAccent.Provider value={props.accent ?? "#4c1d95"}>
    <div className="mt-8 grid items-start gap-x-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        {ready ? (
          <>
            {draftCleanupUnconfirmed ? <p role="status" className="mb-4 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink-soft">Your campaign was created, but clearing its saved draft could not be confirmed. Check Sent and scheduled before sending that draft again.</p> : null}
            <AiOn value={props.ai ?? { on: false, left: 0 }}>
              {/* A polite live region always on the page, so what is set aside and brought back is read out (485 [IT2]). */}
              <div aria-live="polite" className="mb-4">
                {asideNote || setAside.length > 0 ? (
                  <p className="rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink">
                    {asideNote || setAsideCount(setAside.length)}
                    {setAside.length > 0 ? (
                      <>
                        {" "}
                        <button type="button" className="btn btn-secondary btn-sm ml-1" onClick={bringBack}>{`Bring back ${emailName(setAside.at(-1)!.snapshot)}`}</button>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </div>
              <Compose
                key={`${composeRevision}-${open ? `${open.id}-${open.savedAt}` : "new"}`}
                email={props.email}
                products={props.products}
                links={props.links ?? {}}
                counts={props.counts}
                month={props.monthKnown ? { used: props.used, allowance: props.allowance } : null}
                canSend={props.canSend}
                broadcastUnconfirmed={broadcastUnconfirmed}
                onBroadcastUnconfirmed={() => setBroadcastUnconfirmed(true)}
                onDraftCleanupUnconfirmed={() => setDraftCleanupUnconfirmed(true)}
                draft={open}
                initialTemplate={open ? undefined : libraryEmail}
                onDone={() => { setLibraryEmail(undefined); setOpen(null); setRestore(undefined); setAsideNoteText(""); setComposeRevision((value) => value + 1); }}
                onStartNew={() => openDraft(null)}
                composerState={composerState}
                restore={restore}
                savedDrafts={props.drafts}
                draftsReadFailed={props.draftsReadFailed ?? false}
                currency={props.currency}
                segments={props.segments ?? []}
                preset={open ? undefined : props.preset}
              />
            </AiOn>
            <Drafts currency={props.currency} readFailed={props.draftsReadFailed ?? false} drafts={props.drafts} products={props.products} open={open} onOpen={openDraft} />
            <History readFailed={props.broadcastsReadFailed ?? false} writeUnconfirmed={writeUnconfirmed} onWriteUnconfirmed={onWriteUnconfirmed} flowsReadFailed={props.flowsReadFailed ?? false} broadcasts={props.broadcasts} products={props.products} canSend={props.canSend} onOpen={openDraft} currency={props.currency} />
            {props.canSend ? (
              <AiOn value={props.ai ?? { on: false, left: 0 }}>
                <Flows initialSequence={props.initialSequence} writeUnconfirmed={writeUnconfirmed} onWriteUnconfirmed={onWriteUnconfirmed} flows={props.flows} readFailed={props.flowsReadFailed ?? false} products={props.products} currency={props.currency} sells={props.sells} courses={props.courses ?? []} calls={props.calls ?? []} paidProducts={props.paidProducts} automation={props.automation} limits={props.workflowLimits} assignees={props.assignees ?? []} />
              </AiOn>
            ) : null}
          </>
        ) : props.canSettings ? (
          <div className="card p-6 sm:p-8">
            <p className="text-lg font-semibold tracking-[-0.02em] text-ink">First, how your emails are signed</p>
            <p className="mt-2 text-ink-soft">One minute, once. Then you can write.</p>
            <Settings name={props.name} mail={props.mail} />
          </div>
        ) : (
          <div className="card p-6 sm:p-8">
            <p className="text-lg font-semibold tracking-[-0.02em] text-ink">Not set up yet</p>
            <p className="mt-2 text-ink-soft">
              The store&apos;s owner or an Admin first saves the name and postal address its emails carry. Then you can write here.
            </p>
          </div>
        )}
      </div>
      <div className="min-w-0">
        <div className="card mt-8 p-6 sm:p-8 lg:mt-0">
          <p className="text-lg font-semibold tracking-[-0.02em] text-ink">This month</p>
          <p className="mt-2 text-3xl font-semibold tabular-nums">{`${n(props.used)} of ${n(props.allowance)}`}</p>
          <p className="mt-1 text-sm text-ink-soft">
            {props.trial
              ? `emails sent. During the free trial a month holds ${TRIAL_MONTHLY_EMAILS.toLocaleString("en-US")}; the full ${PRO_MONTHLY_EMAILS.toLocaleString("en-US")} opens with your first payment.`
              : "emails sent, one-off and sequences together. The count starts again on the day your plan's month renews."}
          </p>
          {!props.trial && emailEquivalence(props.allowance) ? (
            <p className="mt-2 text-sm text-ink-soft" data-email-equivalence>{emailEquivalence(props.allowance)}</p>
          ) : null}
          {props.moveUp ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-bold text-ink underline underline-offset-2">
                {`Need more? ${n(props.moveUp.emails)} a month on Scale`}
              </summary>
              <p className="mt-3 text-sm text-ink-soft">
                {`Scale is the plan you have with room for a bigger list: up to ${n(props.moveUp.emails)} emails a month, at ${props.moveUp.price}. ${emailEquivalence(props.moveUp.emails)} `}
                {props.moveUp.trial
                  ? "Nothing is charged now. When the trial ends you pay the Scale price instead."
                  : "Today you are charged only the difference for the rest of the period you already paid for. You can go back to Pro from your studio whenever you like."}
              </p>
              <form action={props.moveUp.action} method="post" className="mt-3">
                <input type="hidden" name="tier" value="scale" />
                <input type="hidden" name="cycle" value={props.moveUp.cycle} />
                <button type="submit" className="btn btn-secondary btn-sm">Move up to Scale</button>
              </form>
            </details>
          ) : null}
        </div>
        <ListCard counts={props.counts} canExport={props.canExport} canImport={props.canSend} />
        {ready && props.canSettings ? (
          <div className="card mt-8 p-6 sm:p-8">
            <p className="text-lg font-semibold tracking-[-0.02em] text-ink">How your emails are signed</p>
            <Settings name={props.name} mail={props.mail} />
          </div>
        ) : null}
      </div>
    </div>
    </MailAccent.Provider>
  );
}

function Settings({ name, mail }: { name: string; mail: MailSettings | null }) {
  const router = useRouter();
  const [fromName, setFromName] = useState(mail?.fromName ?? name);
  const [address, setAddress] = useState(mail?.address ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const a = await call({ action: "settings", fromName, address });
        setBusy(false);
        if (a.ok) {
          toast("Email settings saved.");
          router.refresh();
        } else setError(message(a));
      }}
    >
      <label className="block">
        <span className="field-label">Your emails are from</span>
        <input className="field mt-2" maxLength={60} value={fromName} onChange={(e) => setFromName(e.target.value)} />
      </label>
      <label className="block">
        <span className="field-label">Postal address at the bottom of each email</span>
        <input className="field mt-2" maxLength={200} placeholder="Street, city, ZIP or postal code, country — or a PO box" value={address} onChange={(e) => setAddress(e.target.value)} />
      </label>
      <p className="text-sm text-ink-soft">
        Replies go to the email address the store&apos;s owner logs in with. The postal address is required by the CAN-SPAM Act for emails
        like these; a PO box or a mail service address counts.
      </p>
      <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-secondary">Save</button>
      <Feedback error={error} done={null} />
    </form>
  );
}

function ListCard({
  counts,
  canExport,
  canImport,
}: {
  counts: { total: number; agreed: number; left: number; mailable: number };
  canExport: boolean;
  canImport: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="card mt-8 p-6 sm:p-8">
      <p className="text-lg font-semibold tracking-[-0.02em] text-ink">Your list</p>
      <p className="mt-2 text-ink-soft">
        {`${n(counts.mailable)} ${counts.mailable === 1 ? "person" : "people"} you can write to. ${n(counts.left)} left through the unsubscribe link, and ${n(counts.total - counts.agreed)} gave their address for one thing only and are never written to.`}
      </p>
      {canExport ? (
        <form action="/api/store/leads" method="get" className="mt-4">
          <StoreField />
          <input type="hidden" name="who" value="agreed" />
          <button type="submit" className="btn btn-secondary btn-sm">Download the people you can write to</button>
        </form>
      ) : null}
      {canImport ? (
      <details className="mt-5">
        <summary className="cursor-pointer text-sm font-bold text-ink underline underline-offset-2">Import addresses</summary>
        <form
          className="mt-3 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            setDone(null);
            const a = await call({ action: "import", text, confirm });
            setBusy(false);
            if (a.ok) {
              setDone(`${n(Number(a.added))} added. ${n(Number(a.already))} were already on your list or had left it, and stay as they were.${Number(a.skipped) ? ` ${n(Number(a.skipped))} did not look like email addresses.` : ""}`);
              setText("");
              setConfirm(false);
              router.refresh();
            } else setError(message(a));
          }}
        >
          <label htmlFor="import-text" className="field-label">Paste addresses, or a CSV file&apos;s contents</label>
          <textarea id="import-text" rows={6} className="field" value={text} onChange={(e) => setText(e.target.value)} />
          <label className="block text-sm">
            <span className="text-ink-soft">Or choose a file</span>
            <input
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="mt-1 block w-full text-sm"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setText(await file.text());
              }}
            />
          </label>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" className="mt-1" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            <span>These people agreed to get emails from me. None of them came from a bought or borrowed list.</span>
          </label>
          <p className="text-sm text-ink-soft">
            Up to 5,000 at a time. Anyone who ever unsubscribed from you here stays unsubscribed, whatever the file says.
          </p>
          <button type="submit" disabled={busy || !text.trim()} className="btn btn-secondary btn-sm">Import</button>
        </form>
      </details>
      ) : null}
      <Feedback error={error} done={done} />
    </div>
  );
}

/** Everything the composer holds that is not saved, to set aside and bring back (485 [IT2]). */
type ComposerSnapshot = {
  subject: string; body: string; productId: string; notProductId: string; who: Who; draftId: string; draftSavedAt: string;
  later: boolean; at: string; testing: boolean; subjectB: string; share: number; hours: number; by: TestBy;
  spentText: string; channel: string; quietDays: number; activeDays?: number; more: boolean; savedContent: string; label: string; buyerGroup?: RfmGroup | "";
  /** A draft save that could not be confirmed: saving stays blocked when brought back, so a draft is never made twice. */
  uncertain: boolean;
};
type ComposerHandle = { dirty: boolean; busy: boolean; snapshot: () => ComposerSnapshot };

function Compose(props: {
  initialTemplate?: LibraryEmailDraft;
  broadcastUnconfirmed: boolean;
  onBroadcastUnconfirmed: () => void;
  onDraftCleanupUnconfirmed: () => void;
  email: string;
  products: { id: string; title: string }[];
  links: Record<string, string>;
  counts: { mailable: number };
  /** This month's emails used and allowed, as the "This month" card shows them (460 [EL4]); null when the plan's month cannot be told. */
  month: { used: number; allowance: number } | null;
  canSend: boolean;
  /** A draft opened into the composer, or null for a new email. */
  draft: DraftRow | null;
  onDone: () => void;
  onStartNew: () => void;
  composerState: { current: ComposerHandle | null };
  /** Unsaved changes set aside and brought back (485 [IT2]): the composer starts from them. */
  restore?: ComposerSnapshot;
  savedDrafts: DraftRow[];
  draftsReadFailed: boolean;
  currency: string;
  segments: Segment[];
  preset?: { who: Who };
}) {
  const router = useRouter();
  const [refreshingDrafts, startDraftRefresh] = useTransition();
  const [uncertainDrafts, setUncertainDrafts] = useState<DraftRow[] | null>(props.restore?.uncertain ? props.savedDrafts : null);
  const draftSaveBlocked = uncertainDrafts !== null && (uncertainDrafts === props.savedDrafts || props.draftsReadFailed);
  const [subject, setSubject] = useState(props.restore ? props.restore.subject : props.draft?.subject ?? props.initialTemplate?.subject ?? "");
  const [body, setBody] = useState(props.restore ? props.restore.body : props.draft?.body ?? props.initialTemplate?.body ?? "");
  // The email's box, so a picture goes where the cursor is.
  const bodyBox = useRef<HTMLTextAreaElement>(null);
  // Brought back (485 [IT2]): the button that did it is gone, so the focus goes to the email it brought back.
  const subjectBox = useRef<HTMLInputElement>(null);
  const restored = Boolean(props.restore);
  useEffect(() => {
    if (restored) subjectBox.current?.focus();
  }, [restored]);
  const [productId, setProductId] = useState(props.restore ? props.restore.productId : props.draft?.productId ?? "");
  const [notProductId, setNotProductId] = useState(props.restore ? props.restore.notProductId : props.draft?.notProductId ?? "");
  // Everybody, only people who have bought something, or only those who have not yet.
  const [who, setWho] = useState<Who>(props.restore ? props.restore.who : props.draft?.who ?? props.preset?.who ?? "all");
  const [draftId, setDraftId] = useState(props.restore ? props.restore.draftId : props.draft?.id ?? "");
  const [draftSavedAt, setDraftSavedAt] = useState(props.restore ? props.restore.draftSavedAt : props.draft?.savedAt ?? "");
  const [later, setLater] = useState(props.restore?.later ?? false);
  const [at, setAt] = useState(props.restore?.at ?? "");
  const [scheduleNow, setScheduleNow] = useState(() => Date.now());
  const scheduledAt = later ? readMailSchedule(at, scheduleNow) : null;
  const invalidSchedule = later && scheduledAt === null;
  useEffect(() => {
    if (!later) return;
    const tick = () => setScheduleNow(Date.now());
    const timer = window.setInterval(tick, 30_000);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", tick); };
  }, [later]);
  // A second subject line tried on part of the list (lib/mail-test.ts).
  const [testing, setTesting] = useState(props.restore ? props.restore.testing : Boolean(props.draft?.subjectTest));
  const [subjectB, setSubjectB] = useState(props.restore ? props.restore.subjectB : props.draft?.subjectTest?.subjectB ?? "");
  const [share, setShare] = useState<number>(props.restore ? props.restore.share : props.draft?.subjectTest?.share ?? TEST_SHARES[0]);
  const [hours, setHours] = useState<number>(props.restore ? props.restore.hours : props.draft?.subjectTest?.hours ?? TEST_HOURS[1]);
  const [by, setBy] = useState<TestBy>(props.restore ? props.restore.by : props.draft?.subjectTest?.by ?? "visits");
  const [countRevision, setCountRevision] = useState(0);
  const [reachResult, setReachResult] = useState<{ key: string; count: number | null } | null>(null);
  // Spent at least, first found the store through, has not bought in these
  // days (lib/segments.ts), and the groups saved under a name.
  const [spentText, setSpentText] = useState(props.restore ? props.restore.spentText : props.draft?.narrow?.minSpent ? plainAmount(props.draft.narrow.minSpent, props.currency) : "");
  const [channel, setChannel] = useState(props.restore ? props.restore.channel : props.draft?.narrow?.channel ?? "");
  const [quietDays, setQuietDays] = useState(props.restore ? props.restore.quietDays : props.draft?.narrow?.quietDays ?? 0);
  // Bought in the last…, 461 [EL5]: the buyers still active.
  const [activeDays, setActiveDays] = useState(props.restore ? props.restore.activeDays ?? 0 : props.draft?.narrow?.activeDays ?? 0);
  // Only people with this label (99 [E2-TAG-BROADCAST]); empty is everyone chosen above.
  const [label, setLabel] = useState(props.restore ? props.restore.label ?? "" : props.draft?.label ?? "");
  // Cleaned once, as the server keeps a label (lib/contact-rules.ts), and used everywhere the audience goes.
  const cleanLabel = readTags([label])[0] ?? "";
  // Counted once the typing stops, so each key pressed is not a read of the whole list.
  const [countedLabel, setCountedLabel] = useState(cleanLabel);
  useEffect(() => {
    if (cleanLabel === countedLabel) return;
    const wait = setTimeout(() => setCountedLabel(cleanLabel), 400);
    return () => clearTimeout(wait);
  }, [cleanLabel, countedLabel]);
  // One group of the buyers, by how recently and how often they bought (270 [GR1], unit 3b); "" for none.
  const [buyerGroup, setBuyerGroup] = useState<RfmGroup | "">(props.restore ? props.restore.buyerGroup ?? "" : props.draft?.narrow?.group ?? "");
  const [more, setMore] = useState(props.restore ? props.restore.more : Boolean(props.draft?.narrow && (props.draft.narrow.minSpent || props.draft.narrow.channel || props.draft.narrow.quietDays || props.draft.narrow.group || props.draft.narrow.activeDays)));
  const [channels, setChannels] = useState<string[] | null>(null);
  // How many buyers are of each kind, from the ledger the choices below read (270 [GR1], unit 3c); null until read.
  const [kinds, setKinds] = useState<Partial<Record<RfmGroup, number>> | null>(null);
  const [partial, setPartial] = useState(false);
  const [segments, setSegments] = useState<Segment[]>(props.segments);
  const [groupName, setGroupName] = useState("");
  const parsedSpent = readSegmentSpend(spentText, props.currency as Currency);
  const invalidSpent = parsedSpent === null;
  const minSpent = parsedSpent ?? 0;
  const narrow: Narrow = { minSpent, channel, quietDays, ...(buyerGroup ? { group: buyerGroup } : {}), ...(activeDays ? { activeDays } : {}) };
  const countKey = JSON.stringify([productId, notProductId, who, minSpent, channel, quietDays, activeDays, buyerGroup, more, countRevision, invalidSpent, countedLabel]);
  // A label still being typed is not counted yet: no count is shown for a label other than the one typed.
  const reach = !invalidSpent && cleanLabel === countedLabel && reachResult?.key === countKey ? reachResult.count : null;
  const monthCount = reach !== null && !later && props.month ? sendCount(reach, props.month.used, props.month.allowance) : null;
  const testPreview = testing ? subjectTestPreview(subject, { subjectB, share, hours, by }, reach) : null;
  const invalidTest = testing && testPreview?.state !== "ready";
  const reachPending = !invalidSpent && (reachResult?.key !== countKey || cleanLabel !== countedLabel);
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const locked = busy || aiBusy || refreshingDrafts;
  const [confirming, setConfirming] = useState(false);
  // "Change" on a row of the review: back to that field, the review closed, so nothing is sent from an old one (487 [IT4], pattern 8).
  function changeAnswer(id: string) {
    setConfirming(false);
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  }
  const [error, setError] = useState<string | null>(null);
  // What the writing help is asked to write, and about which product.
  const [goal, setGoal] = useState<EmailGoal>("announce");
  const [about, setAbout] = useState("");
  const draftSubjectTest: DraftSubjectTest | null = testing ? { subjectB, share, hours, by } : null;
  const content = JSON.stringify([subject, body, productId, who, notProductId, spentText, channel, quietDays, activeDays, buyerGroup, draftSubjectTest, label]);
  const [savedContent, setSavedContent] = useState(props.restore ? props.restore.savedContent : !props.draft && props.initialTemplate ? "" : content);
  const dirty = (!draftId && Boolean(props.draft)) || content !== savedContent || later || at !== "";
  useLeaveGuard(dirty || aiBusy);
  // What is set aside when another email is opened over unsaved changes, so they can be brought back (485 [IT2]).
  const snapshot = (): ComposerSnapshot => ({ subject, body, productId, notProductId, who, draftId, draftSavedAt, later, at, testing, subjectB, share, hours, by, spentText, channel, quietDays, activeDays, more, savedContent, uncertain: draftSaveBlocked, label, buyerGroup });
  useImperativeHandle(props.composerState, () => ({ dirty, busy: locked, snapshot }));

  useEffect(() => {
    if (invalidSpent) return;
    let live = true;
    call({ action: "count", productId, notProductId, who, narrow, label: countedLabel, channels: more && channels === null }).then((a) => {
      if (!live) return;
      const count = confirmedRecipientCount(a);
      setReachResult({ key: countKey, count });
      setConfirming(false);
      if (count !== null) {
        if (Array.isArray(a.channels)) setChannels(a.channels.filter((c): c is string => typeof c === "string"));
        if (a.kinds && typeof a.kinds === "object" && !Array.isArray(a.kinds)) {
          const read = a.kinds as Record<string, unknown>;
          setKinds(Object.fromEntries(RFM_GROUPS.flatMap((g) => (Number.isSafeInteger(read[g.id]) && (read[g.id] as number) >= 0 ? [[g.id, read[g.id] as number]] : []))));
        }
        if (typeof a.partial === "boolean") setPartial(a.partial);
      } else if (a.error === "stripe") setError(message(a));
    });
    return () => {
      live = false;
    };
    // `channels` is asked for once, when the choices are first opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, notProductId, who, minSpent, channel, quietDays, activeDays, buyerGroup, more, countRevision, invalidSpent, countedLabel]);

  async function group(payload: Record<string, unknown>, done: string) {
    if (locked || (payload.action === "segment-save" && invalidSpent)) return;
    setBusy(true);
    setError(null);
    const a = await call(payload);
    setBusy(false);
    if (!a.ok) {
      setError(message(a));
      return;
    }
    if (Array.isArray(a.segments)) setSegments(a.segments as Segment[]);
    toast(done);
  }

  function pick(segment: Segment) {
    setWho(segment.who);
    setProductId(segment.productId);
    setNotProductId(segment.notProductId);
    setLabel(segment.label ?? "");
    setSpentText(segment.minSpent ? plainAmount(segment.minSpent, props.currency) : "");
    setChannel(segment.channel);
    setQuietDays(segment.quietDays);
    setActiveDays(segment.activeDays ?? 0);
    setBuyerGroup(segment.group ?? "");
    setGroupName(segment.name);
    if (segment.minSpent || segment.channel || segment.quietDays || segment.group || segment.activeDays) setMore(true);
  }

  async function send(payload: Record<string, unknown>, success: string) {
    if (locked || (payload.action === "broadcast" && (props.broadcastUnconfirmed || reach === null || reach === 0 || invalidTest))) return false;
    if (payload.action === "broadcast" && later) {
      const sendAt = readMailSchedule(at, Date.now());
      if (sendAt === null) {
        setError(MESSAGES.when);
        setConfirming(false);
        setScheduleNow(Date.now());
        return false;
      }
      payload = { ...payload, sendAt };
    }
    setBusy(true);
    setError(null);
    const a = await call(payload);
    setBusy(false);
    setConfirming(false);
    if (!a.ok) {
      if (payload.action === "broadcast" && a.error === "broadcast_write_unconfirmed") props.onBroadcastUnconfirmed();
      setError(message(a));
      return false;
    }
    if (payload.action === "broadcast" && a.draftCleanupConfirmed === false) props.onDraftCleanupUnconfirmed();
    toast(success);
    return true;
  }

  async function keep() {
    if (locked || draftSaveBlocked || invalidSpent) return;
    setBusy(true);
    setError(null);
    const audience = { who, notProductId: notProductId || null, narrow: minSpent || channel || quietDays || buyerGroup || activeDays ? narrow : null, ...(cleanLabel ? { label: cleanLabel } : {}) };
    const a = await call({ action: "draft-save", id: draftId || undefined, subject, body, productId, audience, subjectTest: draftSubjectTest, expectedSavedAt: draftId ? draftSavedAt : undefined });
    setBusy(false);
    if (!a.ok) {
      if (a.error === "draft_write_unconfirmed") setUncertainDrafts(props.savedDrafts);
      setError(message(a));
      return;
    }
    const savedId = confirmedDraftId(a, draftId, audience, { subject, body, productId }, draftSubjectTest);
    if (!savedId) {
      setUncertainDrafts(props.savedDrafts);
      setError("The draft save could not be confirmed. Your text is still here. Check your saved drafts before saving again; the draft may already exist.");
      return;
    }
    setUncertainDrafts(null);
    setDraftId(savedId);
    setDraftSavedAt((a.draft as { savedAt: string }).savedAt);
    setSavedContent(content);
    toast("Draft saved.");
    router.refresh();
  }

  return (
    <section className="card p-6 sm:p-8" aria-labelledby="compose-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="compose-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          {draftId ? "Draft" : "New email"}
        </h2>
        {draftId ? (
          <button type="button" className="text-sm font-bold text-ink-soft underline underline-offset-4" disabled={locked} onClick={props.onStartNew}>
            Start a new one instead
          </button>
        ) : null}
      </div>
      {locked ? <p role="status" className="mt-3 text-sm text-ink-soft">Working on your email. Editing is paused until this finishes.</p> : null}
      <fieldset className="mt-4 min-w-0 space-y-4" disabled={locked} aria-label="Email composition" aria-busy={locked}>
        <AiAssist<{ subject: string; body: string }>
          title="Write a draft with AI"
          onBusyChange={setAiBusy}
          validateResult={isAiEmailCopy}
          hint="Pick what the email is for, and say in a few words what you want it to say. The subject and the email below are filled in for you to read and change."
          placeholder="The recipe pack is out: 40 weeknight dinners, $27, and the first 10 pages are free to read on the page."
          extra={
            <div className="grid gap-3">
              <label className="block">
                <span className="field-label">It is to</span>
                <select className="field mt-2" value={goal} onChange={(e) => setGoal(e.target.value as EmailGoal)}>
                  {EMAIL_GOALS.map((g) => (
                    <option key={g.id} value={g.id}>{g.label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="field-label">About</span>
                <select className="field mt-2" value={about} onChange={(e) => setAbout(e.target.value)}>
                  <option value="">No product in particular</option>
                  {props.products.map((p) => (
                    <option key={p.id} value={p.id}>{p.title}</option>
                  ))}
                </select>
              </label>
            </div>
          }
          payload={() => ({
            kind: "email",
            goal,
            product: props.products.find((p) => p.id === about)?.title ?? "",
            link: about ? props.links[about] ?? "" : "",
          })}
          onResult={(value) => {
            setSubject(value.subject);
            setBody(value.body);
          }}
          done="The subject and the email below are filled in. Read them, change anything, then save or send."
        />
        <label className="block">
          <span className="field-label">Subject</span>
          <input id="mail-subject" ref={subjectBox} className="field mt-2" maxLength={150} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        {/*
          A second subject line, tried against the first.

          Decided by what the email's links bring to the store, never by
          opens: nothing in an email here reports back (app/privacy), and an
          open is the number a mail app inflates by itself anyway.
        */}
        {props.canSend ? (
          <div>
            <label className="flex items-start gap-3 text-sm font-semibold text-ink">
              <input
                type="checkbox"
                checked={testing}
                onChange={(e) => setTesting(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-violet-brand"
              />
              Try a second subject line
            </label>
            {testing ? (
              <div className="mt-3 space-y-4 rounded-[var(--r-md)] bg-sand p-4">
                <label className="block">
                  <span className="field-label">Second subject</span>
                  <input className="field mt-2" maxLength={150} value={subjectB} aria-invalid={testPreview?.state === "subject" || undefined} aria-describedby="subject-test-hint" onChange={(e) => setSubjectB(e.target.value)} />
                  <span id="subject-test-hint" className="field-hint mt-1 block">{testPreview?.state === "subject" ? "Write two nonempty subjects that remain different after spaces and capitalization are normalized." : "The second subject must differ from the first."}</span>
                </label>
                <div className="grid gap-4 sm:grid-cols-3">
                  <label className="block">
                    <span className="field-label">Share of the list</span>
                    <select className="field mt-2" value={share} onChange={(e) => setShare(Number(e.target.value))}>
                      {TEST_SHARES.map((value) => (
                        <option key={value} value={value}>{`${value}%`}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="field-label">Decide after</span>
                    <select className="field mt-2" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                      {TEST_HOURS.map((value) => (
                        <option key={value} value={value}>{hoursWords(value)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="field-label">Decided by</span>
                    <select className="field mt-2" value={by} onChange={(e) => setBy(e.target.value as TestBy)}>
                      <option value="visits">Visits</option>
                      <option value="sales">Sales</option>
                    </select>
                  </label>
                </div>
                <p className="text-sm text-ink-soft">
                  {`Half of that ${share}% gets each subject, chosen at random. ${hours === 24 ? "A day" : `${hours} hours`} after the last of them goes out, everyone else gets the one whose links brought more ${by === "sales" ? "sales" : "visits to your store"} for each email sent${by === "sales" ? ", with visits deciding when sales are level" : ""}. If neither did better, they get the first, and this page says so.`}
                </p>
                <p className="text-sm text-ink-soft">
                  {`It needs at least ${MIN_TEST_REACH} people and a link to your store in the email. Emails here carry no tracking pixel, so opens are not counted, and a small difference on a small list is mostly chance.`}
                </p>
                <SubjectTestReview preview={testPreview} />
                {reach !== null && reach < MIN_TEST_REACH ? (
                  <p className="notice notice-error" role="status">
                    {`This goes to ${n(reach)} ${reach === 1 ? "person" : "people"}, which is too few to compare two subjects. Uncheck the box, or choose a bigger group.`}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <MailBodyEditor
          body={body}
          onChange={setBody}
          boxRef={(el) => {
            bodyBox.current = el;
          }}
        />
        <p className="text-sm text-ink-soft">
          Blank lines make paragraphs, lines starting with &quot;- &quot; make a list, web addresses become links, and a picture you add shows where its line is. Design lays it out in blocks, with headings, buttons and templates. Why they are getting it, the unsubscribe link and your postal address are added at the bottom.
        </p>
        {segments.length ? (
          <label className="block">
            <span className="field-label">Saved groups</span>
            <select
              className="field mt-2"
              value=""
              onChange={(e) => {
                const found = segments.find((s) => s.id === e.target.value);
                if (found) pick(found);
              }}
            >
              <option value="">Choose a group you saved</option>
              {segments.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="block">
          <span className="field-label">Send to</span>
          <select
            id="mail-send-to"
            className="field mt-2"
            value={who === "all" ? productId : `@${who}`}
            onChange={(e) => {
              // The two kinds of reader are choices of their own, beside the
              // products: picking one clears the other.
              const value = e.target.value;
              if (value === "@buyers" || value === "@leads") {
                setWho(value === "@buyers" ? "buyers" : "leads");
                setProductId("");
              } else {
                setWho("all");
                setProductId(value);
              }
            }}
          >
            <option value="">Everyone you can write to</option>
            <option value="@buyers">Everyone who has bought something</option>
            <option value="@leads">Everyone who has not bought yet</option>
            {props.products.map((p) => (
              <option key={p.id} value={p.id}>{`Only those who got ${p.title}`}</option>
            ))}
          </select>
        </label>
        {/*
          And who to leave out.

          The letter that sells is the one to the people who took the free
          thing and have not bought the paid one, and until this box existed
          there was no way to address it: you could write to everybody, or to
          the buyers of one product, and not to the difference between them.
          It reads what every contact has carried from the start — what they
          asked for or bought — so nothing new is recorded about anyone.
        */}
        <label className="block">
          <span className="field-label">Leave out</span>
          <select className="field mt-2" value={notProductId} onChange={(e) => setNotProductId(e.target.value)}>
            <option value="">Nobody</option>
            {props.products
              .filter((p) => p.id !== productId)
              .map((p) => (
                <option key={p.id} value={p.id}>{`Anyone who already got ${p.title}`}</option>
              ))}
          </select>
          <span className="field-hint mt-1 block">
            {notProductId
              ? "They will not get this one. Use it to write to the people who have not bought yet."
              : "Everyone chosen above gets it."}
          </span>
        </label>
        {/* 99 [E2-TAG-BROADCAST]: the labels an import or a sequence puts on people, read from the same record, so choosing one costs no extra read. */}
        <div>
          <label className="block" htmlFor="mail-label">
            <span className="field-label">Only people with the label (optional)</span>
          </label>
          <input id="mail-label" className="field mt-2" value={label} maxLength={MAX_TAG_LENGTH} autoComplete="off" spellCheck={false} aria-describedby="mail-label-hint" onChange={(e) => setLabel(e.target.value)} />
          <span id="mail-label-hint" className="field-hint mt-1 block">
            {cleanLabel
              ? `Only people chosen above who carry the label “${cleanLabel}” get it. Capital letters do not matter.`
              : "Leave it empty to write to everyone chosen above. Labels come from your import, a sequence or the API, and each person’s are on their page under People."}
          </span>
        </div>
        {/*
          And four ways no list can choose by itself: what they spent, where
          they first found the store, and how long since they last bought.
          Read from the creator's own Stripe account when the email goes out
          (lib/segments.ts); nothing is recorded about anybody to do it.
        */}
        <details className="rounded-[12px] bg-paper px-4 py-3 ring-1 ring-line" open={more} onToggle={(e) => setMore((e.currentTarget as HTMLDetailsElement).open)}>
          <summary className="cursor-pointer text-sm font-semibold text-ink">More ways to choose: what they spent, where they came from, when they last bought, what kind of buyer they are</summary>
          <div className="mt-3 space-y-4">
            <label className="block">
              <span className="field-label">Spent with you at least</span>
              <input
                className="field mt-2"
                inputMode="decimal"
                placeholder={`For example: ${plainAmount(10000, props.currency)}`}
                value={spentText}
                aria-invalid={invalidSpent || undefined}
                aria-describedby="recipient-spend-hint"
                onChange={(e) => setSpentText(e.target.value)}
              />
              <span id="recipient-spend-hint" className="field-hint mt-1 block">
                {invalidSpent ? `Enter an amount from 0 to ${plainAmount(MAX_SPENT, props.currency)} without a currency sign.` : `In ${props.currency.toUpperCase()}, everything they paid you, extras included. Empty for any amount. Zero sets no minimum.`}
              </span>
            </label>
            <label className="block">
              <span className="field-label">First found you through</span>
              <select className="field mt-2" value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="">Anywhere</option>
                {[...new Set([...(channels ?? []), ...(channel ? [channel] : [])])].map((c) => (
                  <option key={c} value={c}>{channelName(c)}</option>
                ))}
              </select>
              <span className="field-hint mt-1 block">
                {channels === null ? "Reading where your buyers came from…" : channel && !channels.includes(channel) ? "The original channel is kept even though it is not in the current list. Keep it or choose another." : channels.length ? "Where they were when they first bought." : "Nobody has bought yet, so there is no channel to choose."}
              </span>
            </label>
            <label className="block">
              <span className="field-label">Has not bought in the last</span>
              <select className="field mt-2" value={quietDays} onChange={(e) => setQuietDays(Number(e.target.value))} aria-describedby="mail-active-help">
                <option value={0}>Any time</option>
                {QUIET_DAYS.map((d) => (
                  <option key={d} value={d}>{`${d} days, but has bought before`}</option>
                ))}
              </select>
            </label>
            {/* 461 [EL5]: the buyers still active, from the same buyers' ledger. */}
            <label className="block">
              <span className="field-label">Bought in the last</span>
              <select className="field mt-2" value={activeDays} onChange={(e) => setActiveDays(Number(e.target.value))} aria-describedby="mail-active-help">
                <option value={0}>Any time, or never</option>
                {ACTIVE_DAYS.map((d) => (
                  <option key={d} value={d}>{`${d} days`}</option>
                ))}
              </select>
              <span id="mail-active-help" className="field-hint mt-1 block" aria-live="polite">
                {quietDays && activeDays && activeDays <= quietDays ? "Nobody can both have bought in these days and not have bought in the days above. Change one of them." : "Your buyers who are still active: those who bought from you in these days."}
              </span>
            </label>
            {/* 270 [GR1], unit 3b: the groups of lib/rfm-rules.ts, each with its rule, from the same buyers' ledger as the three above. */}
            <div>
              <label className="block" htmlFor="mail-group">
                <span className="field-label">Only one kind of buyer</span>
              </label>
              <select id="mail-group" className="field mt-2" value={buyerGroup} aria-describedby="mail-group-hint" onChange={(e) => setBuyerGroup(e.target.value as RfmGroup | "")}>
                <option value="">No kind: everyone chosen above</option>
                {RFM_GROUPS.map((g) => (
                  <option key={g.id} value={g.id}>{kinds && kinds[g.id] !== undefined ? `${g.name} (${n(kinds[g.id] as number)} ${kinds[g.id] === 1 ? "buyer" : "buyers"})` : g.name}</option>
                ))}
              </select>
              <span id="mail-group-hint" className="field-hint mt-1 block">
                {`${buyerGroup ? RFM_GROUPS.find((g) => g.id === buyerGroup)?.rule ?? "" : "Each kind is one rule about how recently and how often someone bought, and nobody is two kinds at once. Choose one to see its rule."}${kinds ? " The number beside each kind is all your buyers of that kind, on your list or not, before the choices above." : ""}`}
              </span>
            </div>
            <p className="text-xs text-ink-soft">
              Only buyers can match these four. They are read from your Stripe account and your PayPal sales when the email goes
              out; support for your work is not counted. Payments of memberships and payment plans count toward what someone spent
              and when they last paid. A purchase or a payment refunded, or held or lost in a dispute, does not count; for PayPal, only a sale refunded in full
              is taken off. A sale in another currency counts as a purchase for where
              they came from and when they last bought, but its amount is not added to what they spent, which counts only your
              store&apos;s currency.
              {partial ? " There is more to read than one reading takes, so the oldest sales, refunds or disputes may be left out and these counts may be a little off." : ""}
            </p>
          </div>
        </details>
        <p className="text-sm font-semibold text-ink" role="status">{invalidSpent ? "Correct the spending amount before checking recipients." : reach === null ? (reachPending ? "Checking recipients…" : "The recipient count is unavailable. Check it again before sending or scheduling.") : `${n(reach)} ${reach === 1 ? "person" : "people"}`}</p>
        {/* What this email is of the month's emails, from the two numbers already on the page (lib/send-count.ts), read out when it changes. */}
        <p className={`text-sm ${monthCount?.over ? "font-semibold text-ink" : "text-ink-soft"}`} aria-live="polite" data-send-count>{monthCount?.line ?? ""}</p>
        {reach === null && !invalidSpent ? <button type="button" className="btn btn-secondary btn-sm" disabled={locked || reachPending} aria-busy={reachPending} onClick={() => setCountRevision(value => value + 1)}>{reachPending ? "Checking recipients…" : "Check recipients again"}</button> : null}
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="field-label">Save who this goes to as a group</span>
            <input className="field mt-2" maxLength={60} placeholder="Spring launch buyers" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || invalidSpent || !groupName.trim()}
            onClick={() => void group({ action: "segment-save", name: groupName, who, productId, notProductId, narrow, label: cleanLabel }, "Group saved.")}
          >
            Save group
          </button>
          {segments.some((s) => s.name.toLowerCase() === groupName.trim().toLowerCase()) ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => {
                const found = segments.find((s) => s.name.toLowerCase() === groupName.trim().toLowerCase());
                if (found) void group({ action: "segment-remove", id: found.id }, "Group removed.");
              }}
            >
              Remove group
            </button>
          ) : null}
        </div>
        {props.canSend ? (
        <fieldset>
          <legend className="field-label">When</legend>
          <div className="mt-2 flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input id={later ? undefined : "mail-when"} type="radio" name="when" checked={!later} onChange={() => { setLater(false); setConfirming(false); setError(value => value === MESSAGES.when ? null : value); }} /> Now
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="when" checked={later} onChange={() => { setLater(true); setScheduleNow(Date.now()); setConfirming(false); setError(value => value === MESSAGES.when ? null : value); }} /> At a time I choose
            </label>
          </div>
          {later ? (
            <label className="mt-3 block">
              <span className="sr-only">Date and time, in your own time zone</span>
              <input id="mail-when" type="datetime-local" className="field" value={at} aria-invalid={at !== "" && invalidSchedule || undefined} aria-describedby="mail-schedule-hint" onChange={(e) => { setAt(e.target.value); setScheduleNow(Date.now()); setConfirming(false); setError(value => value === MESSAGES.when ? null : value); }} />
              <span id="mail-schedule-hint" className="field-hint mt-1 block">{at !== "" && invalidSchedule ? "Choose a future date and time, within the next 365 days." : "In your device’s time zone. Choose a future time within the next 365 days; it is checked again before scheduling."}</span>
            </label>
          ) : null}
        </fieldset>
        ) : null}
        {confirming && reach !== null ? (
          // No live region: it would read the whole list again at every key typed in the subject. Its heading takes the focus when it opens.
          <div id="mail-send-review" className="rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink">
            <h3 id="mail-send-review-title" tabIndex={-1} className="font-semibold">Check before it goes out</h3>
            {/* A summary list, one answer a row, each with its own "Change" (GOV.UK "Check answers"). */}
            <dl className="mt-2 divide-y divide-line">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                <dt className="basis-full font-semibold sm:basis-28 sm:shrink-0">Subject</dt>
                <dd className="min-w-0 basis-full break-words sm:basis-0 sm:flex-1">{subject.trim() || "No subject yet"}</dd>
                <dd><button type="button" className="inline-flex min-h-11 items-center font-bold underline underline-offset-4" onClick={() => changeAnswer("mail-subject")}>Change<span className="sr-only"> subject</span></button></dd>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                <dt className="basis-full font-semibold sm:basis-28 sm:shrink-0">Who gets it</dt>
                <dd className="min-w-0 basis-full break-words sm:basis-0 sm:flex-1">
                  {`${n(reach)} ${reach === 1 ? "person" : "people"}`}
                  <AudienceSummary audience={{ who, productId: productId || null, notProductId, narrow, label: cleanLabel || null }} products={props.products} currency={props.currency} />
                </dd>
                <dd><button type="button" className="inline-flex min-h-11 items-center font-bold underline underline-offset-4" onClick={() => changeAnswer("mail-send-to")}>Change<span className="sr-only"> who gets it</span></button></dd>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                <dt className="basis-full font-semibold sm:basis-28 sm:shrink-0">When</dt>
                <dd className="min-w-0 basis-full break-words sm:basis-0 sm:flex-1">
                  {later ? scheduledAt === null ? "Choose a valid future time before confirming." : (
                    <><time dateTime={new Date(scheduledAt).toISOString()} className="font-semibold">{new Date(scheduledAt).toLocaleString(undefined, { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}</time> ({Intl.DateTimeFormat().resolvedOptions().timeZone})</>
                  ) : "Now: sending starts after you confirm."}
                </dd>
                <dd><button type="button" className="inline-flex min-h-11 items-center font-bold underline underline-offset-4" onClick={() => changeAnswer("mail-when")}>Change<span className="sr-only"> when</span></button></dd>
              </div>
            </dl>
            <SubjectTestReview preview={testPreview} />
            <p id="mail-send-note" className="mt-2">Eligibility is checked again when sending starts.</p>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            aria-busy={busy} disabled={busy}
            className="btn btn-secondary"
            onClick={() => send({ action: "test", subject, body }, `Test sent to ${props.email}.`)}
          >
            Send me a test
          </button>
          <button
            type="button"
            aria-busy={busy}
            disabled={busy || draftSaveBlocked || invalidSpent || !subject.trim() || !body.trim()}
            className="btn btn-secondary"
            onClick={() => void keep()}
          >
            {draftId ? "Save the draft" : "Save as a draft"}
          </button>
          {!props.canSend ? null : confirming && reach !== null ? (
            <>
              <button
                type="button"
                aria-busy={busy} disabled={busy || props.broadcastUnconfirmed || invalidSchedule || invalidTest || !subject.trim() || !body.trim()}
                aria-describedby="mail-send-note"
                className="btn btn-primary"
                onClick={async () => {
                  const sendAt = later ? scheduledAt ?? undefined : undefined;
                  const ok = await send(
                    {
                      action: "broadcast",
                      subject,
                      body,
                      productId,
                      notProductId,
                      who,
                      narrow,
                      label: cleanLabel,
                      sendAt,
                      draftId: draftId || undefined,
                      draftSavedAt: draftId ? draftSavedAt : undefined,
                      test: testing ? { subjectB, share, hours, by } : undefined,
                    },
                    later ? "Your email is scheduled." : "Your email is on its way.",
                  );
                  if (ok) {
                    setSubject("");
                    setBody("");
                    setDraftId("");
                    setTesting(false);
                    setSubjectB("");
                    props.onDone();
                    router.refresh();
                  }
                }}
              >
                {later ? `Yes, schedule it for ${n(reach)}` : `Yes, send it to ${n(reach)}`}
              </button>
              <button type="button" className="text-sm font-bold text-ink-soft underline underline-offset-4" onClick={() => setConfirming(false)}>
                Not yet
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy || props.broadcastUnconfirmed || !subject.trim() || !body.trim() || reach === null || reach === 0 || invalidSchedule || invalidTest}
              className="btn btn-primary"
              onClick={() => {
                if (props.broadcastUnconfirmed || invalidTest) return;
                if (later && readMailSchedule(at, Date.now()) === null) { setScheduleNow(Date.now()); setError(MESSAGES.when); return; }
                setConfirming(true);
                // The review opens with the focus on its heading, so it is read once, in order.
                requestAnimationFrame(() => document.getElementById("mail-send-review-title")?.focus());
              }}
            >
              {later ? "Schedule" : "Send"}
            </button>
          )}
        </div>
        {props.canSend ? null : (
          <p className="text-sm text-ink-soft">
            Sending to the list is for the store&apos;s owner and Admins. Save it as a draft and they can read it, send it or
            schedule it from this page.
          </p>
        )}
        {props.broadcastUnconfirmed ? <p role="status" className="text-sm text-ink-soft">Sending and scheduling are paused on this page because the last campaign could not be confirmed. Save your text as a draft, then reload this page and check Sent and scheduled before trying again; the campaign may already exist.</p> : null}
        <Feedback error={error} done={null} />
      </fieldset>
      {uncertainDrafts !== null ? <div className="mt-4 space-y-3">
        <p role="status" className="text-sm text-ink-soft">{draftSaveBlocked ? "Reload saved drafts and check whether this email was saved before saving again. Your current text stays here." : "The saved drafts list was refreshed. Review it before saving again; an earlier save may already be there."}</p>
        <button type="button" className="btn btn-secondary btn-sm" disabled={locked} aria-busy={refreshingDrafts} onClick={() => startDraftRefresh(() => router.refresh())}>{refreshingDrafts ? "Reloading drafts…" : "Reload saved drafts"}</button>
      </div> : null}
    </section>
  );
}

/** The store's drafts: open one into the composer, or throw it away. */
function Drafts({
  currency,
  readFailed,
  drafts,
  products,
  open,
  onOpen,
}: {
  currency: string;
  drafts: DraftRow[];
  readFailed: boolean;
  products: { id: string; title: string }[];
  open: DraftRow | null;
  onOpen: (draft: DraftRow | null) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const locked = busy !== null || refreshing;
  const [error, setError] = useState<string | null>(null);
  if (readFailed) return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="drafts-title">
      <h2 id="drafts-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Drafts</h2>
      <p role="status" className="mt-3 text-sm text-ink-soft">Saved drafts are unavailable. Reload to check them before opening or deleting a draft. Your current email stays in the composer.</p>
      <button type="button" className="btn btn-secondary mt-3" disabled={locked} aria-busy={refreshing} onClick={() => startRefresh(() => router.refresh())}>
        {refreshing ? "Reloading drafts…" : "Reload saved drafts"}
      </button>
    </section>
  );
  if (!drafts.length) return null;
  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="drafts-title">
      <h2 id="drafts-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Drafts</h2>
      <button type="button" className="btn btn-secondary mt-3" disabled={locked} aria-busy={refreshing} onClick={() => startRefresh(() => router.refresh())}>
        {refreshing ? "Reloading drafts…" : "Reload saved drafts"}
      </button>
      <ul className="mt-4 divide-y divide-line">
        {drafts.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
            <div className="min-w-0">
              <span className="block break-words font-semibold text-ink">{d.subject}</span>
              <span className="block text-sm text-ink-soft">
                {`Saved by ${d.by || "someone"}, `}
                <When seconds={Math.floor(new Date(d.savedAt).getTime() / 1000)} />
              </span>
              <AudienceSummary audience={d} products={products} currency={currency} />
              {d.subjectTest ? <p className="mt-1 text-sm text-ink-soft">Subject test draft saved · {d.subjectTest.share}% · {hoursWords(d.subjectTest.hours)} · {d.subjectTest.by === "sales" ? "sales" : "visits"}. Review both subjects and the current audience before sending.</p> : null}
            </div>
            <span className="flex items-center gap-4">
              <button
                type="button"
                className="inline-flex min-h-11 -my-2.5 items-center text-sm font-bold text-violet-deep underline underline-offset-4"
                aria-current={open?.id === d.id ? "true" : undefined}
                disabled={locked}
                onClick={() => {
                  onOpen(d);
                  document.getElementById("compose-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                {open?.id === d.id ? "Open above" : "Open"}
              </button>
              <button
                type="button"
                disabled={locked}
                aria-busy={busy === d.id || refreshing}
                className="inline-flex min-h-11 -my-2.5 items-center text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger"
                onClick={async () => {
                  if (locked || !window.confirm("Delete this draft?")) return;
                  setError(null);
                  setBusy(d.id);
                  const a = await call({ action: "draft-remove", id: d.id, expectedSavedAt: d.savedAt });
                  setBusy(null);
                  if (!a.ok) {
                    setError("Removal of “" + d.subject + "” could not be confirmed. Reload your saved drafts to check its current status. " + message(a));
                    return;
                  }
                  if (a.ok) {
                    toast("Draft deleted.");
                    if (open?.id === d.id) onOpen(null);
                    startRefresh(() => router.refresh());
                  }
                }}
              >
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      {refreshing ? <p role="status" className="mt-3 text-sm text-ink-soft">Loading saved drafts…</p> : null}
      <Feedback error={error} done={null} />
    </section>
  );
}

/** The second subject line an email tried: what is happening, or what happened and why. */
function TestLine({ test, status }: { test: SubjectTest; status: string }) {
  if (test.skipped) {
    return (
      <p className="mt-1 text-sm text-ink-soft">
        {`The list was under ${MIN_TEST_REACH} people when this went out, so the second subject was not tried and everyone got the first.`}
      </p>
    );
  }
  if (test.winner) {
    return (
      <p className="mt-1 text-sm text-ink-soft">
        <span className="font-semibold text-ink">{`Second subject: ${test.subjectB}. `}</span>
        {test.why}
      </p>
    );
  }
  if (status === "cancelled" || status === "failed") return null;
  return (
    <p className="mt-1 text-sm text-ink-soft">
      <span className="font-semibold text-ink">{`Second subject: ${test.subjectB}. `}</span>
      {test.endsAt ? (
        <>
          {`${n(test.a)} got the first and ${n(test.b)} the second. The better one is chosen `}
          <When seconds={test.endsAt} />
          {", and the rest go out then."}
        </>
      ) : (
        `Tried on ${test.share}% of the list, half each; the rest get the better one ${hoursWords(test.hours)} after.`
      )}
    </p>
  );
}

const STATUS: Record<string, string> = {
  scheduled: "Scheduled",
  sending: "Going out",
  sent: "Sent",
  waiting: "Waiting",
  cancelled: "Canceled",
  failed: "Stopped",
};

/** "a day", "3 days", "5 hours": how long after joining a kept email goes. */
function waitWords(hours: number): string {
  if (hours % 24 === 0) return hours === 24 ? "a day" : `${hours / 24} days`;
  return hours === 1 ? "an hour" : `${hours} hours`;
}

/**
 * Publishing a sent email on the store, or taking it off (lib/letter-rules.ts):
 * asked before it is published, because anyone can read it once it is.
 */
function PublishControl({ id, path, disabled, onDone }: { id: string; path: string | null; disabled: boolean; onDone: () => void }) {
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(action: "publish" | "unpublish") {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch("/api/store/letters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id }) });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (data.ok !== true) setError(data.message ?? MESSAGES.server_error);
      else {
        toast(action === "publish" ? "Published on your store." : "Taken off your store.");
        setAsking(false);
        onDone();
      }
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setWorking(false);
    }
  }
  if (path) {
    return (
      <span className="inline-flex min-h-11 flex-wrap items-center gap-x-4 text-sm">
        <a href={path} className="font-bold text-ink underline underline-offset-4">Published on your store</a>
        <button type="button" disabled={disabled || working} aria-busy={working} className="font-bold text-ink-soft underline underline-offset-4 hover:text-danger" onClick={() => act("unpublish")}>
          Take it off
        </button>
        {error ? <span role="alert" className="text-danger">{error}</span> : null}
      </span>
    );
  }
  return asking ? (
    <span className="block w-full rounded-[var(--r-sm)] bg-sand p-3 text-sm text-ink">
      <span className="block">{PUBLISH_WARNING}</span>
      <span className="mt-2 flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary btn-sm" disabled={disabled || working} aria-busy={working} onClick={() => act("publish")}>Publish it</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={working} onClick={() => setAsking(false)}>Not now</button>
      </span>
      {error ? <span role="alert" className="mt-2 block text-danger">{error}</span> : null}
    </span>
  ) : (
    <button type="button" disabled={disabled} className="inline-flex min-h-11 items-center text-sm font-bold text-ink underline underline-offset-4" onClick={() => setAsking(true)}>
      Publish on your store
    </button>
  );
}

function History({
  readFailed,
  broadcasts,
  writeUnconfirmed,
  onWriteUnconfirmed,
  flowsReadFailed,
  products,
  canSend,
  onOpen,
  currency,
}: {
  broadcasts: BroadcastRow[];
  readFailed: boolean;
  writeUnconfirmed: boolean;
  onWriteUnconfirmed: () => void;
  flowsReadFailed: boolean;
  products: { id: string; title: string }[];
  canSend: boolean;
  /** Puts a sent email back in the composer, as a new one. */
  onOpen: (draft: DraftRow | null) => void;
  currency: string;
}) {
  const router = useRouter();
  const [operationBusy, setBusy] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const refreshHistory = () => startRefresh(() => router.refresh());
  const busy = operationBusy || refreshing;
  const keepBlocked = busy || readFailed || writeUnconfirmed || flowsReadFailed;
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<HistoryStatus>("all");
  if (readFailed) return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="history-title">
      <h2 id="history-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Sent and scheduled</h2>
      <p role="status" className="mt-3 text-sm text-ink-soft">Campaign history could not be confirmed. A missing row does not mean an earlier send or schedule failed. Reload the history before trying again; your current message stays in the editor.</p>
      <button type="button" className="btn btn-secondary mt-3" disabled={busy} aria-busy={refreshing} onClick={refreshHistory}>{refreshing ? "Reloading campaign history…" : "Reload campaign history"}</button>
    </section>
  );
  if (!broadcasts.length) return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="history-title">
      <h2 id="history-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Sent and scheduled</h2>
      <p className="mt-3 text-sm text-ink-soft">{`No campaigns are recorded in this history. ${canSend ? "Your first email shows here once you send or schedule it with the editor above." : "An email shows here once the owner or an Admin sends or schedules it."} If an earlier attempt was unconfirmed, check before sending it again.`}</p>
      <button type="button" className="btn btn-secondary mt-3" disabled={busy} aria-busy={refreshing} onClick={refreshHistory}>{refreshing ? "Reloading campaign history…" : "Reload campaign history"}</button>
    </section>
  );

  const view = campaignHistoryView(broadcasts, query, status);
  const filtered = Boolean(query.trim()) || status !== "all";

  /** A sent email's subject and text, back in the composer to change and send. */
  async function again(b: BroadcastRow) {
    if (busy || readFailed) return;
    setBusy(true);
    setError(null);
    const a = await call({ action: "copy", id: b.id });
    setBusy(false);
    const copy = confirmedMailCopy(a);
    if (!copy) return setError(a.ok ? "The email copy could not be confirmed. Your current draft is unchanged. Try copying again when you are ready." : message(a));
    // No id: it is a new email, not the draft of an old one. The time makes
    // the composer start afresh even when the same email is opened twice.
    onOpen({ id: "", subject: copy.subject, body: copy.body, productId: copy.productId, who: copy.who, notProductId: copy.notProductId, narrow: copy.narrow, label: copy.label ?? null, by: "", savedAt: String(Date.now()) });
    document.getElementById("compose-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** The email joins a sequence, and goes by itself to everybody who arrives from now on. */
  async function keep(b: BroadcastRow) {
    if (keepBlocked) return;
    setBusy(true);
    setError(null);
    const a = await call({ action: "keep", id: b.id });
    setBusy(false);
    if (!a.ok) {
      if (a.error === "flow_write_unconfirmed") onWriteUnconfirmed();
      return setError(a.error === "too_many" ? MESSAGES.too_many_flows : message(a));
    }
    const waitHours = keptWaitHours(a);
    if (waitHours === null) {
      onWriteUnconfirmed();
      setError(MESSAGES.flow_write_unconfirmed);
      return;
    }
    toast(`Done. ${keptWords(b, products)} from now on gets this email ${waitWords(waitHours)} later. It is under Sequences, switched on.`);
    refreshHistory();
  }
  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="history-title">
      <h2 id="history-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Sent and scheduled</h2>
      <button type="button" className="btn btn-secondary mt-3" disabled={busy} aria-busy={refreshing} onClick={refreshHistory}>{refreshing ? "Reloading campaign history…" : "Reload campaign history"}</button>
      <p className="mt-2 text-sm text-ink-soft">
        A visit is a page of your store opened through one of an email&apos;s links, and a sale is one made on that page.
        Nothing in an email reports back, so there is no open rate here, and nothing is kept about who visited. (In sequences,
        readers who allowed it are counted as having used a link or not, only to choose their next email.)
      </p>
      {writeUnconfirmed || flowsReadFailed ? <div className="notice notice-warn mt-4"><p role="status">Reload and check the saved sequences before keeping another email sending. An unconfirmed change may already have happened.</p><button type="button" className="btn btn-secondary mt-3" disabled={busy} onClick={() => { setError(null); refreshHistory(); }}>Reload saved sequences from history</button></div> : null}
      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,auto)]">
        <label className="text-sm font-semibold text-ink" htmlFor="history-search">
          Search campaign subjects
          <input id="history-search" type="search" className="input mt-1 w-full" value={query} maxLength={150} disabled={busy} aria-describedby="history-scope history-results" onChange={e => setQuery(e.target.value)} placeholder="Find a campaign…" />
        </label>
        <label className="text-sm font-semibold text-ink" htmlFor="history-status">
          Campaign status
          <select id="history-status" className="input mt-1 w-full" value={status} disabled={busy} aria-describedby="history-scope history-results" onChange={e => setStatus(e.target.value as HistoryStatus)}>
            {HISTORY_STATUSES.map(value => <option key={value} value={value}>{value === "all" ? "All statuses" : STATUS[value]} ({n(view.counts[value])})</option>)}
          </select>
        </label>
      </div>
      <p id="history-scope" className="mt-2 text-sm text-ink-soft">Search and status counts cover only the campaigns loaded in this history. Status counts are before search.</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p id="history-results" role="status" className="text-sm text-ink-soft">Showing {n(view.rows.length)} of {n(broadcasts.length)} loaded campaigns.</p>
        {filtered ? <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setQuery(""); setStatus("all"); }}>Clear history filters</button> : null}
      </div>
      {!view.rows.length ? <p className="mt-4 text-sm text-ink-soft">No loaded campaigns match these filters. Clear the filters to see the loaded history.</p> : null}
      <p className="mt-2 text-sm text-ink-soft">Audience summaries describe saved criteria, not individual recipients or delivery. Product titles use the current catalog.</p>
      <ul className="mt-4 divide-y divide-line">
        {view.rows.map((b) => (
          <li key={b.id} className="py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="min-w-0 break-words font-semibold text-ink">{b.subject}</p>
              <span className="tag">{STATUS[b.status] ?? b.status}</span>
            </div>
            <p className="mt-1 text-sm text-ink-soft">
              {b.status === "scheduled" ? (
                <>
                  {"Goes out "}
                  <When seconds={b.sendAt} />
                  {` to ${n(b.total)} ${b.total === 1 ? "person" : "people"}`}
                </>
              ) : (
                <>
                  {`${n(b.sent)} of ${n(b.total)} sent`}
                  {b.finishedAt ? (
                    <>
                      {", "}
                      <When seconds={b.finishedAt} />
                    </>
                  ) : null}
                </>
              )}
            </p>
            <AudienceSummary audience={b} products={products} currency={currency} />
            {b.note ? <p className="mt-1 text-sm text-ink-soft">{b.note}</p> : null}
            {b.test ? <TestLine test={b.test} status={b.status} /> : null}
            {/* Said only for an email whose links were tagged: for an older
                one nothing could be counted, and "no sales" would be a guess. */}
            {b.status === "sent" && b.tagged ? (
              <p className="mt-1 text-sm font-semibold text-ink">{broughtWords(b.visits, b.money, currency)}</p>
            ) : null}
            {b.status === "scheduled" && canSend ? (
              <button
                type="button"
                aria-busy={busy} disabled={busy}
                className="mt-2 text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger"
                onClick={async () => {
                  if (busy) return;
                  setBusy(true);
                  setError(null);
                  const a = await call({ action: "cancel", id: b.id });
                  setBusy(false);
                  if (!a.ok) {
                    setError("Cancellation of “" + b.subject + "” could not be confirmed. Reload to check its current status. " + message(a));
                    return;
                  }
                  toast("Scheduled email canceled.");
                  refreshHistory();
                }}
              >
                Cancel it
              </button>
            ) : null}
            {b.status === "sent" ? (
              <div className="mt-1 flex flex-wrap gap-x-5">
                <button
                  type="button"
                  aria-busy={busy} disabled={busy}
                  className="inline-flex min-h-11 items-center text-sm font-bold text-ink underline underline-offset-4"
                  onClick={() => again(b)}
                >
                  Write it again
                </button>
                {canSend ? <PublishControl id={b.id} path={b.published ?? null} disabled={busy} onDone={refreshHistory} /> : null}
                {/* Not offered for an email narrowed two ways at once: an
                    email in a sequence keeps one condition (lib/mail-reuse.ts). */}
                {canSend && keepable(b) ? (
                  <button
                    type="button"
                    aria-busy={busy} disabled={keepBlocked}
                    className="inline-flex min-h-11 items-center text-left text-sm font-bold text-ink underline underline-offset-4"
                    onClick={() => keep(b)}
                  >
                    {`Keep sending it to ${keptWords(b, products).replace(/^Everyone/, "everyone")}`}
                  </button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <Feedback error={error} done={null} />
    </section>
  );
}

/**
 * One email of a sequence as the form holds it. `when` is "" for everyone;
 * its product or label is kept apart, so switching between conditions does
 * not lose what was chosen (lib/flow-rules.ts).
 */
type StepDraft = {
  /** Local editor identity, never included in the saved sequence payload. */
  editorKey: string;
  id?: string;
  /** An email, or a step that acts instead (lib/flow-rules.ts, FlowAction). */
  kind: "email" | "tag" | "untag" | "start" | "webhook" | "field" | "deal" | "note" | "notify" | "wait" | "assign";
  actionTag: string;
  /** For a step that makes a teammate responsible for the person's deal. */
  actionAssignee: string;
  actionFlow: string;
  /** For a step that sets a field: which, and to what. */
  actionField: string;
  actionValue: string;
  /** For a step that puts the person's deal in a stage: which stage, and a new deal's title. */
  actionStage: string;
  actionTitle: string;
  /** For a step that writes a note on the person's page. */
  actionText: string;
  wait: string;
  unit: "hours" | "days";
  subject: string;
  body: string;
  when: StepIf | "";
  whenProduct: string;
  whenTag: string;
  otherwise: "skip" | "end" | "jump";
  /** The later step's id those the condition does not hold for go to, for "jump". */
  jump: string;
  /** After this step: "" for the next one, "end", or a later step's id. */
  next: string;
};
type FlowDraft = {
  id?: string;
  name: string;
  trigger: FlowTrigger;
  productId: string;
  /** The label that starts it, for "tagged". */
  triggerTag: string;
  /** The form that starts it, for "form". */
  formId: string;
  /** For "form" on a quiz: the one result that starts it, or "" for everyone who sends it. */
  formOutcome: string;
  /** The deal stage that starts it, for "stage". */
  stageId: string;
  active: boolean;
  steps: StepDraft[];
  /** When it ends early: never, once they have bought anything, once they get one product, or once they carry a label. */
  goal: "" | "any" | "product" | "tag";
  goalProduct: string;
  goalTag: string;
};

/** What each condition is called in the form, in the order offered. */
const STEP_IF_WORDS: { value: StepIf | ""; label: string }[] = [
  { value: "", label: "Everyone still in the sequence" },
  { value: "lacks", label: "Only those who do not have a product" },
  { value: "has", label: "Only those who have a product" },
  { value: "lead", label: "Only those who have not bought anything yet" },
  { value: "buyer", label: "Only those who have bought something" },
  { value: "tag", label: "Only those with a label" },
  { value: "untagged", label: "Only those without a label" },
  { value: "clicked", label: "Only those who used a link in the email before" },
  { value: "unclicked", label: "Only those who did not use a link in the email before" },
  { value: "unstarted", label: "Only those who have not opened a course" },
  { value: "started", label: "Only those who have opened a course" },
  { value: "unfinished", label: "Only those who have not finished a course" },
  { value: "finished", label: "Only those who have finished a course" },
  { value: "half-a", label: "Only the first half of the sequence (A)" },
  { value: "half-b", label: "Only the second half of the sequence (B)" },
];

/** A step id the server keeps (lib/flows.ts, FLOW_ID), made here so a branch can name a step before it is saved. */
function newStepId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function blankStep(wait: string, unit: "hours" | "days", firstProduct: string): StepDraft {
  return { editorKey: crypto.randomUUID(), id: newStepId(), kind: "email", actionTag: "", actionAssignee: "", actionFlow: "", actionField: "", actionValue: "", actionStage: "", actionTitle: "", actionText: "", wait, unit, subject: "", body: "", when: "", whenProduct: firstProduct, whenTag: "", otherwise: "skip", jump: "", next: "" };
}

/** What a step that acts does, as one line reads it: "gives the label “warm”". */
function actionWords(action: FlowAction, flows: { id: string; name: string }[]): string {
  if (action.do === "start") {
    const target = action.flowId;
    return `starts the sequence “${flows.find((f) => f.id === target)?.name ?? "a sequence no longer in your store"}”`;
  }
  if (action.do === "webhook") return "tells your webhooks who reached it";
  if (action.do === "field") return `sets a field to “${action.value}”`;
  if (action.do === "deal") return "puts their deal in a stage of your deals board";
  if (action.do === "note") return "writes a note on their page";
  if (action.do === "notify") return "emails you who reached it";
  if (action.do === "wait") return "only waits";
  if (action.do === "assign") return `makes ${action.assignee} responsible for their deal`;
  return action.do === "tag" ? `gives the label “${action.tag}”` : `takes off the label “${action.tag}”`;
}

/** "3 emails" or "2 emails and 1 action". */
function stepCount(steps: Pick<FlowStep, "action">[]): string {
  const actions = steps.filter((s) => s.action).length;
  const emails = steps.length - actions;
  const e = `${emails} ${emails === 1 ? "email" : "emails"}`;
  return actions ? `${e} and ${actions} ${actions === 1 ? "action" : "actions"}` : e;
}

/** The action a step draft stands for, as the server reads it; null for an email. */
function actionOf(s: StepDraft): FlowAction | null {
  if (s.kind === "tag" || s.kind === "untag") return { do: s.kind, tag: s.actionTag };
  if (s.kind === "start") return { do: "start", flowId: s.actionFlow };
  if (s.kind === "webhook") return { do: "webhook" };
  if (s.kind === "field") return { do: "field", field: s.actionField, value: s.actionValue };
  if (s.kind === "deal") return { do: "deal", stage: s.actionStage, title: s.actionTitle };
  if (s.kind === "note") return { do: "note", text: s.actionText };
  if (s.kind === "notify") return { do: "notify" };
  if (s.kind === "wait") return { do: "wait" };
  if (s.kind === "assign") return { do: "assign", assignee: s.actionAssignee };
  return null;
}

function stepToDraft(s: FlowStep, firstProduct: string): StepDraft {
  const when = s.when;
  return {
    editorKey: crypto.randomUUID(),
    id: s.id,
    kind: s.action ? s.action.do : "email",
    actionTag: s.action && "tag" in s.action ? s.action.tag : "",
    actionAssignee: s.action && "assignee" in s.action ? s.action.assignee : "",
    actionFlow: s.action && "flowId" in s.action ? s.action.flowId : "",
    actionField: s.action && "field" in s.action ? s.action.field : "",
    actionValue: s.action && "value" in s.action ? s.action.value : "",
    actionStage: s.action && "stage" in s.action ? s.action.stage : "",
    actionTitle: s.action && "title" in s.action ? s.action.title : "",
    actionText: s.action && "text" in s.action ? s.action.text : "",
    ...(s.delayHours % 24 === 0 && s.delayHours > 0 ? { wait: String(s.delayHours / 24), unit: "days" as const } : { wait: String(s.delayHours), unit: "hours" as const }),
    subject: s.subject,
    body: s.body,
    when: when?.if ?? "",
    whenProduct: when && "productId" in when ? when.productId : firstProduct,
    whenTag: when && "tag" in when ? when.tag : "",
    otherwise: s.otherwise === "end" ? "end" : s.otherwise === "jump" ? "jump" : "skip",
    jump: s.jump ?? "",
    next: s.next ?? "",
  };
}

/** The routing fields of a step draft, as the server reads them (lib/flow-paths.ts). */
function routeOf(s: StepDraft): { otherwise?: "skip" | "end" | "jump"; jump?: string; next?: string } {
  const when = conditionOf(s);
  return {
    ...(when ? { otherwise: s.otherwise, ...(s.otherwise === "jump" ? { jump: s.jump } : {}) } : {}),
    ...(s.next ? { next: s.next } : {}),
  };
}

/** The condition a step draft stands for, as the server reads it. */
function conditionOf(s: StepDraft): StepCondition | null {
  if (s.when === "has" || s.when === "lacks") return { if: s.when, productId: s.whenProduct };
  if (isCourseIf(s.when)) return { if: s.when, productId: s.whenProduct };
  if (s.when === "tag" || s.when === "untagged") return { if: s.when, tag: s.whenTag };
  if (s.when === "buyer" || s.when === "lead" || s.when === "clicked" || s.when === "unclicked" || s.when === "half-a" || s.when === "half-b") return { if: s.when };
  return null;
}

/** "Only to those who do not have The Weeknight Plan; the others skip it." */
function conditionWords(step: FlowStep, products: { id: string; title: string }[]): string {
  const when = step.when;
  if (!when) return "";
  const title = (id: string) => products.find((p) => p.id === id)?.title ?? "a product no longer in your store";
  const courseWords: Record<string, string> = { started: "have opened", unstarted: "have not opened", finished: "have finished", unfinished: "have not finished" };
  const who =
    "productId" in when && isCourseIf(when.if)
      ? `who ${courseWords[when.if]} ${title(when.productId)}`
      : "productId" in when
      ? `who ${when.if === "has" ? "have" : "do not have"} ${title(when.productId)}`
      : "tag" in when
        ? `${when.if === "tag" ? "labeled" : "not labeled"} “${when.tag}”`
        : when.if === "buyer"
          ? "who have bought something"
          : when.if === "lead"
            ? "who have not bought anything yet"
            : when.if === "clicked"
              ? "who used a link in the email before"
              : "who did not use a link in the email before";
  return `${step.action ? "Only for those" : "Only to those"} ${who}; ${step.otherwise === "end" ? "for the others, the sequence ends there" : step.otherwise === "jump" ? "the others go to a later step" : "the others skip it"}.`;
}

/** A condition as the workflow map reads it: "they have The Weeknight Plan". */
function conditionShort(when: StepCondition, products: { id: string; title: string }[]): string {
  const title = (id: string) => products.find((p) => p.id === id)?.title ?? "a product no longer in your store";
  switch (when.if) {
    case "has": return `they have ${title(when.productId)}`;
    case "lacks": return `they do not have ${title(when.productId)}`;
    case "buyer": return "they have bought something";
    case "lead": return "they have not bought anything yet";
    case "tag": return `they carry the label “${when.tag}”`;
    case "untagged": return `they do not carry the label “${when.tag}”`;
    case "clicked": return "they used a link in the email before";
    case "unclicked": return "they did not use a link in the email before";
    case "started": return `they opened ${title(when.productId)}`;
    case "unstarted": return `they have not opened ${title(when.productId)}`;
    case "finished": return `they finished ${title(when.productId)}`;
    case "unfinished": return `they have not finished ${title(when.productId)}`;
    case "half-a": return "they are in the first half (A)";
    case "half-b": return "they are in the second half (B)";
  }
}

/** "Ends for anyone who gets The Weeknight Plan." */
function goalWords(flow: Pick<Flow, "goal">, products: { id: string; title: string }[]): string {
  if (!flow.goal) return "";
  if ("any" in flow.goal) return "Ends for anyone once they have bought something";
  if ("tag" in flow.goal) return `Ends for anyone once they carry the label “${flow.goal.tag}”`;
  return `Ends for anyone who gets ${products.find((p) => "productId" in flow.goal! && p.id === flow.goal.productId)?.title ?? "a product no longer in your store"}`;
}

function toDraft(flow: FlowRow | null, products: { id: string }[]): FlowDraft {
  const first = products[0]?.id ?? "";
  if (!flow) {
    return {
      name: "Welcome",
      trigger: "joined",
      productId: first,
      triggerTag: "",
      formId: "",
      formOutcome: "",
      stageId: "",
      active: false,
      steps: [blankStep("0", "hours", first)],
      goal: "",
      goalProduct: first,
      goalTag: "",
    };
  }
  return {
    id: flow.id,
    name: flow.name,
    trigger: flow.trigger,
    productId: flow.productId ?? first,
    triggerTag: flow.tag ?? "",
    formId: flow.formId ?? "",
    formOutcome: flow.formOutcome ?? "",
    stageId: flow.stageId ?? "",
    active: flow.active,
    steps: flow.steps.map((s) => stepToDraft(s, first)),
    goal: !flow.goal ? "" : "any" in flow.goal ? "any" : "tag" in flow.goal ? "tag" : "product",
    goalProduct: flow.goal && "productId" in flow.goal ? flow.goal.productId : first,
    goalTag: flow.goal && "tag" in flow.goal ? flow.goal.tag : "",
  };
}

/** The triggers that name a product: getting it, finishing or opening a course, leaving its checkout. */
const productTrigger = (t: FlowTrigger) => t === "product" || t === "finished" || t === "started" || t === "abandoned";

/** The goal a draft stands for, as the server reads it. */
function goalOf(draft: FlowDraft): FlowGoal | null {
  return draft.goal === "any" ? { any: true } : draft.goal === "product" ? { productId: draft.goalProduct } : draft.goal === "tag" ? { tag: draft.goalTag } : null;
}

/** What the studio knows about the workflow limits it shows (lib/flow-limits.ts). */
export type WorkflowLimits = { maxActive: number; dailyRuns: number; runsToday: { started: number; refused: number } | null; held: number | null };

function Flows({
  initialSequence,
  flows,
  writeUnconfirmed,
  onWriteUnconfirmed,
  readFailed = false,
  products,
  currency,
  sells,
  courses = [],
  calls = [],
  paidProducts,
  automation = { forms: [], fields: [], stages: [] },
  limits,
  assignees = [],
}: {
  initialSequence?: LibrarySequenceDraft;
  limits?: WorkflowLimits;
  assignees?: string[];
  flows: FlowRow[];
  writeUnconfirmed: boolean;
  onWriteUnconfirmed: () => void;
  readFailed?: boolean;
  products: { id: string; title: string }[];
  currency: string;
  automation?: { forms: { id: string; name: string; outcomes?: { id: string; title: string }[] }[]; fields: { id: string; name: string; type: string; options: string[] }[]; stages: { id: string; name: string }[] };
  /** The products that are courses, for "finishes a course" and the conditions on one. */
  courses?: string[];
  /** The products that are calls: a sequence that starts with one says "books" (548 [TR1]). */
  calls?: string[];
  paidProducts?: string[];
  /** Whether the store sells anything for money, so a first purchase can happen at all. */
  sells: boolean;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const refreshFlows = () => startRefresh(() => router.refresh());
  const [draft, setDraft] = useState<FlowDraft | null>(() => {
    if (!initialSequence || readFailed || flows.some(flow => flow.trigger === initialSequence.trigger)) return null;
    return {
      ...toDraft(null,products), name:initialSequence.name,trigger:initialSequence.trigger,productId:"",active:false,
      steps:initialSequence.steps.map(step => ({
        ...blankStep(String(step.delayHours),"hours",""),id:step.id,editorKey:"template-"+step.id,subject:step.subject,body:step.body
      }))
    };
  });
  const [aiBusy, setAiBusy] = useState(false);
  const overCapacity = (draft?.steps.length ?? 0) > MAX_STEPS;
  // A saved workflow being switched on: its preview is shown first (WorkflowPreview), then the explicit button.
  const [activating, setActivating] = useState<string | null>(null);
  const [runsOpen, setRunsOpen] = useState<string | null>(null);
  const activeCount = flows.filter((f) => f.active).length;
  const availableSlots = sequenceDraftSlots(draft?.steps ?? []);
  const availableCounts = SEQUENCE_DRAFT_COUNTS.filter(count => count <= availableSlots);
  const invalidWait = draft?.steps.some(step => flowWaitHours(step.wait, step.unit) === null) ?? false;
  const [draftBaseline, setDraftBaseline] = useState<string | null>(null);
  // What a file brought in left out or changed (544 [SQ9]): shown in the editor until the sequence is saved or closed.
  const [imported, setImported] = useState<ImportReportLine[] | null>(null);
  const importedHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // The editor that opened takes the focus the box's button had, at its report's heading.
    if (imported) importedHeading.current?.focus();
  }, [imported]);
  useLeaveGuard(aiBusy || (draft !== null && JSON.stringify(draft) !== draftBaseline));
  const [draftCount, setDraftCount] = useState<number>(DEFAULT_SEQUENCE_DRAFT);
  const requestedCount = availableCounts.some(count => count === draftCount) ? draftCount : (availableCounts[0] ?? DEFAULT_SEQUENCE_DRAFT);
  // Each step's box, so a picture goes where the cursor is.
  const stepBoxes = useRef<(HTMLTextAreaElement | null)[]>([]);
  const [operationBusy, setBusy] = useState(false);
  const busy = operationBusy || refreshing || aiBusy;
  const locked = busy || writeUnconfirmed;
  const [error, setError] = useState<string | null>(null);

  if (readFailed) return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="flows-title">
      <h2 id="flows-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Sequences</h2>
      <p role="status" className="mt-2 text-ink-soft">Your sequences could not be loaded. This does not mean the list is empty. Reload before creating or changing a sequence.</p>
      <button type="button" className="btn btn-secondary mt-4" disabled={refreshing} aria-busy={refreshing} onClick={refreshFlows}>{refreshing ? "Reloading sequences…" : "Reload sequences"}</button>
    </section>
  );

  const triggerWords = (f: FlowRow) =>
    f.trigger === "joined"
      ? "Starts when someone joins your list"
      : f.trigger === "tagged"
        ? `Starts when a sequence gives someone the label “${f.tag ?? ""}”`
      : f.trigger === "form"
        ? `Starts when someone on your list sends the form “${automation.forms.find((x) => x.id === f.formId)?.name ?? "a form no longer in your store"}”${f.formOutcome ? ` and gets the result “${automation.forms.find((x) => x.id === f.formId)?.outcomes?.find((o) => o.id === f.formOutcome)?.title ?? "a result no longer in the form"}”` : ""}`
      : f.trigger === "finished"
        ? `Starts when someone who agreed to hear from you finishes ${products.find((p) => p.id === f.productId)?.title ?? "a course"}`
      : f.trigger === "started"
        ? `Starts when someone who agreed to hear from you opens ${products.find((p) => p.id === f.productId)?.title ?? "a course"} for the first time`
      : f.trigger === "abandoned"
        ? `Starts when someone on your list, who agreed on the checkout page to hear from you, leaves a checkout of ${products.find((p) => p.id === f.productId)?.title ?? "a product"} unpaid`
      : f.trigger === "stage"
        ? `Starts when a deal with someone on your list enters “${automation.stages.find((x) => x.id === f.stageId)?.name ?? "a stage no longer in your pipelines"}”`
      : f.trigger === "bought"
        ? "Starts the first time someone who agreed to hear from you buys anything"
        : // A paid call starts the sequences of its product (lib/buyer-list.ts): said as booking it.
          `Starts when someone who agreed to hear from you ${f.productId && calls.includes(f.productId) ? "books" : "gets"} ${products.find((p) => p.id === f.productId)?.title ?? "a product"}`;

  /**
   * A sequence brought in from a file (544 [SQ9]): its emails open here as a
   * new sequence, for the creator to pick what starts it, read every email and
   * save it, paused. Nothing is saved until they do.
   */
  function openImported(steps: ImportedStep[], report: ImportReportLine[]) {
    if (locked || draft !== null) return;
    const first = products[0]?.id ?? "";
    const next: FlowDraft = {
      ...toDraft(null, products),
      name: "Brought in",
      steps: steps.map((s) => ({
        ...blankStep(s.delayHours % 24 === 0 ? String(s.delayHours / 24) : String(s.delayHours), s.delayHours % 24 === 0 ? "days" : "hours", first),
        subject: s.subject,
        body: s.body,
      })),
    };
    // Unsaved from the start, so leaving the page asks first.
    setDraftBaseline(null);
    setError(null);
    setImported(report);
    setDraft(next);
  }

  function openDraft(flow: FlowRow | null) {
    if (locked || draft !== null) return;
    const opened = toDraft(flow, products);
    const others = flows.filter(other => other.id !== flow?.id);
    const next = { ...opened, steps: opened.steps.map(step => step.kind === "start" && !others.some(other => other.id === step.actionFlow) ? { ...step, actionFlow: "" } : step) };
    setDraftBaseline(JSON.stringify(next));
    setError(null);
    setDraft(next);
  }

  async function save() {
    if (!draft || locked || invalidWait || overCapacity) return;
    setBusy(true);
    setError(null);
    const a = await call({
      action: "flow",
      flow: {
        id: draft.id,
        name: draft.name,
        trigger: draft.trigger,
        productId: productTrigger(draft.trigger) ? draft.productId : null,
        tag: draft.trigger === "tagged" ? draft.triggerTag : null,
        formId: draft.trigger === "form" ? draft.formId : null,
        formOutcome: draft.trigger === "form" ? draft.formOutcome : "",
        stageId: draft.trigger === "stage" ? draft.stageId : "",
        // A new workflow is saved paused whatever is sent; switching on is its own step.
        active: draft.id ? draft.active : false,
        steps: draft.steps.map((s) => {
          const when = conditionOf(s);
          const action = actionOf(s);
          return {
            id: s.id,
            delayHours: flowWaitHours(s.wait, s.unit)!,
            subject: action ? "" : s.subject,
            body: action ? "" : s.body,
            ...(action ? { action } : {}),
            ...(when ? { when } : {}),
            ...routeOf(s),
          };
        }),
        goal: goalOf(draft),
      },
    });
    setBusy(false);
    if (!a.ok) {
      if (a.error === "flow_write_unconfirmed") onWriteUnconfirmed();
      setError(message(a));
      return;
    }
    setDraft(null);
    setImported(null);
    toast(draft.id ? "Sequence saved." : "Saved, paused. Preview it and switch it on from its card when it is ready.");
    refreshFlows();
  }

  async function setActive(f: FlowRow, active: boolean) {
    if (locked) return;
    setBusy(true);
    setError(null);
    const a = await call({ action: "flow-activate", id: f.id, active });
    setBusy(false);
    if (!a.ok) {
      if (a.error === "flow_write_unconfirmed") onWriteUnconfirmed();
      setError(message(a));
      return;
    }
    setActivating(null);
    toast(active ? `“${f.name}” is on.` : `“${f.name}” is paused.`);
    refreshFlows();
  }

  const draftSteps: (FlowStep & MapStep)[] = draft ? draft.steps.map((step, index) => {
    const action = actionOf(step);
    const when = conditionOf(step);
    return { id: step.id ?? "draft-step-" + index, delayHours: flowWaitHours(step.wait, step.unit) ?? NaN, subject: action ? "" : step.subject, body: action ? "" : step.body, ...(action ? { action } : {}), ...(when ? { when } : {}), ...routeOf(step) };
  }) : [];
  const draftIssues = draft ? flowConfigurationIssues({
    id: draft.id ?? "", name: draft.name, trigger: draft.trigger, active: draft.active, createdAt: 0,
    productId: draft.productId, tag: draft.triggerTag, formId: draft.formId, ...(draft.trigger === "form" && draft.formOutcome ? { formOutcome: draft.formOutcome } : {}), ...(draft.trigger === "stage" ? { stageId: draft.stageId } : {}),
    goal: goalOf(draft) ?? undefined,
    steps: draftSteps,
  }, { products, courses, paidProducts, flows, ...automation, assignees }) : [];
  const conditionText = (when: StepCondition) => conditionShort(when, products);

  // Which of the two starter sequences this store has no sequence for yet.
  // The after-a-purchase one is made only by a store that sells something,
  // and the server decides that; here it is offered whenever none exists.
  const missing = {
    welcome: flows.length < MAX_FLOWS && !flows.some((f) => f.trigger === "joined"),
    bought: flows.length < MAX_FLOWS && sells && !flows.some((f) => f.trigger === "bought"),
  };

  // The sequences a step can start: any other of the store's.
  const otherFlows = flows.filter((f) => f.id !== draft?.id);
  // A condition on the email before is cleared wherever no email is right
  // before it any more, so what the form shows is always what is saved.
  const settle = (steps: StepDraft[]): StepDraft[] =>
    steps.map((x, j) => ((x.when === "clicked" || x.when === "unclicked") && (j === 0 || steps[j - 1].kind !== "email") ? { ...x, when: "" } : x));
  const setStep = (editorKey: string, change: Partial<StepDraft>) =>
    setDraft(current => current ? { ...current, steps: settle(current.steps.map(step => step.editorKey === editorKey ? { ...step, ...change } : step)) } : current);

  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="flows-title">
      <h2 id="flows-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Sequences and workflows</h2>
      <p className="mt-2 text-ink-soft">
        Emails and actions that happen by themselves: a welcome when someone joins, a few tips in the days after they buy, a label
        and a deal for whoever shows interest. Steps can branch, IF/ELSE, and a goal ends a run early. Each person goes through a
        sequence once, and stops the moment they unsubscribe.
      </p>
      {limits ? (
        <p className="mt-2 text-sm text-ink-soft" data-workflow-limits>
          {[
            `${n(activeCount)} of ${n(limits.maxActive)} switched on for your plan`,
            limits.runsToday ? `${n(limits.runsToday.started)} of ${n(limits.dailyRuns)} runs started today (UTC)${limits.runsToday.refused ? `, ${n(limits.runsToday.refused)} not started: today's runs were used up` : ""}` : "today's runs could not be read",
            `up to ${MAX_STEPS} steps each, ${MAX_FLOWS} workflows in all`,
            "every email counts in your monthly emails",
          ].join(" · ")}
        </p>
      ) : null}
      {limits && limits.held ? (
        <div className="notice notice-warn mt-4 text-sm" role="status" data-held-runs>
          <p className="font-semibold">{`${n(limits.held)} ${limits.held === 1 ? "run is" : "runs are"} held for you`}</p>
          <p className="mt-1">A step&apos;s outcome could not be confirmed, so it was not repeated. Open a workflow&apos;s runs below to choose what happens next.</p>
        </div>
      ) : null}
      {/*
        The two sequences worth having from the first day, written for the
        creator (lib/mail-starters.ts). Offered only for a moment — joining,
        a first purchase — that no sequence of theirs starts on yet, and made
        switched off: nothing is sent until they have read one and turned it on.
      */}
      {!draft && (missing.welcome || missing.bought) ? (
        <div className="mt-4 rounded-[var(--r-sm)] bg-sand p-4">
          <p className="font-semibold text-ink">
            {missing.welcome && missing.bought
              ? "Start with two sequences, written for you"
              : missing.welcome
                ? "Add a welcome for everyone who joins"
                : "Add a thank-you after a first purchase"}
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            {missing.welcome && missing.bought
              ? "A welcome for everyone who joins your list, and a thank-you after someone's first purchase. We write them from your store's name, products and links, and leave them switched off. Read them, change what you like, then switch them on."
              : "We write it from your store's name, products and links, and leave it switched off. Read it, change what you like, then switch it on."}
          </p>
          <button
            type="button"
            aria-busy={busy} disabled={locked}
            className="btn btn-secondary mt-3"
            onClick={async () => {
              setBusy(true);
              setError(null);
              const a = await call({ action: "starters" });
              setBusy(false);
              if (!a.ok) {
                if (a.error === "flow_write_unconfirmed") onWriteUnconfirmed();
                return setError(a.error === "too_many" ? MESSAGES.too_many_flows : message(a));
              }
              const made = Array.isArray(a.made) ? a.made.length : 0;
              toast(made === 1 ? "Written. It is below, switched off, for you to read." : "Written. Both are below, switched off, for you to read.");
              refreshFlows();
            }}
          >
            Write them for me
          </button>
        </div>
      ) : null}
      {writeUnconfirmed ? <div className="notice notice-warn mt-4"><p role="status">Check the saved sequences before another change. A lost confirmation does not mean the change was undone; if you are editing, your draft is kept while you reload.</p><button type="button" className="btn btn-secondary mt-3" disabled={busy} onClick={() => { setError(null); refreshFlows(); }}>Reload saved sequences</button></div> : null}
      {refreshing ? <p role="status" className="mt-4 text-sm text-ink-soft">Updating sequences… Wait for the latest list before making another change.</p> : null}
      {!draft ? <Feedback error={error} done={null} /> : null}
      {flows.length ? (
        <ul className="mt-4 space-y-3">
          {flows.map((f) => (
            <li key={f.id} className="rounded-[var(--r-sm)] border border-line bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="min-w-0 break-words font-semibold text-ink">{f.name}</p>
                <span className="tag">{f.active ? "On" : "Paused"}</span>
              </div>
              <p className="mt-1 text-sm text-ink-soft">{`${triggerWords(f)} · ${stepCount(f.steps)}`}</p>
              {(() => {
                const issues = flowConfigurationIssues(f, { products, courses, paidProducts, flows, ...automation });
                return issues.length ? <div className="notice notice-warn mt-3 text-sm"><p className="font-semibold">Review saved configuration</p><ul className="mt-2 list-disc space-y-1 pl-5">{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul><p className="mt-2">Edit this sequence to review its references. No live delivery or action has been tested.</p></div> : null;
              })()}
              {f.goal ? <p className="mt-1 text-sm text-ink-soft" data-flow-goal>{`${goalWords(f, products)}.`}</p> : null}
              {f.steps.some((step) => step.when || step.action) ? (
                <ul className="mt-1 text-sm text-ink-soft" data-flow-steps>
                  {f.steps.map((step, i) =>
                    step.when || step.action ? (
                      <li key={step.id}>
                        {`${step.action ? "Step" : "Email"} ${i + 1}: ${step.action ? `${actionWords(step.action, flows)[0].toUpperCase()}${actionWords(step.action, flows).slice(1)}.` : ""}${step.action && step.when ? " " : ""}${step.when ? conditionWords(step, products) : ""}`}
                      </li>
                    ) : null,
                  )}
                </ul>
              ) : null}
              {f.statsAvailable === false ? <p role="status" className="mt-1 text-sm text-ink-soft">Sequence activity is unavailable. Reload to try again.</p> : <p className="mt-1 text-sm text-ink-soft">
                {[
                  `${n(f.stats.started)} started`,
                  `${n(f.stats.sent)} emails sent`,
                  ...(f.goal || f.stats.reached ? [`${n(f.stats.reached)} left ${f.goal && "productId" in f.goal ? "once they got it" : "once they bought"}`] : []),
                  ...(f.steps.some((s) => s.when) || f.stats.skipped ? [`${n(f.stats.skipped)} skipped by a condition`] : []),
                  ...(f.steps.some((s) => s.action) || f.stats.acted ? [`${n(f.stats.acted)} ${f.stats.acted === 1 ? "action" : "actions"} done`] : []),
                ].join(" · ")}
              </p>}
              {f.money ? <p className="mt-1 text-sm font-semibold text-ink">{soldWords(f.money, currency)}</p> : null}
              {f.steps.length ? (
                <details className="mt-1 text-sm text-ink-soft">
                  <summary className="cursor-pointer font-semibold">Map of its steps</summary>
                  <WorkflowMap steps={f.steps} conditionText={conditionText} />
                </details>
              ) : null}
              {activating === f.id ? (
                <div className="mt-3">
                  <WorkflowPreview
                    flowId={f.id}
                    steps={f.steps}
                    goal={f.goal}
                    products={products}
                    paidProducts={paidProducts ?? []}
                    request={call}
                    conditionText={conditionText}
                    confirm={{ label: "Switch it on now", busy, onConfirm: () => setActive(f, true), onCancel: () => setActivating(null) }}
                  />
                </div>
              ) : null}
              {runsOpen === f.id ? <WorkflowRuns flowId={f.id} steps={f.steps} request={call} /> : null}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm font-bold">
                {f.active ? (
                  <button type="button" className="text-ink-soft underline underline-offset-4 hover:text-violet-deep" disabled={locked || draft !== null} onClick={() => setActive(f, false)}>
                    Pause
                  </button>
                ) : (
                  <button
                    type="button"
                    className="text-ink-soft underline underline-offset-4 hover:text-violet-deep"
                    disabled={locked || draft !== null || activating === f.id || (limits ? activeCount >= limits.maxActive : false)}
                    title={limits && activeCount >= limits.maxActive ? "Your plan has as many workflows switched on as it allows. Pause one first." : undefined}
                    onClick={() => setActivating(f.id)}
                  >
                    Preview and switch on
                  </button>
                )}
                <button type="button" className="text-ink-soft underline underline-offset-4 hover:text-violet-deep" onClick={() => setRunsOpen(runsOpen === f.id ? null : f.id)}>
                  {runsOpen === f.id ? "Hide runs" : "Runs"}
                </button>
                <button
                  type="button"
                  className="text-ink-soft underline underline-offset-4 hover:text-violet-deep"
                  disabled={locked || draft !== null}
                  onClick={() => {
                    openDraft(f);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  aria-busy={busy} disabled={locked || draft !== null}
                  className="text-ink-soft underline underline-offset-4 hover:text-danger"
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    const a = await call({ action: "flow-remove", id: f.id });
                    setBusy(false);
                    if (!a.ok) {
                      if (a.error === "flow_write_unconfirmed") onWriteUnconfirmed();
                      setError("Removal of “" + f.name + "” could not be confirmed. Reload to check its current status. " + message(a));
                      return;
                    }
                    toast("Sequence removed.");
                    refreshFlows();
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {draft ? (
        <form
          className="mt-5 space-y-4 rounded-[var(--r-sm)] border border-line bg-white p-4"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {imported ? (
            <div className="rounded-[var(--r-sm)] border border-line bg-lilac/30 p-3" data-imported-report="">
              <h3 ref={importedHeading} tabIndex={-1} className="font-semibold text-ink">Brought in from your file: read each email, pick what starts it, then save</h3>
              {imported.length ? (
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                  {imported.map((r, i) => (
                    <li key={i}>{reportWords(r)}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-ink-soft">Every email in the file came in as it was.</p>
              )}
            </div>
          ) : null}
          <fieldset disabled={busy} className="min-w-0 space-y-4">
          <legend className="sr-only">Sequence configuration</legend>
          <label className="block">
            <span className="field-label">Name, for you</span>
            <input className="field mt-2" maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="block">
            <span className="field-label">Starts when</span>
            <select
              className="field mt-2"
              value={draft.trigger}
              onChange={(e) =>
                setDraft((current) => {
                  if (!current) return current;
                  const trigger: FlowTrigger =
                    e.target.value === "product" ? "product" : e.target.value === "bought" ? "bought" : e.target.value === "tagged" ? "tagged" : e.target.value === "finished" ? "finished" : e.target.value === "form" ? "form" : e.target.value === "started" ? "started" : e.target.value === "abandoned" ? "abandoned" : e.target.value === "stage" ? "stage" : "joined";
                  // Finishing and opening are only for a course: the first course, when the product chosen is not one.
                  const productId = (trigger === "finished" || trigger === "started") && !courses.includes(current.productId) ? (courses[0] ?? current.productId) : current.productId;
                  // A sequence that starts with a purchase cannot end at one.
                  const formId = trigger === "form" && !automation.forms.some((x) => x.id === current.formId) ? (automation.forms[0]?.id ?? "") : current.formId;
                  // A deal stage: the first stage of the first pipeline, when none of the store's is chosen yet.
                  if (trigger === "stage") return { ...current, trigger, formId, stageId: automation.stages.some((x) => x.id === current.stageId) ? current.stageId : (automation.stages[0]?.id ?? "") };
                  // An abandoned checkout ends once they buy that product, unless another end that stops at a purchase was chosen.
                  if (trigger === "abandoned") return { ...current, trigger, productId, formId, ...(current.goal === "any" || current.goal === "product" ? {} : { goal: "product" as const, goalProduct: productId }) };
                  return { ...current, trigger, productId, formId, goal: trigger === "bought" && current.goal === "any" ? "" : current.goal };
                })
              }
            >
              <option value="joined">Someone joins your list</option>
              <option value="bought">Someone who agreed to hear from you buys anything, the first time</option>
              {products.length ? <option value="product">{calls.length ? "Someone who agreed to hear from you gets a product or books a call" : "Someone who agreed to hear from you gets a product"}</option> : null}
              <option value="tagged">A sequence gives someone a label</option>
              {courses.length ? <option value="finished">Someone who agreed to hear from you finishes a course</option> : null}
              {courses.length ? <option value="started">Someone who agreed to hear from you opens a course for the first time</option> : null}
              {products.length ? <option value="abandoned">Someone on your list leaves a checkout unpaid, having agreed to hear from you</option> : null}
              {automation.forms.length ? <option value="form">Someone on your list sends a form</option> : null}
              {automation.stages.length ? <option value="stage">A deal with someone on your list enters a stage</option> : null}
            </select>
          </label>
          {draft.trigger === "stage" ? (
            <label className="block">
              <span className="field-label">Which stage</span>
              <select className="field mt-2" value={draft.stageId} onChange={(e) => setDraft({ ...draft, stageId: e.target.value })}>
                {automation.stages.map((st) => (
                  <option key={st.id} value={st.id}>{st.name}</option>
                ))}
              </select>
              <span className="mt-2 block text-sm text-ink-soft">
                When your team makes a deal in this stage on Deals, or moves one to it from another stage or pipeline. Only for the person the deal names by email, if they are on your list and agreed to hear from you; each person starts it once. A deal made from a form response, moved by a workflow step, or moved because you removed its stage starts nothing. One workflow per stage; it can start others with a step.
              </span>
            </label>
          ) : null}
          {draft.trigger === "form" ? (
            <label className="block">
              <span className="field-label">Which form</span>
              <select className="field mt-2" value={draft.formId} onChange={(e) => setDraft({ ...draft, formId: e.target.value, formOutcome: "" })}>
                {automation.forms.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
              <span className="mt-2 block text-sm text-ink-soft">
                Only forms that ask for an email address. Someone already on your list starts it when they send the form; someone who checks the box to hear from you starts it once they confirm by email.
              </span>
            </label>
          ) : null}
          {draft.trigger === "form" && automation.forms.find((f) => f.id === draft.formId)?.outcomes?.length ? (
            <label className="block">
              <span className="field-label">Which quiz result</span>
              <select className="field mt-2" value={draft.formOutcome} onChange={(e) => setDraft({ ...draft, formOutcome: e.target.value })}>
                <option value="">Any result, or none</option>
                {automation.forms.find((f) => f.id === draft.formId)?.outcomes?.map((o) => (
                  <option key={o.id} value={o.id}>{o.title}</option>
                ))}
              </select>
              <span className="mt-2 block text-sm text-ink-soft">
                Start it only for people who got one result, as a follow-up written for them. In a scored quiz the result is the one whose score range holds their total.
              </span>
            </label>
          ) : null}
          {draft.trigger === "tagged" ? (
            <label className="block">
              <span className="field-label">Which label</span>
              <input
                className="field mt-2"
                maxLength={MAX_CONDITION_TAG}
                value={draft.triggerTag}
                placeholder="interested"
                onChange={(e) => setDraft({ ...draft, triggerTag: e.target.value })}
              />
              <span className="mt-2 block text-sm text-ink-soft">
                Given by a step of another sequence. A label an import brought does not start anything.
              </span>
            </label>
          ) : null}
          {draft.trigger === "finished" ? (
            <label className="block">
              <span className="field-label">Which course</span>
              <select className="field mt-2" value={draft.productId} onChange={(e) => setDraft({ ...draft, productId: e.target.value })}>
                {products
                  .filter((p) => courses.includes(p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>{p.title}</option>
                  ))}
              </select>
              <span className="mt-2 block text-sm text-ink-soft">
                When the last lesson is marked done, by a button, a quiz passed or work approved. Each student starts it once.
              </span>
            </label>
          ) : null}
          {draft.trigger === "started" ? (
            <label className="block">
              <span className="field-label">Which course</span>
              <select className="field mt-2" value={draft.productId} onChange={(e) => setDraft({ ...draft, productId: e.target.value })}>
                {products
                  .filter((p) => courses.includes(p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>{p.title}</option>
                  ))}
              </select>
              <span className="mt-2 block text-sm text-ink-soft">The first time a student opens the course. Each student starts it once.</span>
            </label>
          ) : null}
          {draft.trigger === "abandoned" ? (
            <label className="block">
              <span className="field-label">Which product&apos;s checkout</span>
              <select className="field mt-2" value={draft.productId} onChange={(e) => setDraft({ ...draft, productId: e.target.value, ...(draft.goal === "product" ? { goalProduct: e.target.value } : {}) })}>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
              <span className="mt-2 block text-sm text-ink-soft">
                Only for someone who checked the box on the checkout page to hear from you, which Stripe shows to stores with a US Stripe
                account, and who is on your list. Noticed within minutes of the checkout closing, once per checkout. It must end once they buy.
              </span>
            </label>
          ) : null}
          {draft.trigger === "product" ? (
            <label className="block">
              <span className="field-label">Which product</span>
              <select className="field mt-2" value={draft.productId} onChange={(e) => setDraft({ ...draft, productId: e.target.value })}>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
            </label>
          ) : null}
          {/* The sequence's end (lib/flow-rules.ts): once somebody has what
              it was selling, the rest of it is not for them. */}
          <div>
            <label className="block">
              <span className="field-label">Ends early</span>
              <select
                className="field mt-2"
                data-flow-goal-choice
                value={draft.goal}
                onChange={(e) => setDraft({ ...draft, goal: e.target.value === "any" ? "any" : e.target.value === "product" ? "product" : e.target.value === "tag" ? "tag" : "" })}
              >
                {draft.trigger === "abandoned" ? null : <option value="">Never: everyone gets every email</option>}
                {draft.trigger === "bought" ? null : <option value="any">Once they have bought anything</option>}
                {products.length ? <option value="product">Once they get a product</option> : null}
                {draft.trigger === "abandoned" ? null : <option value="tag">Once they carry a label</option>}
              </select>
            </label>
            {draft.goal === "tag" ? (
              <label className="mt-3 block">
                <span className="sr-only">The label it ends on</span>
                <input className="field" maxLength={MAX_CONDITION_TAG} value={draft.goalTag} placeholder="customer" onChange={(e) => setDraft({ ...draft, goalTag: e.target.value })} />
              </label>
            ) : null}
            {draft.goal === "product" ? (
              <label className="mt-3 block">
                <span className="sr-only">The product it ends on</span>
                <select className="field" value={draft.goalProduct} onChange={(e) => setDraft({ ...draft, goalProduct: e.target.value })}>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>{p.title}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <p className="mt-2 text-sm text-ink-soft">
              The goal: checked before each step. Someone who reaches it while in the workflow gets none of the steps still to come.
            </p>
          </div>
          {overCapacity ? <p role="status" className="text-sm text-danger">{`This sequence has more than ${MAX_STEPS} steps. Remove steps before saving; none have been discarded.`}</p> : null}
          {availableCounts.length ? <AiAssist<DraftedStep[]>
            title="Write the emails with AI"
            validateResult={(value): value is DraftedStep[] => isAiSequenceDraft(value) && value.length <= requestedCount && value.length <= availableSlots}
            onBusyChange={setAiBusy}
            hint="For the moment chosen above, from what your store sells: its products' names, summaries, prices and links, and anything you add here. Only your store's own links are kept. The emails fill the sequence below for you to read and change; nothing is saved or sent until you save it."
            placeholder="Optional: what these emails should say, or the tone. For example: share my three favorite weeknight tricks before mentioning the meal planner."
            allowEmpty
            extra={
              <label className="flex flex-wrap items-center gap-2 text-sm text-ink">
                <span className="font-semibold">How many emails</span>
                <select className="field w-auto" value={requestedCount} onChange={(e) => setDraftCount(Number(e.target.value))}>
                  {availableCounts.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
            }
            payload={() => ({ kind: "sequence", trigger: draft.trigger, productId: draft.trigger === "product" || draft.trigger === "finished" ? draft.productId : "", tag: draft.trigger === "tagged" ? draft.triggerTag : "", count: requestedCount })}
            onResult={(written) => {
              const steps: StepDraft[] = written.map((w) => ({
                ...(w.delayHours > 0 && w.delayHours % 24 === 0
                  ? blankStep(String(w.delayHours / 24), "days", products[0]?.id ?? "")
                  : blankStep(String(w.delayHours), "hours", products[0]?.id ?? "")),
                subject: w.subject,
                body: w.body,
              }));
              // Emails still empty are replaced; the creator's own and action steps are kept.
              setDraft(current => current ? { ...current, steps: appendSequenceDraft(current.steps, steps) } : current);
            }}
            done="The emails are in the sequence below. Read each one, change what you like, then save it."
          /> : <p role="status" className="text-sm text-ink-soft">AI writes at least 3 emails at a time. This sequence has {availableSlots} free {availableSlots === 1 ? "step" : "steps"}. Remove steps to make room before generating.</p>}
          <ol className="space-y-4">
            {draft.steps.map((s, i) => (
              <li key={s.editorKey} className="rounded-[var(--r-sm)] bg-sand p-4">
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <p className="text-sm font-bold text-ink">{s.kind === "email" ? `Email ${i + 1}` : `Step ${i + 1}`}</p>
                  <label className="block">
                    <span className="sr-only">{`What step ${i + 1} does`}</span>
                    <select
                      className="field w-auto"
                      data-step-kind
                      value={s.kind}
                      onChange={(e) => {
                        const v = e.target.value;
                        const kind = v === "tag" || v === "untag" || v === "start" || v === "webhook" || v === "field" || v === "deal" || v === "note" || v === "notify" || v === "wait" || v === "assign" ? v : "email";
                        setStep(s.editorKey, {
                          kind,
                          actionAssignee: s.actionAssignee || assignees[0] || "",
                          actionFlow: s.actionFlow || otherFlows[0]?.id || "",
                          actionField: s.actionField || automation.fields[0]?.id || "",
                          actionStage: s.actionStage || automation.stages[0]?.id || "",
                        });
                      }}
                    >
                      <option value="email">Sends an email</option>
                      <option value="tag">Gives a label</option>
                      <option value="untag">Takes a label off</option>
                      {otherFlows.length ? <option value="start">Starts another sequence</option> : null}
                      <option value="webhook">Tells your webhooks</option>
                      {automation.fields.length ? <option value="field">Sets a field</option> : null}
                      {automation.stages.length ? <option value="deal">Puts their deal in a stage</option> : null}
                      <option value="note">Writes a note on their page</option>
                      <option value="notify">Emails you who reached it</option>
                      <option value="wait">Only waits (for a branch)</option>
                      {assignees.length ? <option value="assign">Makes a teammate responsible for their deal</option> : null}
                    </select>
                  </label>
                </div>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="block">
                    <span className="text-sm text-ink-soft">{i === 0 ? "Wait after it starts" : "Wait after the one before"}</span>
                    <input
                      className="field mt-1 w-24"
                      inputMode="numeric"
                      value={s.wait}
                      onChange={(e) => setStep(s.editorKey, { wait: e.target.value.replace(/[^0-9]/g, "").slice(0, 4) })}
                    />
                  </label>
                  <label className="block">
                    <span className="sr-only">Hours or days</span>
                    <select className="field w-28" value={s.unit} onChange={(e) => setStep(s.editorKey, { unit: e.target.value === "days" ? "days" : "hours" })}>
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                    </select>
                  </label>
                </div>
                {s.kind === "tag" || s.kind === "untag" ? (
                  <label className="mt-3 block">
                    <span className="text-sm text-ink-soft">{s.kind === "tag" ? "The label to give" : "The label to take off"}</span>
                    <input
                      className="field mt-1"
                      maxLength={MAX_CONDITION_TAG}
                      value={s.actionTag}
                      placeholder="interested"
                      onChange={(e) => setStep(s.editorKey, { actionTag: e.target.value })}
                    />
                    {s.kind === "tag" ? (
                      <span className="mt-1 block text-sm text-ink-soft">
                        Starts any sequence that starts with this label. Someone who already has ten labels is not given another.
                      </span>
                    ) : null}
                  </label>
                ) : s.kind === "start" ? (
                  <label className="mt-3 block">
                    <span className="text-sm text-ink-soft">The sequence to start</span>
                    <select className="field mt-1" value={s.actionFlow} onChange={(e) => setStep(s.editorKey, { actionFlow: e.target.value })} required>
                      {s.actionFlow ? null : <option value="">A sequence that was removed: choose another</option>}
                      {otherFlows.map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                    <span className="mt-1 block text-sm text-ink-soft">Each person goes through a sequence once, so nobody is started on it twice.</span>
                  </label>
                ) : s.kind === "field" ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <label className="block">
                      <span className="text-sm text-ink-soft">The field</span>
                      <select className="field mt-1" value={s.actionField} onChange={(e) => setStep(s.editorKey, { actionField: e.target.value, actionValue: "" })}>
                        {automation.fields.map((f) => (
                          <option key={f.id} value={f.id}>{f.name}</option>
                        ))}
                      </select>
                    </label>
                    {(() => {
                      const field = automation.fields.find((f) => f.id === s.actionField);
                      return field?.type === "choice" ? (
                        <label className="block">
                          <span className="text-sm text-ink-soft">Set to</span>
                          <select className="field mt-1" value={s.actionValue} onChange={(e) => setStep(s.editorKey, { actionValue: e.target.value })}>
                            <option value="">Choose one</option>
                            {field.options.map((o) => (
                              <option key={o} value={o}>{o}</option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <label className="block">
                          <span className="text-sm text-ink-soft">Set to</span>
                          <input
                            className="field mt-1"
                            type={field?.type === "date" ? "date" : "text"}
                            inputMode={field?.type === "number" ? "decimal" : undefined}
                            maxLength={200}
                            value={s.actionValue}
                            onChange={(e) => setStep(s.editorKey, { actionValue: e.target.value })}
                          />
                        </label>
                      );
                    })()}
                    <span className="block text-sm text-ink-soft sm:col-span-2">Shown on their page in your studio, and in your list&apos;s file.</span>
                  </div>
                ) : s.kind === "deal" ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <label className="block">
                      <span className="text-sm text-ink-soft">The stage</span>
                      <select className="field mt-1" value={s.actionStage} onChange={(e) => setStep(s.editorKey, { actionStage: e.target.value })}>
                        {automation.stages.map((st) => (
                          <option key={st.id} value={st.id}>{st.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-sm text-ink-soft">A new deal&apos;s title (optional)</span>
                      <input className="field mt-1" maxLength={90} value={s.actionTitle} placeholder={draft.name} onChange={(e) => setStep(s.editorKey, { actionTitle: e.target.value })} />
                    </label>
                    <span className="block text-sm text-ink-soft sm:col-span-2">Their open deal moves to this stage; with none open, a new one is made for them on your deals board.</span>
                  </div>
                ) : s.kind === "note" ? (
                  <label className="mt-3 block">
                    <span className="text-sm text-ink-soft">The note</span>
                    <input className="field mt-1" maxLength={300} value={s.actionText} placeholder="Asked about coaching" onChange={(e) => setStep(s.editorKey, { actionText: e.target.value })} />
                    <span className="mt-1 block text-sm text-ink-soft">Written on their page in your studio, with the sequence and the step it came from.</span>
                  </label>
                ) : s.kind === "assign" ? (
                  <label className="mt-3 block">
                    <span className="text-sm text-ink-soft">Who becomes responsible</span>
                    <select className="field mt-1" value={s.actionAssignee} onChange={(e) => setStep(s.editorKey, { actionAssignee: e.target.value })}>
                      {assignees.map((email) => (
                        <option key={email} value={email}>{email}</option>
                      ))}
                    </select>
                    <span className="mt-1 block text-sm text-ink-soft">For their open deal on your deals board. Someone with no open deal is skipped, and the run goes on.</span>
                  </label>
                ) : s.kind === "wait" ? (
                  <p className="mt-3 text-sm text-ink-soft">
                    Does nothing but wait the time above. With a condition below, it is a branch: those it holds for go one way, everyone else another.
                  </p>
                ) : s.kind === "notify" ? (
                  <p className="mt-3 text-sm text-ink-soft">
                    One email to you for everyone who reaches this step together: who they are, and the link to find them in your studio.
                  </p>
                ) : s.kind === "webhook" ? (
                  <p className="mt-3 text-sm text-ink-soft">
                    Each person who reaches this step is sent to your own server as a &ldquo;Sequence step&rdquo; event, once: their email, the sequence and the step. Choose an address that listens for it under Webhooks, in your settings; with none, this step does nothing.
                  </p>
                ) : (
                <>
                <label className="mt-3 block">
                  <span className="text-sm text-ink-soft">Subject</span>
                  <input className="field mt-1" maxLength={150} value={s.subject} onChange={(e) => setStep(s.editorKey, { subject: e.target.value })} />
                </label>
                <div className="mt-3">
                  <MailBodyEditor
                    body={s.body}
                    rows={6}
                    onChange={(next) => setStep(s.editorKey, { body: next })}
                    boxRef={(el) => {
                      stepBoxes.current[i] = el;
                    }}
                  />
                </div>
                </>
                )}
                {/* Who this email is for (lib/flow-rules.ts). Read from what
                    your list keeps — what each person has and the labels an
                    import brought, and links used, only for readers who allowed it
                    (lib/mail-clicks.ts) — never from opens. */}
                <div className="mt-3 flex flex-wrap items-end gap-2" data-step-condition>
                  <label className="block min-w-0 flex-1">
                    <span className="text-sm text-ink-soft">{s.kind === "email" ? "Send it to" : "Do it for"}</span>
                    <select
                      className="field mt-1"
                      value={s.when}
                      onChange={(e) => {
                        const when = STEP_IF_WORDS.find((w) => w.value === e.target.value)?.value ?? "";
                        // A condition on a course names a course: the first, when the product chosen is not one.
                        setStep(s.editorKey, isCourseIf(when) && !courses.includes(s.whenProduct) ? { when, whenProduct: courses[0] ?? s.whenProduct } : { when });
                      }}
                    >
                      {STEP_IF_WORDS.filter(
                        (w) =>
                          (products.length || (w.value !== "has" && w.value !== "lacks")) &&
                          (courses.length > 0 || !isCourseIf(w.value)) &&
                          ((i > 0 && draft.steps[i - 1].kind === "email") || (w.value !== "clicked" && w.value !== "unclicked")),
                      ).map((w) => (
                        <option key={w.value} value={w.value}>{w.label}</option>
                      ))}
                    </select>
                  </label>
                  {s.when === "has" || s.when === "lacks" ? (
                    <label className="block min-w-0 flex-1">
                      <span className="text-sm text-ink-soft">Product</span>
                      <select className="field mt-1" value={s.whenProduct} onChange={(e) => setStep(s.editorKey, { whenProduct: e.target.value })}>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>{p.title}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {isCourseIf(s.when) ? (
                    <label className="block min-w-0 flex-1">
                      <span className="text-sm text-ink-soft">Course</span>
                      <select className="field mt-1" value={s.whenProduct} onChange={(e) => setStep(s.editorKey, { whenProduct: e.target.value })}>
                        {products
                          .filter((p) => courses.includes(p.id))
                          .map((p) => (
                            <option key={p.id} value={p.id}>{p.title}</option>
                          ))}
                      </select>
                    </label>
                  ) : null}
                  {s.when === "tag" || s.when === "untagged" ? (
                    <label className="block min-w-0 flex-1">
                      <span className="text-sm text-ink-soft">Label, from an import or a sequence</span>
                      <input className="field mt-1" maxLength={MAX_CONDITION_TAG} value={s.whenTag} onChange={(e) => setStep(s.editorKey, { whenTag: e.target.value })} />
                    </label>
                  ) : null}
                </div>
                {s.when === "clicked" || s.when === "unclicked" ? (
                  <p className="mt-2 text-sm text-ink-soft">
                    Counted only for readers who allowed it with a box of its own when they joined, and only for links to your
                    store. Everyone else counts as not having used one.
                  </p>
                ) : null}
                {s.when ? (
                  <label className="mt-2 block">
                    <span className="text-sm text-ink-soft">Everyone else</span>
                    <select
                      className="field mt-1"
                      value={s.otherwise === "jump" ? `jump:${s.jump}` : s.otherwise}
                      onChange={(e) => {
                        const v = e.target.value;
                        setStep(s.editorKey, v.startsWith("jump:") ? { otherwise: "jump", jump: v.slice(5) } : { otherwise: v === "end" ? "end" : "skip", jump: "" });
                      }}
                    >
                      <option value="skip">{s.kind === "email" ? "Skips this email and goes on to the next" : "Skips this step and goes on to the next"}</option>
                      <option value="end">Leaves the sequence here</option>
                      {draft.steps.slice(i + 2).map((later, j) => (
                        <option key={later.editorKey} value={`jump:${later.id ?? ""}`}>{`Goes to step ${i + 3 + j}`}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="mt-2 block" data-step-next>
                  <span className="text-sm text-ink-soft">{s.when ? "Those it is for, after this step" : "After this step"}</span>
                  <select className="field mt-1" value={s.next} onChange={(e) => setStep(s.editorKey, { next: e.target.value })}>
                    <option value="">{i + 1 < draft.steps.length ? "Go on to the next step" : "The workflow ends (last step)"}</option>
                    {draft.steps.slice(i + 2).map((later, j) => (
                      <option key={later.editorKey} value={later.id ?? ""}>{`Go to step ${i + 3 + j}`}</option>
                    ))}
                    {i + 1 < draft.steps.length ? <option value="end">The workflow ends for them</option> : null}
                  </select>
                </label>
                {draft.steps.length > 1 ? (
                  <button
                    type="button"
                    className="mt-2 text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger"
                    onClick={() =>
                      setDraft(current => current ? {
                        ...current,
                        // The email that becomes the first has no email before it to read,
                        // and a branch to the step removed goes on to the next step instead.
                        steps: settle(current.steps.filter(step => step.editorKey !== s.editorKey).map(step => ({
                          ...step,
                          ...(step.otherwise === "jump" && step.jump === s.id ? { otherwise: "skip" as const, jump: "" } : {}),
                          ...(step.next && step.next === s.id ? { next: "" } : {}),
                        }))),
                      } : current)
                    }
                  >
                    {s.kind === "email" ? "Remove this email" : "Remove this step"}
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
          {draft.steps.length < MAX_STEPS ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setDraft({ ...draft, steps: [...draft.steps, blankStep("2", "days", products[0]?.id ?? "")] })}
            >
              Add a step
            </button>
          ) : null}
          {draftIssues.length ? <div className="notice notice-warn text-sm"><p className="font-semibold">Review this configuration before activating</p><ul className="mt-2 list-disc space-y-1 pl-5">{draftIssues.map((issue, index) => <li key={index}>{issue}</li>)}</ul><p className="mt-2">These are reference checks. Saving still uses server validation; delivery and action execution have not been tested.</p></div> : null}
          {draftSteps.length ? (
            <WorkflowPreview flowId={draft.id ?? ""} steps={draftSteps} goal={goalOf(draft)} products={products} paidProducts={paidProducts ?? []} request={call} conditionText={conditionText} />
          ) : null}
          {!draft.id ? (
            <p className="text-sm text-ink-soft">New workflows are saved paused. Preview it from its card, then switch it on there when it is ready.</p>
          ) : (
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
              <span>On. Switched off, nobody new starts it, and those already in it get none of its steps that are still to come.</span>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" aria-busy={busy} disabled={locked || invalidWait || overCapacity} className="btn btn-primary">Save the sequence</button>
            <button
              type="button"
              className="text-sm font-bold text-ink-soft underline underline-offset-4"
              onClick={() => {
                setDraft(null);
                setImported(null);
              }}
            >
              Close
            </button>
          </div>
          <Feedback error={error} done={null} />
          </fieldset>
        </form>
      ) : flows.length < MAX_FLOWS ? (
        <>
          <button type="button" className="btn btn-secondary mt-5" disabled={locked} onClick={() => openDraft(null)}>
            New sequence
          </button>
          <SequenceImportBox disabled={locked} onRead={openImported} describe={(code) => MESSAGES[code] ?? null} />
        </>
      ) : null}
    </section>
  );
}
