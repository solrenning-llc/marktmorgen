/** Review evidence only: a planned release does not prove actual supply. */
import { submittedInTime, withdrawalWindow, type WithdrawalFacts } from "@/lib/withdrawal-rules";
import { done, is, part } from "./check";

const DAY = 86_400;
const paid = Date.UTC(2026, 10, 1, 12) / 1000;
const now = Date.UTC(2026, 10, 7, 12) / 1000;
const facts: WithdrawalFacts = {
  kind: "sale", paidAt: paid, member: false, givenByStore: false,
  consent: { version: "2026-10-30.2", at: paid, kind: "digital" },
  preorder: { day: "2026-11-06", given: false },
};

part("A pre-order remains undelivered after its planned release, inside fourteen days");
const pending = withdrawalWindow(facts, now);
is("the function remains available while supply has not begun", pending, { open: true, until: paid + 14 * DAY });
is("the buyer can submit during that remaining period", submittedInTime(pending, now), true);

part("Controls: the actual supply evidence and ordinary deadline still matter");
is("confirmed supply closes the digital-content right", withdrawalWindow({ ...facts, preorder: { ...facts.preorder!, given: true } }, now), { open: false, why: "supplied" });
is("no consent keeps the ordinary fourteen-day deadline", withdrawalWindow({ ...facts, consent: null }, now), { open: true, until: paid + 14 * DAY });
is("an unsupplied pre-order still closes after the ordinary deadline", withdrawalWindow(facts, paid + 14 * DAY + 1), { open: false, why: "ended" });
done();
