/**
 * Mutation testing of lib/affiliate-payouts.ts (Claude 7, 13/11/2026): each
 * case kills a mutant that survived every test importing the module. The
 * batch of commissions owed lists the largest first, its total is the sum of
 * its lines, and each provider gets its own file.
 */
import { batchFile, batchTotal, owedLines, type BatchLine } from "@/lib/affiliate-payouts";
import type { Affiliate, Book } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

const affiliate = (id: string, status = "approved") => ({ id, status, email: `${id}@example.com`, paypal: "", code: id.toUpperCase() }) as unknown as Affiliate;
const book = (rows: [string, number][]) => ({ rows: rows.map(([id, payable]) => ({ affiliate: affiliate(id), payable })), lines: [], payouts: [], currency: "usd", elsewhere: 0 }) as unknown as Book;
const store = { handle: "mutants", name: "Mutants", currency: "usd" } as unknown as Store;

part("The commissions owed");
const lines = owedLines(book([["ann", 300], ["bob", 1200], ["cy", 700]]));
is("largest first", lines.map((l) => [l.affiliate.id, l.cents]), [["bob", 1200], ["cy", 700], ["ann", 300]]);
is("the batch total is the sum of its lines", batchTotal(lines), 2200);
is("an empty batch totals zero", batchTotal([] as BatchLine[]), 0);

part("One file per provider");
const paypal = batchFile("paypal", lines, store, "2026-11-13");
const sheet = batchFile("worksheet" as Parameters<typeof batchFile>[0], lines, store, "2026-11-13");
is("PayPal's file name", paypal.filename, "paypal-payouts-mutants-2026-11-13.csv");
is("PayPal's file has no header and ends each row with PAYPAL", paypal.body.split("\r\n")[0].endsWith(",PAYPAL"), true);
is("the worksheet's file name", sheet.filename, "affiliate-payouts-mutants-2026-11-13.csv");
is("the worksheet starts with its header", sheet.body.split("\r\n")[0].startsWith(`"name","email","amount"`), true);

done();
