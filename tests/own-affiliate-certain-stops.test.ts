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

done();
