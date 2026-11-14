/**
 * MÉDIO of Codex P's review of claude2/fix-4479-batch-matches-file (relatorios-codex/P-20261113-2039-review-branch-
 * 4479.md), which this branch shares: the batch id signed only each line's affiliate id and amount. An affiliate who
 * changed their PayPal address between the download and the confirmation kept the same id, so the batch was written
 * down as paid although the file paid the old address. The id now covers the address each line pays.
 */
import type { Affiliate } from "@/lib/affiliates";
import { batchId, type BatchLine } from "@/lib/affiliate-payouts";
import { done, is, part } from "./check";

const affiliate = (paypal: string, email = "ana@example.test") => ({ id: "aff0001", email, paypal } as unknown as Affiliate);
const line = (a: Affiliate, cents: number) => ({ affiliate: a, cents } as unknown as BatchLine);

part("The batch id covers the address each line pays");
const before = batchId([line(affiliate("old@example.test"), 1500)]);
is("a new PayPal address, same affiliate and amount: another batch", batchId([line(affiliate("new@example.test"), 1500)]) === before, false);
is("no PayPal address: the email it pays instead counts too", batchId([line(affiliate("", "a@example.test"), 1500)]) === batchId([line(affiliate("", "b@example.test"), 1500)]), false);
is("the same lines in another order: the same batch", batchId([line(affiliate("x@example.test"), 1), line({ ...affiliate("y@example.test"), id: "aff0002" } as unknown as Affiliate, 2)]) === batchId([line({ ...affiliate("y@example.test"), id: "aff0002" } as unknown as Affiliate, 2), line(affiliate("x@example.test"), 1)]), true);
is("controls: the same address and amount, the same batch; another amount, another batch", [batchId([line(affiliate("old@example.test"), 1500)]) === before, batchId([line(affiliate("old@example.test"), 1600)]) === before], [true, false]);
done();
