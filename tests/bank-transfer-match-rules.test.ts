/**
 * 438 [FC1] (b), unit 1: matching a bank transfer received by the LLC to the
 * invoice it pays, as pure rules (lib/bank-transfer-match-rules.ts). Each
 * invoice has its own reference; only the whole amount, in the right
 * currency, starts the period; less stays as credit until it is whole; more
 * is never lost; anything without a reference, with another invoice's or an
 * unknown one, in another currency or unreadable goes to review with no
 * personal data; the same receipt never counts twice. Off: nothing here
 * reads a bank, opens an account or charges anybody.
 */
import { isTransferReference, matchReceipt, newTransferReference, reviewLine, type OpenInvoice } from "@/lib/bank-transfer-match-rules";
import { done, is, part } from "./check";

const invoice = (reference: string, amountCents: number, creditCents = 0): OpenInvoice => ({ reference, currency: "usd", amountCents, creditCents });
const open = new Map([["MM-7K4QX9TP2W", invoice("MM-7K4QX9TP2W", 6900)], ["MM-3HDN8RZ5BV", invoice("MM-3HDN8RZ5BV", 69000, 40000)]]);
const receipt = (id: string, reference: unknown, amountCents: unknown, currency: unknown = "usd") => ({ id, reference, amountCents, currency });

part("A reference is one of ours, exactly");
is("ours", isTransferReference("MM-7K4QX9TP2W"), true);
for (const bad of ["mm-7k4qx9tp2w", "MM-7K4QX9TP2", "MM-7K4QX9TP2WX", "MM-7K4QX9TP2O", "INV 7K4QX9TP2W", "", null, 7]) is(`not: ${JSON.stringify(bad)}`, isTransferReference(bad), false);

part("A new reference is one of ours, and different each time");
const made = Array.from({ length: 200 }, () => newTransferReference());
is("every one reads as ours", made.every(isTransferReference), true);
is("no two the same in 200", new Set(made).size, 200);

part("The whole amount in the right currency starts the period");
is("exact", matchReceipt(receipt("r1", "MM-7K4QX9TP2W", 6900), open, new Set()), { kind: "paid", reference: "MM-7K4QX9TP2W", creditCents: 6900, overCents: 0 });
is("the reference found inside the bank's memo line", matchReceipt(receipt("r2", "Payment ref MM-7K4QX9TP2W thanks", 6900), open, new Set()).kind, "paid");
is("credit from before completes it", matchReceipt(receipt("r3", "MM-3HDN8RZ5BV", 29000), open, new Set()), { kind: "paid", reference: "MM-3HDN8RZ5BV", creditCents: 69000, overCents: 0 });

part("Less stays as credit, never starts the period");
is("short", matchReceipt(receipt("r4", "MM-7K4QX9TP2W", 5000), open, new Set()), { kind: "partial", reference: "MM-7K4QX9TP2W", creditCents: 5000, shortCents: 1900 });

part("More is never lost: paid, and the rest kept for review");
is("over", matchReceipt(receipt("r5", "MM-7K4QX9TP2W", 7000), open, new Set()), { kind: "paid", reference: "MM-7K4QX9TP2W", creditCents: 6900, overCents: 100 });

part("Anything in doubt goes to review and starts nothing");
is("no reference", matchReceipt(receipt("r6", "", 6900), open, new Set()), { kind: "review", reason: "no_reference" });
is("a reference that is not an open invoice", matchReceipt(receipt("r7", "MM-ZZZZZZZZZZ", 6900), open, new Set()), { kind: "review", reason: "unknown_reference" });
is("two references in one memo", matchReceipt(receipt("r8", "MM-7K4QX9TP2W MM-3HDN8RZ5BV", 6900), open, new Set()), { kind: "review", reason: "two_references" });
is("another currency", matchReceipt(receipt("r9", "MM-7K4QX9TP2W", 6900, "eur"), open, new Set()), { kind: "review", reason: "currency" });
for (const bad of [0, -100, 69.5, "6900", null]) is(`an amount that is not one: ${JSON.stringify(bad)}`, matchReceipt(receipt("r10", "MM-7K4QX9TP2W", bad), open, new Set()), { kind: "review", reason: "amount" });
is("a receipt with no id of its own", matchReceipt(receipt("", "MM-7K4QX9TP2W", 6900), open, new Set()), { kind: "review", reason: "receipt" });

part("The same receipt never counts twice");
is("seen before", matchReceipt(receipt("r1", "MM-7K4QX9TP2W", 6900), open, new Set(["r1"])), { kind: "duplicate" });

part("The review line carries no personal data");
const line = reviewLine(receipt("r11", "From Jane Doe jane@example.com acct 123456789", 6900), "no_reference");
is("the receipt's id, the amount and the reason only", line, { receipt: "r11", amountCents: 6900, currency: "usd", reason: "no_reference" });
done();
