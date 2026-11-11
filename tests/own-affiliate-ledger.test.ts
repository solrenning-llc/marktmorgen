/**
 * The balance of one affiliate of Marktmorgen's own programme (220 [HL1],
 * unit 4): a commission held until it is due, gone on a refund or dispute,
 * and one already paid and then reversed taken from the next ones, never
 * charged to the affiliate. Unreadable is unknown (rule 24). Pure, synthetic.
 */
import { affiliateBalance } from "@/lib/own-affiliate-ledger";
import { done, is, part } from "./check";

const now = 1_800_000_000;
const DAY = 86_400;
const earned = (paymentId: string, cents: number, dueAt = now - DAY) => ({ kind: "earned" as const, paymentId, cents, dueAt });
const reversed = (paymentId: string) => ({ kind: "reversed" as const, paymentId });
const paid = (cents: number) => ({ kind: "paid" as const, cents });

part("Held, then payable");
is("nothing yet: nothing", affiliateBalance([], now), { payableCents: 0, heldCents: 0, debtCents: 0 });
is("a commission not yet due is held", affiliateBalance([earned("p1", 1_000, now + DAY)], now), { payableCents: 0, heldCents: 1_000, debtCents: 0 });
is("a commission due is payable", affiliateBalance([earned("p1", 1_000)], now), { payableCents: 1_000, heldCents: 0, debtCents: 0 });
is("what was paid is no longer payable", affiliateBalance([earned("p1", 1_000), earned("p2", 500), paid(1_000)], now), { payableCents: 500, heldCents: 0, debtCents: 0 });

part("Refunds and disputes");
is("reversed before it was paid: simply gone", affiliateBalance([earned("p1", 1_000), reversed("p1")], now), { payableCents: 0, heldCents: 0, debtCents: 0 });
is("reversed while held: gone from the held", affiliateBalance([earned("p1", 1_000, now + DAY), reversed("p1")], now), { payableCents: 0, heldCents: 0, debtCents: 0 });
is("a reversal read before its commission still counts", affiliateBalance([reversed("p1"), earned("p1", 1_000)], now), { payableCents: 0, heldCents: 0, debtCents: 0 });
is("reversed after it was paid: a debt, never charged, taken from the next ones", affiliateBalance([earned("p1", 1_000), paid(1_000), reversed("p1")], now), { payableCents: 0, heldCents: 0, debtCents: 1_000 });
is("the next commission pays the debt first", affiliateBalance([earned("p1", 1_000), paid(1_000), reversed("p1"), earned("p2", 1_500)], now), { payableCents: 500, heldCents: 0, debtCents: 0 });
is("a held commission does not pay a debt before it is due", affiliateBalance([earned("p1", 1_000), paid(1_000), reversed("p1"), earned("p2", 1_500, now + DAY)], now), { payableCents: 0, heldCents: 1_500, debtCents: 1_000 });

part("Each payment once");
is("a commission recorded twice counts once", affiliateBalance([earned("p1", 1_000), earned("p1", 1_000)], now), { payableCents: 1_000, heldCents: 0, debtCents: 0 });
is("the same payment with two amounts is unknown", affiliateBalance([earned("p1", 1_000), earned("p1", 900)], now), "unknown");

part("Unreadable is unknown, never zero (rule 24)");
for (const [what, entry] of [
  ["cents not whole", earned("p1", 10.5)],
  ["negative cents", earned("p1", -1)],
  ["no payment id", earned("", 1_000)],
  ["a due time that is not a number", earned("p1", 1_000, Number.NaN)],
  ["a payout not whole", paid(1.5)],
  ["a kind not known", { kind: "bonus", cents: 1 }],
  ["no entry at all", null],
] as const) {
  is(`${what}: unknown`, affiliateBalance([entry as never], now), "unknown");
}
is("the ledger itself unknown: unknown", affiliateBalance("unknown", now), "unknown");
is("a time now that is not a number: unknown", affiliateBalance([earned("p1", 1)], Number.NaN), "unknown");

done();
