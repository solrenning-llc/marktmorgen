/** Review evidence only: a planned release does not prove actual supply. */
import { submittedInTime, withdrawalWindow, type WithdrawalFacts } from "@/lib/withdrawal-rules";
import { done, is, part } from "./check";

const paid = Date.UTC(2026, 10, 1, 12) / 1000;
const now = Date.UTC(2026, 10, 7, 12) / 1000;
// Paid Sunday November 1 at 12:00 UTC, already Monday November 2 at UTC+14 (the latest calendar day anywhere): day 14 is
// Monday November 16, open to its end anywhere on Earth (11:59:59 UTC on November 17; lib/withdrawal-rules.ts,
// withdrawalEnd, Claude 5 on #2827 and its focal return). Counted here by hand.
const end = Date.UTC(2026, 10, 17, 11, 59, 59) / 1000;
const facts: WithdrawalFacts = {
  kind: "sale", paidAt: paid, member: false, givenByStore: false,
  consent: { version: "2026-10-30.2", at: paid, kind: "digital" },
  preorder: { day: "2026-11-06", given: false },
};

part("A pre-order remains undelivered after its planned release, inside fourteen days");
const pending = withdrawalWindow(facts, now);
is("the function remains available while supply has not begun", pending, { open: true, until: end });
is("the buyer can submit during that remaining period", submittedInTime(pending, now), true);

part("Controls: the actual supply evidence and ordinary deadline still matter");
is("confirmed supply closes the digital-content right", withdrawalWindow({ ...facts, preorder: { ...facts.preorder!, given: true }, confirmed: true }, now), { open: false, why: "supplied" });
is("no consent keeps the ordinary fourteen-day deadline", withdrawalWindow({ ...facts, consent: null }, now), { open: true, until: end });
is("an unsupplied pre-order still closes after the ordinary deadline", withdrawalWindow(facts, end + 1), { open: false, why: "ended" });
done();
