/**
 * 646 [WG6] unit 1: the rules of "Ask us to look again" (lib/takedown-appeal-rules.ts), synthetic data only.
 * Each part fails on the wrong behavior it names: a period shorter than six months (Whop's 30 days, a month-end
 * clamped back), a creator or an automatic step deciding, a final answer moving again or without its reason, a request
 * seen from another store, an unknown read taken as "none", a notice that promises a result or claims what the store
 * cannot do, and files or text over their ceiling taken before a write.
 */
import { done, is, part } from "./check";
import {
  APPEAL_NUMBER, APPEAL_STATE_MEANING, APPEAL_STATE_WORDS, MAX_APPEAL_ATTACHMENT_BYTES, MAX_APPEAL_ATTACHMENTS, MAX_APPEAL_TEXT,
  appealDate, appealDeadline, appealNumber, appealStateWords, appealStoredBytesCeiling, appealVisibleTo, decisionKey, decisionNotice,
  moveAppeal, openAppeal, readAppeal, restorable, type Decision,
} from "@/lib/takedown-appeal-rules";

const PRODUCT: Decision = { report: "r1a2b3c4d5e6f7a8", kind: "product", id: "p_123", informedAt: "2026-11-10T15:00:00.000Z", what: 'The product "Synthetic Guide", now unpublished', automated: false };
const LINK: Decision = { ...PRODUCT, kind: "link", id: "l_9", what: 'The link "Synthetic link" (https://example.test/file)' };
const STORE: Decision = { ...PRODUCT, kind: "store", id: "", what: "Your store's pages and sales, now switched off" };
const at = (iso: string) => new Date(iso);
const ALL: { exportData: boolean; refundBuyers: boolean; closeStore: boolean } = { exportData: true, refundBuyers: true, closeStore: true };

part("Six months at least, from the day the creator was told (DSA Art. 20(1)-(2))");
{
  const d = appealDeadline("2026-11-10T15:00:00.000Z");
  is("shown date is six calendar months later", d && appealDate(d.shown), "May 10, 2027");
  is("taken to the end of that day in the last time zone (UTC-12)", d?.last.toISOString(), "2027-05-11T11:59:59.999Z");
  const end = appealDeadline("2026-08-31T09:00:00.000Z");
  is("31 August rolls forward to 1 March, never back to 28 February", end && appealDate(end.shown), "March 1, 2027");
  const leap = appealDeadline("2027-08-31T00:00:00.000Z");
  is("in a leap year, 31 August rolls to 1 March too", leap && appealDate(leap.shown), "March 1, 2028");
  const spans = [
    "2026-01-31T23:59:59.000Z", "2026-03-31T00:00:00.000Z", "2026-05-31T12:00:00.000Z", "2026-07-15T00:00:00.000Z", "2026-12-31T23:00:00.000Z",
  ].map((iso) => {
    const dl = appealDeadline(iso)!;
    const sixMonths = new Date(iso);
    sixMonths.setUTCMonth(sixMonths.getUTCMonth() + 6);
    return dl.last.getTime() >= sixMonths.getTime() && dl.last.getTime() - new Date(iso).getTime() >= 181 * 86_400_000;
  });
  is("never shorter than six months, at month ends and year ends", spans, [true, true, true, true, true]);
  is("not a time: no deadline (never 'too late' on a date nobody can read)", [appealDeadline(""), appealDeadline("soon"), appealDeadline("2026-13-45T00:00:00Z")], [null, null, null]);
}

part("A request is taken inside the period and refused after it, with the date and the court");
{
  const inside = readAppeal({ explanation: "I own the rights to this guide." }, PRODUCT, [], at("2027-05-11T11:59:59.000Z"));
  is("the last minute in the last time zone is taken", inside.ok, true);
  const day31 = readAppeal({ explanation: "Mine." }, PRODUCT, [], at("2026-12-10T15:00:00.000Z"));
  is("a request 30 days after (Whop's period) is still taken", day31.ok, true);
  const late = readAppeal({ explanation: "I own the rights to this guide." }, PRODUCT, [], at("2027-05-11T12:00:00.000Z"));
  is("one millisecond-scale moment after the end is refused as late", late.ok ? "" : late.problem, "late");
  is("the refusal says when it ended and that a court can still be asked", late.ok ? "" : late.words,
    'The time to ask us to look again at this decision ended on May 10, 2027. You can still take our decision to a court: section 16 of our Terms, "Governing law", says which law and courts apply.');
  const unknownDate = readAppeal({ explanation: "Mine." }, { ...PRODUCT, informedAt: "unknown" }, [], at("2035-01-01T00:00:00.000Z"));
  is("an unreadable told-date never makes a request late", unknownDate.ok, true);
}

part("One request per decision; an unknown read of earlier requests takes nothing");
{
  is("a decision already asked about is refused", (() => { const r = readAppeal({ explanation: "Again." }, PRODUCT, [decisionKey(PRODUCT)], at("2026-11-11T00:00:00Z")); return r.ok ? "" : r.problem; })(), "already");
  is("another decision of the same store is taken", readAppeal({ explanation: "Different one." }, LINK, [decisionKey(PRODUCT)], at("2026-11-11T00:00:00Z")).ok, true);
  const unknown = readAppeal({ explanation: "Mine." }, PRODUCT, null, at("2026-11-11T00:00:00Z"));
  is("earlier requests unknown: nothing taken, said so", unknown.ok ? "" : `${unknown.problem}: ${unknown.words}`, "unknown: We could not check your earlier requests just now, so nothing was sent. Try again in a moment.");
  is("keys differ by kind, id and notice", new Set([decisionKey(PRODUCT), decisionKey(LINK), decisionKey(STORE), decisionKey({ ...PRODUCT, report: "other" })]).size, 4);
}

part("What a request may hold, checked before anything is written");
{
  const now = at("2026-11-11T00:00:00Z");
  const ok = readAppeal({ explanation: "  The   guide is\r\nmine.  ", attachments: [{ name: " licence.pdf ", type: "application/pdf", bytes: 1024 }] }, PRODUCT, [], now);
  is("text is cleaned, files kept with name, type and size", ok.ok ? ok.appeal : null,
    { decision: "product-p_123@r1a2b3c4d5e6f7a8", explanation: "The guide is\nmine.", attachments: [{ name: "licence.pdf", type: "application/pdf", bytes: 1024 }], at: "2026-11-11T00:00:00.000Z" });
  const problem = (raw: Record<string, unknown>) => { const r = readAppeal(raw, PRODUCT, [], now); return r.ok ? "taken" : r.problem; };
  is("empty explanation", problem({ explanation: "   " }), "explanation");
  is("no explanation", problem({}), "explanation");
  is("explanation over the ceiling is refused, never cut", problem({ explanation: "x".repeat(MAX_APPEAL_TEXT + 1) }), "explanation_long");
  is("explanation at the ceiling is taken", problem({ explanation: "x".repeat(MAX_APPEAL_TEXT) }), "taken");
  const file = { name: "a.png", type: "image/png", bytes: 10 };
  is("files at the ceiling are taken", problem({ explanation: "Mine.", attachments: Array(MAX_APPEAL_ATTACHMENTS).fill(file) }), "taken");
  is("one file too many", problem({ explanation: "Mine.", attachments: Array(MAX_APPEAL_ATTACHMENTS + 1).fill(file) }), "attachments");
  is("files not a list", problem({ explanation: "Mine.", attachments: "a.png" }), "attachments");
  is("a file type not on the list", problem({ explanation: "Mine.", attachments: [{ ...file, type: "application/x-msdownload" }] }), "attachment_type");
  is("a file over its size", problem({ explanation: "Mine.", attachments: [{ ...file, bytes: MAX_APPEAL_ATTACHMENT_BYTES + 1 }] }), "attachment_size");
  is("a file at its size", problem({ explanation: "Mine.", attachments: [{ ...file, bytes: MAX_APPEAL_ATTACHMENT_BYTES }] }), "taken");
  is("an empty, fractional or unsafe size", ["0", "1.5", "big"].map((b) => problem({ explanation: "Mine.", attachments: [{ ...file, bytes: b === "0" ? 0 : b === "1.5" ? 1.5 : Number.MAX_SAFE_INTEGER + 2 }] })), ["attachment_size", "attachment_size", "attachment_size"]);
  is("a decision that does not name itself", [
    readAppeal({ explanation: "Mine." }, { ...PRODUCT, id: "" }, [], now),
    readAppeal({ explanation: "Mine." }, { ...STORE, id: "x" }, [], now),
    readAppeal({ explanation: "Mine." }, { ...PRODUCT, kind: "account" }, [], now),
    readAppeal({ explanation: "Mine." }, null, [], now),
  ].map((r) => (r.ok ? "taken" : r.problem)), ["decision", "decision", "decision", "decision"]);
  is("the most one request can keep, checked against its parts", appealStoredBytesCeiling(), (3_000 + 1_000) * 4 + 3 * (4 * 1024 * 1024 + 120 * 4) + 4_096);
}

part("A number of its own, in a shape that reads aloud without mix-ups");
{
  const a = appealNumber(Uint8Array.from([0, 0, 0, 0, 0]));
  const b = appealNumber(Uint8Array.from([255, 255, 255, 255, 255]));
  const c = appealNumber(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  is("shapes", [a, b, APPEAL_NUMBER.test(c)], ["LA-0000-0000", "LA-ZZZZ-ZZZZ", true]);
  is("different bytes, different numbers", new Set([a, b, c, appealNumber(Uint8Array.from([1, 2, 3, 4, 6]))]).size, 4);
  is("no I, L, O or U after the prefix", /[ILOU]/.test(c.slice(3)) || /[ILOU]/.test(b.slice(3)), false);
  let threw = false;
  try { appealNumber(Uint8Array.from([1, 2])); } catch { threw = true; }
  is("too few random bytes is refused", threw, true);
}

part("Only a person at Marktmorgen moves a request, forward only, with a reason on the final answer");
{
  const draft = readAppeal({ explanation: "Mine." }, PRODUCT, [], at("2026-11-11T00:00:00Z"));
  const appeal = openAppeal(draft.ok ? draft.appeal : (null as never), "LA-0000-0001", "store-ref-a");
  is("opens as Received, moved by the creator", [appeal.state, appeal.moves], ["received", [{ state: "received", at: "2026-11-11T00:00:00.000Z", by: "creator" }]]);
  const t = at("2026-11-12T00:00:00Z");
  const who = (role: "creator" | "operator" | "automatic", to: "under_review" | "upheld" | "reversed") => { const r = moveAppeal(appeal, to, { role }, t, "Reason."); return r.ok ? r.appeal.state : r.problem; };
  is("the creator cannot decide", [who("creator", "reversed"), who("creator", "under_review")], ["who", "who"]);
  is("an automatic step cannot decide (Art. 20(6))", [who("automatic", "upheld"), who("automatic", "under_review")], ["who", "who"]);
  is("a person can review, uphold or reverse", [who("operator", "under_review"), who("operator", "upheld"), who("operator", "reversed")], ["under_review", "upheld", "reversed"]);
  const noReason = moveAppeal(appeal, "upheld", { role: "operator" }, t, "   ");
  is("a final answer without its reason is refused (Art. 20(5))", noReason.ok ? "" : noReason.problem, "reason");
  const review = moveAppeal(appeal, "under_review", { role: "operator" }, t);
  const reviewing = review.ok ? review.appeal : appeal;
  const back = moveAppeal(reviewing, "received", { role: "operator" }, t);
  is("nothing moves back", back.ok ? "" : back.problem, "order");
  const same = moveAppeal(reviewing, "under_review", { role: "operator" }, t);
  is("nor to where it is", same.ok ? "" : same.problem, "order");
  const kept = moveAppeal(reviewing, "upheld", { role: "operator" }, at("2026-11-13T00:00:00Z"), "The notice names the guide and the original.");
  const final = kept.ok ? kept.appeal : reviewing;
  is("the final move keeps its reason", final.moves[final.moves.length - 1], { state: "upheld", at: "2026-11-13T00:00:00.000Z", by: "operator", reason: "The notice names the guide and the original." });
  const again = moveAppeal(final, "reversed", { role: "operator" }, t, "Changed mind.");
  is("a final state never moves again", again.ok ? "" : again.problem, "final");
  is("the record before a move is not changed by it", appeal.state, "received");
  let threw = 0;
  try { openAppeal(draft.ok ? draft.appeal : (null as never), "LA-OOOO-0001", "s"); } catch { threw++; }
  try { openAppeal(draft.ok ? draft.appeal : (null as never), "LA-0000-0001", ""); } catch { threw++; }
  is("a number of another shape, or no store, is refused", threw, 2);
}

part("A request is seen only from the store that sent it");
{
  const appeal = { store: "store-ref-a" };
  is("same store, another store, no store", [appealVisibleTo(appeal, "store-ref-a"), appealVisibleTo(appeal, "store-ref-b"), appealVisibleTo(appeal, ""), appealVisibleTo({ store: "" }, "")], [true, false, false, false]);
}

part("The studio's notice says what is true and never promises a result");
{
  const lines = decisionNotice(PRODUCT, at("2026-11-11T00:00:00Z"), ALL);
  is("all lines, in order", lines, [
    'What we decided: The product "Synthetic Guide", now unpublished.',
    "When we told you: November 10, 2026.",
    "A person at Marktmorgen read the notice and took this decision. No automatic check was used.",
    "You can still download your store's data, refund your buyers and close your store.",
    "You can ask us to look again until May 10, 2027. It is free.",
    "The decision stays in place while we look, and we cannot tell you in advance what we will decide.",
    'You can still take our decision to a court: section 16 of our Terms, "Governing law", says which law and courts apply.',
  ]);
  const none = decisionNotice(STORE, at("2026-11-11T00:00:00Z"), { exportData: false, refundBuyers: false, closeStore: false });
  is("what the store cannot do is never said", none.some((l) => l.startsWith("You can still download") || l.includes("refund your buyers") || l.includes("close your store")), false);
  const one = decisionNotice(STORE, at("2026-11-11T00:00:00Z"), { exportData: false, refundBuyers: true, closeStore: false });
  is("one thing it can do", one.find((l) => l.startsWith("You can still refund")), "You can still refund your buyers.");
  const link = decisionNotice(LINK, at("2026-11-11T00:00:00Z"), ALL);
  is("a deleted link says it cannot be put back", link.includes("The link and its file were deleted, so they cannot be put back. If we change our decision, you can add the link again."), true);
  is("a product never says that", lines.some((l) => l.includes("cannot be put back")), false);
  const ended = decisionNotice(PRODUCT, at("2027-06-01T00:00:00Z"), ALL);
  is("after the period: the date it ended, no offer to ask, the court kept", [ended.includes("The time to ask us to look again ended on May 10, 2027."), ended.some((l) => l.startsWith("You can ask us")), ended[ended.length - 1].includes("court")], [true, false, true]);
  is("an automatic decision says so", decisionNotice({ ...PRODUCT, automated: true }, at("2026-11-11T00:00:00Z"), ALL)[2], "An automatic check took this decision.");
  const undated = decisionNotice({ ...PRODUCT, informedAt: "?" }, at("2026-11-11T00:00:00Z"), ALL);
  is("no readable date: no date line, and no end date shown", [undated.some((l) => l.startsWith("When we told you")), undated.includes("You can ask us to look again. It is free.")], [false, true]);
  const words = [lines, link, ended, one, none].flat().join(" ").toLowerCase();
  is("no promise of a result anywhere", /\b(will be (restored|reversed|back|put back)|guarantee|we will (restore|reverse|put)|always|certainly|for sure)\b/.test(words), false);
}

part("Each state's words, with its number and the reason of a final answer");
{
  is("state names", Object.values(APPEAL_STATE_WORDS), ["Received", "Under review", "Upheld", "Reversed"]);
  is("each name explained in plain words", Object.keys(APPEAL_STATE_MEANING).length, 4);
  const base = { number: "LA-0000-0001", decision: decisionKey(PRODUCT) };
  is("received", appealStateWords({ ...base, state: "received", moves: [{ state: "received", at: "x", by: "creator" }] }), [
    "Request LA-0000-0001: Received.", "We have your request. A person at Marktmorgen will look at it.",
  ]);
  is("upheld: the reason and the court", appealStateWords({ ...base, state: "upheld", moves: [{ state: "upheld", at: "x", by: "operator", reason: "The notice names the original." }] }), [
    "Request LA-0000-0001: Upheld.", "We looked again and kept our decision.", "Why: The notice names the original.",
    'You can still take our decision to a court: section 16 of our Terms, "Governing law", says which law and courts apply.',
  ]);
  is("reversed product: back as it was", appealStateWords({ ...base, state: "reversed", moves: [{ state: "reversed", at: "x", by: "operator", reason: "Licence shown." }] }).slice(2), [
    "Why: Licence shown.", "What was taken down is back as it was.",
  ]);
  is("reversed link: says it cannot be put back, never 'back as it was'", appealStateWords({ number: "LA-0000-0002", decision: decisionKey(LINK), state: "reversed", moves: [{ state: "reversed", at: "x", by: "operator", reason: "Licence shown." }] }).slice(2), [
    "Why: Licence shown.", "The link and its file were deleted, so they cannot be put back. You can add the link again.",
  ]);
  is("restorable kinds", [restorable("link"), restorable("product"), restorable("kit"), restorable("store")], [false, true, true, true]);
}

done();
