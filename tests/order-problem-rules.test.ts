/**
 * 567 [GD1] (a), unit 1: the rules of "Report a problem with this order".
 * The four reasons, the creator's seven days to answer, what a case says in
 * the creator's inbox, and the buyer's words in every store language
 * (lib/order-problem-rules.ts, lib/buyer-words/order-problem.ts). Pure: no
 * read, no write, no email. Synthetic orders only.
 */
import {
  ORDER_PROBLEM_NOTE_MAX,
  ORDER_PROBLEM_NOTE_MIN_OTHER,
  ORDER_PROBLEM_REASONS,
  ORDER_PROBLEM_REPLY_DAYS,
  caseText,
  readOrderProblem,
  replyDueAt,
  replyLate,
} from "@/lib/order-problem-rules";
import { ORDER_PROBLEM_KEYS, orderProblemWords } from "@/lib/buyer-words/order-problem";
import { LANGUAGES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const DAY_MS = 86_400_000;
const SESSION = "cs_test_a1B2c3D4e5F6g7H8";
const INTENT = "pi_3QabcdEFGHijkl";
const IMPORTED = `imp_${"0a1b2c3d4e5f".repeat(2)}`;

function main(): void {
  part("The four reasons, in order, and the creator's seven days");
  is("the reasons the owner listed", ORDER_PROBLEM_REASONS, ["not_received", "not_as_described", "cannot_access", "other"]);
  is("seven days to answer", ORDER_PROBLEM_REPLY_DAYS, 7);
  is("a note is at most 1,000 characters", ORDER_PROBLEM_NOTE_MAX, 1_000);
  is("'Something else' needs a few words", ORDER_PROBLEM_NOTE_MIN_OTHER, 10);

  part("Reading what the buyer sent");
  is("a checkout order with a reason and no note", readOrderProblem({ reason: "not_received", note: "", order: SESSION }), { ok: true, problem: { reason: "not_received", note: "", reference: SESSION } });
  is("a one-click order", readOrderProblem({ reason: "cannot_access", order: INTENT }), { ok: true, problem: { reason: "cannot_access", note: "", reference: INTENT } });
  is("an imported order", readOrderProblem({ reason: "not_as_described", note: "Chapter 3 is missing.", order: IMPORTED }), { ok: true, problem: { reason: "not_as_described", note: "Chapter 3 is missing.", reference: IMPORTED } });
  is("an unknown reason is refused", readOrderProblem({ reason: "refund_now", order: SESSION }), { ok: false, field: "reason" });
  is("a reason that is not a string is refused", readOrderProblem({ reason: ["other"], order: SESSION }), { ok: false, field: "reason" });
  is("an inherited reason is refused", readOrderProblem({ reason: "toString", order: SESSION }), { ok: false, field: "reason" });
  is("an order of another shape is refused", readOrderProblem({ reason: "other", note: "Something is wrong here.", order: "ch_123" }), { ok: false, field: "order" });
  is("a missing order is refused", readOrderProblem({ reason: "not_received" }), { ok: false, field: "order" });
  is("'Something else' with too few words is refused", readOrderProblem({ reason: "other", note: "  help  ", order: SESSION }), { ok: false, field: "note" });
  is("'Something else' with its words is read", readOrderProblem({ reason: "other", note: "The link asks me for a password.", order: SESSION }), { ok: true, problem: { reason: "other", note: "The link asks me for a password.", reference: SESSION } });
  is("a note longer than the most is refused, never cut", readOrderProblem({ reason: "not_received", note: "a".repeat(1_001), order: SESSION }), { ok: false, field: "note" });
  is("a note of exactly the most is read", (readOrderProblem({ reason: "not_received", note: "a".repeat(1_000), order: SESSION }) as { ok?: boolean } | null)?.ok, true);
  is("a note that is not text is refused", readOrderProblem({ reason: "not_received", note: 42, order: SESSION }), { ok: false, field: "note" });
  is("control characters become spaces and line breaks stay", readOrderProblem({ reason: "not_received", note: "Line one\r\nLine\u0007two", order: SESSION }), { ok: true, problem: { reason: "not_received", note: "Line one\nLine two", reference: SESSION } });
  is("nothing at all is refused", readOrderProblem(null), { ok: false, field: "reason" });
  is("a list is refused", readOrderProblem([]), { ok: false, field: "reason" });

  part("When the creator's answer is due");
  const at = Date.UTC(2026, 10, 11, 18, 0, 0);
  is("seven days after the report", replyDueAt(at), at + 7 * DAY_MS);
  is("an unknown time has no due date", replyDueAt(Number.NaN), null);
  is("a time before 1970 has no due date", replyDueAt(-1), null);
  is("not late a moment before", replyLate(at + 7 * DAY_MS, at + 7 * DAY_MS - 1), false);
  is("late at the due time", replyLate(at + 7 * DAY_MS, at + 7 * DAY_MS), true);
  is("an unknown due time is unknown, never late or on time", replyLate(Number.NaN, at), null);
  is("an unknown now is unknown", replyLate(at, Number.NaN), null);

  part("What the creator reads in the inbox");
  const text = caseText({ reason: "not_as_described", note: "Chapter 3 is missing.", reference: SESSION }, { title: "Bread at Home", paidAt: Date.UTC(2026, 10, 2) / 1000 }, at);
  is("says it is a problem with an order, the reason, the product, the date paid, the buyer's words and the due date",
    text,
    [
      "Problem with an order: It is not what was described.",
      "Product: Bread at Home",
      "Paid on: November 2, 2026",
      "Order: cs_test_a1B2c3D4e5F6g7H8",
      "",
      "Chapter 3 is missing.",
      "",
      "Please answer by November 18, 2026 (UTC). If you do not, the buyer is shown your contact details and your refund policy.",
    ].join("\n"));
  const bare = caseText({ reason: "not_received", note: "", reference: INTENT }, { title: "", paidAt: 0 }, at);
  is("an unknown title and paid date are said as unknown, never invented",
    bare,
    [
      "Problem with an order: I did not get it.",
      "Product: unknown",
      "Paid on: unknown",
      `Order: ${INTENT}`,
      "",
      "Please answer by November 18, 2026 (UTC). If you do not, the buyer is shown your contact details and your refund policy.",
    ].join("\n"));
  is("a title is one line", caseText({ reason: "cannot_access", note: "", reference: SESSION }, { title: "Two\nlines", paidAt: 0 }, at).split("\n")[1], "Product: Two lines");
  is("an unknown report time gives no case", caseText({ reason: "cannot_access", note: "", reference: SESSION }, { title: "A", paidAt: 0 }, Number.NaN), "");

  part("The buyer's words, in every store language");
  const codes = Object.keys(LANGUAGES) as LanguageCode[];
  is("seven languages", codes, ["en", "es", "fr", "de", "it", "nl", "pt"]);
  for (const code of codes) {
    const words = orderProblemWords(code);
    const missing = ORDER_PROBLEM_KEYS.filter((key) => typeof words[key] !== "string" || !String(words[key]).trim());
    is(`${code}: every sentence is there`, missing, []);
    is(`${code}: every reason has its words`, ORDER_PROBLEM_REASONS.filter((reason) => !words.reasons[reason]?.trim()), []);
    is(`${code}: the sent line names the store and the seven days`, /Harbor Kitchen/.test(words.sent("Harbor Kitchen")) && /7/.test(words.sent("Harbor Kitchen")), true);
    is(`${code}: no square brackets or template marks`, [...ORDER_PROBLEM_KEYS.map((key) => String(words[key])), ...Object.values(words.reasons), words.sent("X")].join("\n").match(/[[\]{}⟦⟧]|TODO/g), null);
    if (code !== "en") is(`${code}: not the English button`, words.button === orderProblemWords("en").button, false);
  }
  is("English button", orderProblemWords("en").button, "Report a problem with this order");
  is("an unknown language falls back to English", orderProblemWords("xx").button, "Report a problem with this order");

  done();
}

main();
