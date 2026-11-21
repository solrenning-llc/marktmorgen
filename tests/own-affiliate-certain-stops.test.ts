/**
 * Review of #3853: a dispute, a full refund or a failed payment stops the commission whatever the self-referral
 * signals say, so a commission already paid out is taken back even while one signal is unknown (for example a
 * customer with no billing address, which leaves sameAddress null). Only a payment that could still earn waits on
 * the signals.
 */
import { ownCommission } from "@/lib/own-affiliate-rules";
import { done, is } from "./check";

const unknownAddress = { samePerson: false, sameCard: false, sameDevice: false, sameAddress: null };
const base = { programmeOn: true, rateBps: 2000, succeeded: true, amountCents: 10_000, refundedCents: 0, disputed: false, paidAtSeconds: 0, nowSeconds: 10_000_000, paidOutCents: 500, referral: unknownAddress };
is("disputed, one signal unknown: what was paid out is taken back", ownCommission({ ...base, disputed: true }), { kind: "take_back", takeBackCents: 500 });
is("refunded in full, one signal unknown: taken back", ownCommission({ ...base, refundedCents: 10_000 }), { kind: "take_back", takeBackCents: 500 });
is("disputed, nothing paid out, one signal unknown: none", ownCommission({ ...base, disputed: true, paidOutCents: 0 }), { kind: "none", reason: "disputed" });
is("a payment that could still earn waits on the unknown signal", ownCommission(base), { kind: "unknown", reason: "referral_unknown" });

// Claude 2 H's MEDIUM 1 on #3853 (E8): after a partial refund, what was paid out above what the kept part could still
// earn is no longer owed whatever the unknown signal turns out to be, so it is taken back now (at least that much).
const halfBack = { ...base, refundedCents: 5_000, paidOutCents: 2_000 };
is("a partial refund after a payout, one signal unknown: the part no longer owed is taken back", ownCommission(halfBack), { kind: "take_back", takeBackCents: 1_000 });
is("the same with every signal read as different (control)", ownCommission({ ...halfBack, referral: { ...unknownAddress, sameAddress: false } }), { kind: "take_back", takeBackCents: 1_000 });
is("a partial refund still within what was paid out, one signal unknown: still unknown", ownCommission({ ...halfBack, paidOutCents: 1_000 }), { kind: "unknown", reason: "referral_unknown" });

// Codex G's MEDIUM 2 on #3853 (E18, E19): a read that did not give a boolean is unreadable, never "paid" or "not disputed".
const clean = { ...base, paidOutCents: 0, referral: { ...unknownAddress, sameAddress: false } };
is("disputed null on a clean sale: unreadable, never owed", ownCommission({ ...clean, disputed: null as unknown as boolean }), { kind: "unknown", reason: "unreadable" });
is("succeeded undefined with a payout: unreadable, never a take-back on a guess", ownCommission({ ...clean, paidOutCents: 690, succeeded: undefined as unknown as boolean }), { kind: "unknown", reason: "unreadable" });
is("succeeded as the text \"true\": unreadable", ownCommission({ ...clean, succeeded: "true" as unknown as boolean }), { kind: "unknown", reason: "unreadable" });

done();
