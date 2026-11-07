import { HISTORICAL_MARGIN_NOTICE } from "./historical-margin-model";
/**
 * Whether to resell per-use services at a profit (18 October 2026): an
 * ANALYSIS for the owner, not a change. No price, limit or gate in code
 * changes, and sales stay closed.
 *
 * For each candidate (SMS, WhatsApp, phone numbers and calls, AI voice,
 * extra list emails, video hours, captions, AI): the supplier's published
 * unit price at its dearest (docs/per-use-resale-data-2026-10-18.json, each
 * with its page and day), what competitors charge, and the price per unit
 * that keeps 60% per customer at full use, sold from prepaid credits (the
 * owner's rule: the customer pays first, use stops at zero; the structure of
 * docs/pack-cost-decomposition-2026-10-18.md, option 3). Every rate is
 * checked with lib/receiving-costs.ts `unitUnder`: the whole credit spent on
 * that one service, its fixed monthly costs included, keeps 60% with the
 * add-on's 25¢ of room.
 *
 * `node scripts/per-use-resale.mjs` writes docs/per-use-resale-2026-10-18.md;
 * tests/per-use-resale.test.ts fails when it is stale.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CENTS_PER_MINUTE, MIN_CENTS } from "@/lib/auto-captions-rules";
import { ADD_ON_ROOM_CENTS } from "@/lib/store-assistant-rules";
import { MOST_TAX_READING, SIZING_READING, unitUnder, type UnitResult } from "./historical-margin-model";
import { LIST_EMAIL_USD, hourCost } from "./plan-cost-registry";
import { PACKS } from "./pricing-usage-proposal-table";
import { centsUp, creditOption } from "./pack-cost-decomposition-table";

export const DATA_FILE = "docs/per-use-resale-data-2026-10-18.json";
export const DOC_FILE = "docs/per-use-resale-2026-10-18.md";

type Src = { id: string; url: string; read: string; type: string };
type Data = {
  readOn: string; note: string; sources: Src[];
  suppliers: {
    smsSegment: { name: string; base: number; carrierMax: number; source: string; what: string }[];
    tenDlc: { oneTime: number; monthly: number; source: string; what: string };
    phoneNumberMonthly: { price: number; source: string; what: string };
    voiceMinute: { outbound: number; recording: number; transcription: number; source: string; what: string };
    whatsappMarketing: { price: number; monthly: number; source: string; what: string };
    aiVoiceMinute: { agent: number; source: string; what: string };
    captionMinuteLanguage: { price: number; source: string; what: string };
    videoAlternative: { source: string; what: string };
    emailAlternatives: { name: string; per1000: number; source: string; what: string }[];
  };
  competitors: Record<string, { who: string; what: string; source: string; unitUsd?: number; unitBasis?: string }[]>;
};
let cached: Data | null = null;
export const data = (): Data => (cached ??= JSON.parse(readFileSync(join(process.cwd(), DATA_FILE), "utf8")) as Data);

/** The credit amounts the rates are given at, in cents. */
export const AMOUNTS = [10_000, 25_000, 100_000] as const;

export type Candidate = {
  id: string; name: string;
  /** The cost of one unit, in dollars, at the dearest supplier read. */
  unitUsd: number; per: number; perName: string;
  /** What the supplier's page says, and where. */
  supplier: string; supplierSources: string[];
  /** Costs a creator carries each month to use it at all, and once, in dollars. */
  monthlyUsd: number; onceUsd: number;
  /** A competitor's own price for the same unit, in dollars, when one is stated. */
  competitorUnitUsd: number | null; competitorKey: string;
  /** The cost has a part no page bounds. */
  unbounded: string | null;
  compliance: string; effort: string;
  verdict: "sell" | "keep selling" | "don't sell"; order: number | null; why: string;
};

export function candidates(): Candidate[] {
  const s = data().suppliers;
  const sms = s.smsSegment.reduce((a, b) => (b.base + b.carrierMax > a.base + a.carrierMax ? b : a));
  const ai = PACKS.find((p) => p.id === "ai")!;
  const resend = s.emailAlternatives.find((e) => e.name === "Resend")!;
  const ses = s.emailAlternatives.find((e) => e.name === "Amazon SES")!;
  const comp = (key: string) => data().competitors[key]?.find((r) => r.unitUsd !== undefined)?.unitUsd ?? null;
  return [
    {
      id: "list-email", name: "Extra list emails (as today: Resend's rate)", unitUsd: LIST_EMAIL_USD, per: 1_000, perName: "1,000 emails",
      supplier: `LIST_EMAIL_USD (tests/plan-cost-registry.ts: PER_EMAIL and the most an email's poll adds), Resend's ${resend.what}; Postmark charges more`, supplierSources: ["resend", "postmark"],
      monthlyUsd: 0, onceUsd: 0, competitorUnitUsd: comp("email"), competitorKey: "email", unbounded: null,
      compliance: "CAN-SPAM, GDPR and ePrivacy consent: already carried by lib/email.ts, the list's consent and unsubscribe, lib/mail-health.ts",
      effort: "Small: the meters exist (lib/email.ts EmailMeter); a balance drawn on after the plan's figure, the purchase and its page",
      verdict: "sell", order: 1, why: "Prepaid, bounded, compliance already built; the heavy sender pays for what he sends. The rate cannot match HighLevel's: sell the plan on its included allowance, not on this rate.",
    },
    {
      id: "list-email-ses", name: "Extra list emails, sent by Amazon SES only (if built)", unitUsd: ses.per1000 / 1_000, per: 1_000, perName: "1,000 emails",
      supplier: `Amazon SES, its dearest listed rate: ${ses.what}`, supplierSources: ["ses"],
      monthlyUsd: 0, onceUsd: 0, competitorUnitUsd: comp("email"), competitorKey: "email", unbounded: null,
      compliance: "As above; SES reviews an account at 5% bounced or 0.1% complaints (lib/ses.ts)",
      effort: "Medium: credits' emails sent with sendBatch's `only: \"amazon\"` and held, never handed to Resend, while Amazon is down; the page says they can wait",
      verdict: "sell", order: 2, why: "Same as above at about a quarter of the rate, once the routing is built.",
    },
    {
      id: "video", name: "Video hours watched", unitUsd: hourCost(), per: 1, perName: "hour",
      supplier: "hourCost() (tests/plan-cost-registry.ts): Bunny Stream's volume tier, $0.005 a GB, at 1080p fetched ahead", supplierSources: ["mux"],
      monthlyUsd: 0, onceUsd: 0, competitorUnitUsd: null, competitorKey: "video", unbounded: null,
      compliance: "None new",
      effort: "Small: lib/video-admission-rules.ts already counts and refuses hours; the balance after the plan's figure",
      verdict: "sell", order: 3, why: "Cents an hour to the buyer, a course seller's first need; competitors include video and sell no hour, so the plan's included hours carry the comparison and credits only the overflow.",
    },
    {
      id: "ai", name: "AI writing jobs (with five answers each)", unitUsd: ai.costUsd / ai.units, per: 1, perName: "writing job with 5 answers",
      supplier: "WRITING_JOB_MICRO_USD and ANSWER_MICRO_USD (lib/spend-cost-table.ts), Anthropic's list prices read 17 October 2026", supplierSources: [],
      monthlyUsd: 0, onceUsd: 0, competitorUnitUsd: null, competitorKey: "ai", unbounded: null,
      compliance: "None new (lib/ai-spend.ts already holds every call to its ceiling)",
      effort: "Small: the AI ceiling's company total (`companyMicroUsd`) must count what credits buy",
      verdict: "sell", order: 4, why: "Bounded by the hold on every call; competitors sell AI credits too (units do not convert).",
    },
    {
      id: "captions", name: "AI captions (a minute of video, one language)", unitUsd: 2 * s.captionMinuteLanguage.price, per: 1, perName: "minute, one language",
      supplier: `Bunny Transcribe AI: ${s.captionMinuteLanguage.what}; counted twice, should the spoken language be billed on its own (lib/auto-captions-rules.ts)`, supplierSources: ["bunny-transcribe", "mux"],
      monthlyUsd: 0, onceUsd: 0, competitorUnitUsd: null, competitorKey: "captions", unbounded: null,
      compliance: "None new; captions help accessibility",
      effort: "Already sold as its own charge, paid before the work (lib/auto-captions-rules.ts); moving it into credits is small",
      verdict: "keep selling", order: 5, why: `Sold today at $${CENTS_PER_MINUTE / 100} a minute a language, at least $${MIN_CENTS / 100}, charged before the work. From credits the rate in this row is lower, with no minimum. Mux writes captions free on demand: a supplier choice worth pricing before captions are promoted.`,
    },
    {
      id: "sms", name: "SMS (US, 10DLC long code)", unitUsd: sms.base + sms.carrierMax, per: 1, perName: "segment",
      supplier: `${sms.name}: ${sms.what}`, supplierSources: ["twilio-sms", "plivo-sms", "telnyx-sms"],
      monthlyUsd: s.tenDlc.monthly + s.phoneNumberMonthly.price, onceUsd: s.tenDlc.oneTime, competitorUnitUsd: comp("sms"), competitorKey: "sms", unbounded: null,
      compliance: "TCPA (prior express written consent for marketing texts, its record kept), A2P 10DLC brand and campaign registration per creator, STOP/HELP handled at once, quiet hours under several state laws, CTIA guidelines; EU ePrivacy prior consent",
      effort: "Large: a supplier integration, number provisioning and 10DLC registration per creator, inbound webhooks, consent records, STOP, quiet hours by recipient time zone",
      verdict: "don't sell", order: null, why: "At the 60% rule a segment sells at about twenty times its cost, many times HighLevel's pass-through rate, and every creator also carries a 10DLC campaign and a number each month before sending one message; plus the compliance load.",
    },
    {
      id: "whatsapp", name: "WhatsApp marketing message (US)", unitUsd: s.whatsappMarketing.price, per: 1, perName: "message",
      supplier: `Plivo: ${s.whatsappMarketing.what}`, supplierSources: ["plivo-whatsapp", "meta-whatsapp"],
      monthlyUsd: s.whatsappMarketing.monthly, onceUsd: 0, competitorUnitUsd: null, competitorKey: "whatsapp", unbounded: null,
      compliance: "WhatsApp Business policy opt-in, approved templates outside the 24-hour window, Meta business verification, commerce policy; TCPA-style consent where applicable; EU ePrivacy",
      effort: "Large: a WhatsApp Business Account per creator through a provider, template approval flow, the 24-hour window, inbound handling",
      verdict: "don't sell", order: null, why: "Same multiplier on a dearer unit, a monthly account fee per creator, and Meta's template rules.",
    },
    {
      id: "calls", name: "Phone calls, recorded (US, outbound)", unitUsd: s.voiceMinute.outbound + s.voiceMinute.recording, per: 1, perName: "minute",
      supplier: `Twilio: ${s.voiceMinute.what}`, supplierSources: ["twilio-voice"],
      monthlyUsd: s.phoneNumberMonthly.price, onceUsd: 0, competitorUnitUsd: comp("voice"), competitorKey: "voice", unbounded: null,
      compliance: "TCPA for autodialed or prerecorded calls, two-party consent to record in several states, caller ID (STIR/SHAKEN), do-not-call lists",
      effort: "Large: numbers, a calling client, recording consent prompts, storage and deletion of recordings",
      verdict: "don't sell", order: null, why: "Twenty times a minute's cost against HighLevel's pass-through, a number a month per creator, and the recording-consent load; a creator store sells calls booked on a video link, which costs nothing per minute.",
    },
    {
      id: "ai-voice", name: "AI voice agent on a call", unitUsd: s.aiVoiceMinute.agent + s.voiceMinute.outbound + s.voiceMinute.recording, per: 1, perName: "minute (at least)",
      supplier: `ElevenLabs: ${s.aiVoiceMinute.what}; plus Twilio's minute and recording`, supplierSources: ["elevenlabs", "twilio-voice"],
      monthlyUsd: s.phoneNumberMonthly.price, onceUsd: 0, competitorUnitUsd: null, competitorKey: "aiVoice",
      unbounded: "the language model's cost a minute is not on the supplier's page, so the minute has no bound",
      compliance: "As calls, and the FCC's February 2024 declaratory ruling that AI-generated voices are \"artificial\" under the TCPA (prior express consent); disclosure that the caller is an AI",
      effort: "Very large: everything calls need, an agent, its language model held to a ceiling",
      verdict: "don't sell", order: null, why: "Its cost has no bound (the owner's rule: an unbounded cost counts as failing), and the consent load is the heaviest of all.",
    },
  ];
}

export type Rate = { amountCents: number; centsPerDisplay: number; monthlyCents: number; onceCents: number; worst: UnitResult; keeps: boolean };
/**
 * The rate from a credit of this amount: the unit cost, the monthly costs and
 * the one-time cost each times the credit's multiplier (its room for use, less
 * the add-on's 25¢; creditOption), rounded up to the cent. `worst` is the whole
 * credit spent on this service alone: the one-time cost, then as many months
 * of the monthly cost as one month of units needs, then units.
 */
export function rateOf(c: Candidate, amountCents: number): Rate {
  const m = creditOption(amountCents).multiplier;
  const up = (usd: number) => (usd === 0 ? 0 : Math.ceil(Math.round(usd * 100 * m * 1e6) / 1e6));
  const centsPerDisplay = up(c.unitUsd * c.per);
  const monthlyCents = up(c.monthlyUsd), onceCents = up(c.onceUsd);
  // Every charge is its cost times the multiplier, rounded up, so no mix of them costs more than the dearest pure use:
  // all units; all months of the fixed cost; the one-time cost and units with the rest.
  const unitsOnly = (cents: number) => Math.floor((Math.max(0, cents) * c.per) / centsPerDisplay) * c.unitUsd;
  const worstUsd = Math.max(
    unitsOnly(amountCents),
    monthlyCents ? Math.floor(amountCents / monthlyCents) * c.monthlyUsd : 0,
    onceCents && amountCents >= onceCents ? c.onceUsd + unitsOnly(amountCents - onceCents) : 0,
  );
  const worst = unitUnder(amountCents, centsUp(worstUsd), SIZING_READING, true);
  return { amountCents, centsPerDisplay, monthlyCents, onceCents, worst, keeps: worst.meetsFloor && worst.usageRoomCents - worst.usageCents >= ADD_ON_ROOM_CENTS };
}

// ------------------------------------------------------------- the document

const usd2 = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const pctOf = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const dollars = (n: number) => `$${n < 0.01 ? n.toFixed(5).replace(/0+$/, "") : n < 0.1 ? n.toFixed(4).replace(/0+$/, "") : n.toFixed(2)}`;

export function renderPerUseResale(): string {
  const d = data();
  const src = (id: string) => d.sources.find((s) => s.id === id)!;
  const link = (id: string) => `[${id}](${src(id).url})`;
  const cs = candidates();
  const out: string[] = [];
  const push = (...l: string[]) => out.push(...l);
  push("# Reselling per-use services at a profit: what to sell, at what price, and in what order: 18 October 2026");
  push("");
  push("<!-- Generated by `node scripts/per-use-resale.mjs` from docs/per-use-resale-data-2026-10-18.json and tests/per-use-resale-table.ts. Do not edit by hand: tests/per-use-resale.test.ts fails when this file is stale. -->");
  push("");
  push("**An analysis for the owner, not a change.** No price, limit or gate in code changes, and sales stay closed. Every rate is the lowest that keeps 60% per customer at full use under the repository's own margin code (lib/receiving-costs.ts `unitUnder`, sizing reading), sold the only way the owner allows: **prepaid credits, bought before use, use stopping automatically at zero** (docs/pack-cost-decomposition-2026-10-18.md, option 3). Post-paid billing (overage or a line on the renewal invoice) is not offered: the customer pays first, then receives.");
  push("");
  push("## The verdict");
  push("");
  push("| Order | Service | Verdict | Cost a unit (dearest supplier read) | Price a unit from a $250 credit / $1,000 credit | Fixed a month, and once, from a $1,000 credit | Against a competitor's own unit price | Why |");
  push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  const sorted = [...cs].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  for (const c of sorted) {
    const r250 = rateOf(c, 25_000), r1k = rateOf(c, 100_000);
    const vs = c.competitorUnitUsd === null ? "no unit price stated" : `${((r1k.centsPerDisplay / 100 / c.per) / c.competitorUnitUsd).toFixed(1)}× HighLevel's ${dollars(c.competitorUnitUsd * c.per)} per ${c.perName}`;
    const fixed = r1k.monthlyCents || r1k.onceCents ? `${usd2(r1k.monthlyCents)} a month${r1k.onceCents ? `, ${usd2(r1k.onceCents)} once` : ""}` : "none";
    push(`| ${c.order ?? "—"} | ${c.name} | **${c.verdict}** | ${dollars(c.unitUsd * c.per)} per ${c.perName} | ${usd2(r250.centsPerDisplay)} / ${usd2(r1k.centsPerDisplay)} per ${c.perName} | ${fixed} | ${vs} | ${c.why} |`);
  }
  push("");
  push("**The more a creator uses, the more Marktmorgen earns** on every service marked sell: each credit keeps 60% however it is spent, so profit grows with use and never turns into a loss. What it cannot do is be cheap: under the 60% rule and the receiving model a unit sells at about twenty times its cost (docs/pack-cost-decomposition-2026-10-18.md), so for messaging and calls, where HighLevel passes supplier rates through, Marktmorgen would be many times dearer. A position above competitors there is not reachable by price; for email, video and AI it comes from the plan's included figures, with credits only for the overflow.");
  push("");
  push("## Each rate, checked");
  push("");
  push("The whole credit spent on that one service alone, in the dearest way it can be (all units, all months of its fixed cost, or its one-time cost and units with the rest), under `unitUnder`:");
  push("");
  push("| Service | " + AMOUNTS.map((a) => `${usd(a)} credit: rate, net`).join(" | ") + " | Net under the most-tax reading ($1,000) |");
  push("| --- | " + AMOUNTS.map(() => "---").join(" | ") + " | --- |");
  for (const c of sorted) {
    push(`| ${c.name} | ` + AMOUNTS.map((a) => { const r = rateOf(c, a); return `${usd2(r.centsPerDisplay)} per ${c.perName}, ${pctOf(r.worst.netBps)}${r.keeps ? "" : " (**misses 60%**)"}`; }).join(" | ") + ` | ${pctOf(unitUnder(100_000, rateOf(c, 100_000).worst.usageCents, MOST_TAX_READING, true).netBps)} |`);
  }
  push("");
  push("A credit below the fixed costs of a service (SMS, WhatsApp, calls) buys months of those costs and no unit at all: the rate is useless to a creator who sends little, which is the usual creator.");
  push("");
  push("## Suppliers, as read");
  push("");
  push(d.note);
  push("");
  push("| Unit | What the page says | Sources |");
  push("| --- | --- | --- |");
  const sp = d.suppliers;
  for (const r of sp.smsSegment) push(`| SMS segment, ${r.name} | ${r.what} | ${link(r.source)} |`);
  push(`| A2P 10DLC | ${sp.tenDlc.what} | ${link(sp.tenDlc.source)} |`);
  push(`| Phone number | ${sp.phoneNumberMonthly.what} | ${link(sp.phoneNumberMonthly.source)} |`);
  push(`| Voice minute | ${sp.voiceMinute.what} | ${link(sp.voiceMinute.source)} |`);
  push(`| WhatsApp message | ${sp.whatsappMarketing.what} | ${link(sp.whatsappMarketing.source)} ${link("meta-whatsapp")} |`);
  push(`| AI voice minute | ${sp.aiVoiceMinute.what} | ${link(sp.aiVoiceMinute.source)} |`);
  push(`| Caption minute | ${sp.captionMinuteLanguage.what} | ${link(sp.captionMinuteLanguage.source)} |`);
  push(`| Video (an alternative supplier) | ${sp.videoAlternative.what} | ${link(sp.videoAlternative.source)} |`);
  for (const e of sp.emailAlternatives) push(`| Email, ${e.name} | ${e.what} | ${link(e.source)} |`);
  push(`| SMS, Vonage | ${src("vonage").read} | ${link("vonage")} |`);
  push("");
  push("## Competitors, as read");
  push("");
  push("| Service | Who | What the page says | Source |");
  push("| --- | --- | --- | --- |");
  for (const [k, rows] of Object.entries(d.competitors)) for (const r of rows) push(`| ${k} | ${r.who} | ${r.what} | ${link(r.source)} |`);
  push("");
  push("## Compliance and engineering, per service");
  push("");
  push("| Service | Legal and compliance burden (to review with counsel; not legal advice) | Engineering |");
  push("| --- | --- | --- |");
  for (const c of sorted) push(`| ${c.name} | ${c.compliance} | ${c.effort} |`);
  push("");
  push("## The order to build");
  push("");
  for (const c of sorted.filter((x) => x.order !== null)) push(`${c.order}. **${c.name}**: ${c.effort}.`);
  push("");
  push("Not before something structural changes: SMS, WhatsApp, calls and AI voice. Each would sell at about twenty times the supplier's rate against competitors that pass it through, carries a fixed cost per creator each month before the first use, and brings the heaviest consent rules; AI voice has a cost no page bounds. \"Paid third-party services\" in general are not evaluated: no specific service was named, and each would need its own reading.");
  push("");
  push("## What is not known");
  push("");
  push("- **Demand** for any of these, at any price. No sale has been open.");
  push("- **Meta's own WhatsApp rate card** (its page links a file that was not read) and **Vonage's US rates** (not stated on its page); Plivo's listed price stands in for WhatsApp, and Vonage is not used.");
  push("- **Twilio's volume tiers**: its page lists standard rates only; the standard rate is the dearest and is the one used.");
  push("- **Stripe's own pricing page** was not re-read (docs/pack-cost-decomposition-2026-10-18.md); the receiving model keeps the dearer of Stripe and Paddle.");
  push("- **The legal analysis** is a list of burdens to review, not advice and not a finding that any service is lawful as built.");
  push("");
  return HISTORICAL_MARGIN_NOTICE + out.join("\n");
}
