/**
 * "Ask us to look again", kept and passed on (646 [WG6], unit 2, 10 November 2026). The rules are in
 * lib/takedown-appeal-rules.ts; this file reads the decisions a store can ask about, keeps each request and tells the
 * support inbox, where a person at Marktmorgen reads it (the same inbox that reads the notices, lib/takedown.ts).
 *
 *   nl:report:<notice>:a:<sha(store, decision)> JSON  one request about one decision of that notice, with whether the
 *                                               support inbox was told; 400 days, like the notice itself
 *   nl:report:an:<number>                 string the request's key, so a number is given once; 400 days
 *
 * Both sit in the company's family of a notice (nl:report:): a request is part of the record of a takedown that
 * Marktmorgen keeps, not the store's content, and it costs no plan anything. At most one request per decision, and a
 * store keeps at most 50 decisions (lib/store.ts parseStrikes), so a store keeps at most 50 requests.
 *
 * The decisions are the store's own strikes, the record lib/takedown.ts writes once per takedown. A strike keeps what
 * was taken down, in the words the creator was emailed, and when the takedown began, not when the email went out (a
 * notice sent later, sendOwedNotice, keeps the first time). So the time the creator was told is not known here, and no
 * request is ever refused as late: the six months of lib/takedown-appeal-rules.ts start only once a send time is kept.
 *
 * Every reply is read in its exact shape (rule 24): an unknown read throws, and is never "no request".
 */
import { createHash, randomBytes } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import type { Store } from "@/lib/store";
import {
  type Appeal, type AppealProblem, type Decision, type DecisionKind, APPEAL_NUMBER, APPEAL_PROBLEMS, MAX_APPEAL_TEXT, appealNumber,
  appealVisibleTo, decisionKey, openAppeal, readAppeal,
} from "@/lib/takedown-appeal-rules";

const KEEP_SECONDS = 400 * 86_400;
/** Tries at a number not given yet: 40 random bits each, so a second try is already rare. */
const NUMBER_TRIES = 3;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const key = (rest: string) => `nl:report:${rest}`;
/** The store's permanent id is in the hash: two stores with alike strikes never share a request. */
const recordKey = (sid: string, decision: Decision) => key(`${noticeOf(decision.report)}:a:${sha(`${sid}
${decisionKey(decision)}`).slice(0, 24)}`);
const numberKey = (number: string) => key(`an:${number}`);
/** A notice's id as lib/takedown.ts makes it (16 hex); anything else is hashed, so it never shapes a key. */
const noticeOf = (report: string) => (/^[0-9a-f]{16}$/.test(report) ? report : `x${sha(report).slice(0, 16)}`);

/**
 * What kind of takedown a strike was, from the words lib/takedown.ts writes for each (`stillUp`). Words it does not
 * know are "other": the request is still taken, and nothing is said about putting it back.
 */
export function kindOfStrike(what: string): DecisionKind {
  if (what.startsWith("The link \"")) return "link";
  if (what.startsWith("The product \"")) return "product";
  if (what.startsWith("Your media kit")) return "kit";
  if (what.startsWith("Your store's pages and sales")) return "store";
  return "other";
}

export type StoreDecision = Decision & { key: string; decidedAt: string };

/** The decisions a store can ask about, newest first, one per decision key. */
export function decisionsOf(store: Pick<Store, "strikes">): StoreDecision[] {
  const seen = new Set<string>();
  const out: StoreDecision[] = [];
  for (const strike of store.strikes) {
    if (!strike.report || !strike.what) continue;
    const kind = kindOfStrike(strike.what);
    // The media kit and the store are one per store; a link, a product or an unknown kind is told apart by its strike.
    const id = kind === "kit" || kind === "store" ? "" : sha(`${strike.at}\n${strike.what}`).slice(0, 12);
    const decision: Decision = { report: strike.report, kind, id, informedAt: "", what: strike.what, automated: false };
    const k = decisionKey(decision);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...decision, key: k, decidedAt: strike.at });
  }
  return out;
}

/** `tries`: inbox emails tried for this request, at most MAX_TELL_TRIES; each try has its own idempotency key. */
export type KeptAppeal = { appeal: Appeal; told: boolean; tries: number };

/**
 * The most inbox emails one request may try. A try whose outcome the email service could not confirm is never sent
 * again under the same key (lib/resend-fallback-transport.ts), so each try has its own; the inbox may then get the
 * same request twice, never more than this, and never a buyer or a creator.
 */
export const MAX_TELL_TRIES = 3;

function readKept(raw: string): KeptAppeal {
  const v: unknown = JSON.parse(raw);
  const r = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const a = r?.appeal && typeof r.appeal === "object" ? (r.appeal as Record<string, unknown>) : null;
  if (!r || !a || typeof r.told !== "boolean" || typeof r.tries !== "number" || !Number.isSafeInteger(r.tries) || r.tries < 0 || typeof a.number !== "string" || !APPEAL_NUMBER.test(a.number) || typeof a.store !== "string" ||
      typeof a.decision !== "string" || typeof a.explanation !== "string" || typeof a.at !== "string" || !Array.isArray(a.moves) ||
      !["received", "under_review", "upheld", "reversed"].includes(String(a.state))) {
    throw new UnknownReplyError("a request to look again");
  }
  return { appeal: a as unknown as Appeal, told: r.told, tries: r.tries };
}

/**
 * The requests this store sent, by decision key: one exact read of every decision's record, in one round trip. A
 * record kept for another store is never returned (it cannot be reached from this store's strikes, and is checked
 * anyway). Throws on any unknown reply.
 */
export async function readAppeals(store: Pick<Store, "strikes" | "sid">, decisions = decisionsOf(store)): Promise<Map<string, KeptAppeal>> {
  const found = new Map<string, KeptAppeal>();
  if (!decisions.length) return found;
  const replies = repliesFor(await redisPipeline(decisions.map((d) => ["GET", recordKey(store.sid, d)])), decisions.length);
  if (!replies) throw new UnknownReplyError("requests to look again");
  decisions.forEach((d, i) => {
    const raw = replies[i];
    if (raw === null) return;
    if (typeof raw !== "string") throw new UnknownReplyError("a request to look again");
    const kept = readKept(raw);
    if (appealVisibleTo(kept.appeal, store.sid) && kept.appeal.decision === d.key) found.set(d.key, kept);
  });
  return found;
}

export type FileResult =
  | { ok: true; kept: KeptAppeal }
  | { ok: false; problem: AppealProblem | "unsent"; words: string };

export const UNSENT_WORDS = "Your request is kept with its number, but we could not pass it on to our team just now. Use Send it again in a moment.";
export const TRIES_SPENT_WORDS = "Your request is kept with its number, but we could not pass it on to our team. Reply to the email we sent you about this decision, with your request number, and a person will read it.";

/**
 * Keeps a creator's request about one of their store's decisions and tells the support inbox. In order: the decision
 * and the request's words are checked (lib/takedown-appeal-rules.ts), a number is taken once, the request is written
 * only where none is (two presses at once keep one), and then the inbox is told. A request whose inbox email could not
 * be sent stays kept, marked so, and the studio offers to send it again (`sendAgain`).
 */
export async function fileAppeal(store: Store, decisionKeyRaw: unknown, raw: Record<string, unknown>, now: Date, origin: string): Promise<FileResult> {
  if (!store.sid) return { ok: false, problem: "decision", words: APPEAL_PROBLEMS.decision };
  const decisions = decisionsOf(store);
  const decision = decisions.find((d) => d.key === decisionKeyRaw) ?? null;
  // Earlier requests read exactly; an unknown read is passed on as unknown, so nothing is taken.
  const earlier = decision ? await readAppeals(store, decisions).then((m) => [...m.keys()], () => null) : [];
  // Only the words: files are a later unit, and nothing here takes them.
  const checked = readAppeal({ explanation: raw.explanation }, decision, earlier, now);
  if (!checked.ok) return checked;
  const target = decision as StoreDecision;
  const rk = recordKey(store.sid, target);
  let number = "";
  for (let i = 0; i < NUMBER_TRIES && !number; i++) {
    const candidate = appealNumber(randomBytes(5));
    const replies = repliesFor(await redisPipeline([["SET", numberKey(candidate), rk, "NX", "EX", KEEP_SECONDS]]), 1);
    if (!replies || (replies[0] !== "OK" && replies[0] !== null)) throw new UnknownReplyError("a request number");
    if (replies[0] === "OK") number = candidate;
  }
  if (!number) throw new Error("no request number was free");
  const kept: KeptAppeal = { appeal: openAppeal(checked.appeal, number, store.sid), told: false, tries: 0 };
  const written = repliesFor(await redisPipeline([["SET", rk, JSON.stringify(kept), "NX", "EX", KEEP_SECONDS]]), 1);
  if (!written || (written[0] !== "OK" && written[0] !== null)) throw new UnknownReplyError("a request to look again's write");
  if (written[0] === null) return { ok: false, problem: "already", words: APPEAL_PROBLEMS.already };
  return tell(store, target, kept, origin);
}

/** Tells the inbox again about a kept request it was never told of. Nothing else changes. */
export async function sendAgain(store: Store, decisionKeyRaw: unknown, origin: string): Promise<FileResult | null> {
  const decisions = decisionsOf(store);
  const decision = decisions.find((d) => d.key === decisionKeyRaw);
  if (!decision || !store.sid) return null;
  const kept = (await readAppeals(store, decisions)).get(decision.key);
  if (!kept) return null;
  if (kept.told) return { ok: true, kept };
  return tell(store, decision, kept, origin);
}

async function tell(store: Store, decision: StoreDecision, kept: KeptAppeal, origin: string): Promise<FileResult> {
  const { appeal } = kept;
  if (kept.tries >= MAX_TELL_TRIES) return { ok: false, problem: "unsent", words: TRIES_SPENT_WORDS };
  // The try is counted before the email, so a lost count never lets a fourth one go.
  const counted: KeptAppeal = { ...kept, tries: kept.tries + 1 };
  const mark = repliesFor(await redisPipeline([["SET", recordKey(store.sid, decision), JSON.stringify(counted), "XX", "EX", KEEP_SECONDS]]), 1);
  if (!mark || mark[0] !== "OK") throw new UnknownReplyError("a request to look again's try");
  const sent = await sendEmail({ meter: { by: "company" },
    from: NIMBUS_FROM,
    to: SUPPORT_EMAIL,
    replyTo: store.email,
    subject: `Request to look again ${appeal.number} from @${store.handle}`.slice(0, 200),
    text: [
      `@${store.handle} asks us to look again at a decision (request ${appeal.number}, sent ${appeal.at}).`,
      "",
      `What we decided: ${decision.what}`,
      `Taken down: ${decision.decidedAt}. Notice ${decision.report}.`,
      "",
      "What they wrote:",
      appeal.explanation.slice(0, MAX_APPEAL_TEXT),
      "",
      `Open the notice from its own email to act on it; the store is ${origin}/@${store.handle}.`,
      "A person decides, and the answer gives its reason. Reply to this email to answer the creator.",
    ].join("\n"),
    // One key per try: a retry of one try never sends twice; a new try is a new email, at most MAX_TELL_TRIES.
    idempotencyKey: `appeal-${appeal.number}-${counted.tries}`,
  }).catch(() => false);
  if (!sent) return { ok: false, problem: "unsent", words: counted.tries >= MAX_TELL_TRIES ? TRIES_SPENT_WORDS : UNSENT_WORDS };
  const told: KeptAppeal = { ...counted, told: true };
  const replies = repliesFor(await redisPipeline([["SET", recordKey(store.sid, decision), JSON.stringify(told), "XX", "EX", KEEP_SECONDS]]), 1);
  // The inbox has it. A mark that did not land leaves Send it again offered, and a press of it is a new try with a new
  // key, so the inbox may get this request once more: never more than MAX_TELL_TRIES in all, and never a buyer.
  if (!replies || replies[0] !== "OK") return { ok: true, kept: counted };
  return { ok: true, kept: told };
}
