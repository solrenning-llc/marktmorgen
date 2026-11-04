/**
 * A new discount code as it is asked for, read the same way wherever it is
 * asked: the studio (app/api/store/discount) and the API (app/api/v1/codes,
 * 630 [HN6](19)). The code's word, what it takes off (a percent from 1 to
 * 100, or an amount in the store's currency within its price range), how
 * many times it may be used, and the smallest order it comes off. Nothing is
 * created here; lib/discount.ts makes it on the creator's own Stripe account.
 */
import { type CodeMinimum, type CodeProblem, type Off, codeProblem, readCode } from "@/lib/discount";
import { type Currency, priceInRange, readMoney } from "@/lib/money";

export type CodeAsked = { code: string; off: Off; maxRedemptions: number | null; minimum: CodeMinimum | null };
export type CodeAskedRefusal = { reason: CodeProblem | "amount" | "percent" | "uses" | "minimum" };

const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : typeof value === "number" && Number.isFinite(value) ? String(value).slice(0, max) : "");

/** The code asked for, or what is wrong with it. */
export function readCodeAsked(body: Record<string, unknown>, currency: Currency): { ok: true; asked: CodeAsked } | ({ ok: false } & CodeAskedRefusal) {
  const code = readCode(text(body.code, 40));
  const problem = codeProblem(code);
  if (problem) return { ok: false, reason: problem };

  let off: Off;
  if (text(body.kind, 10) === "amount") {
    // In the store's currency, and within its price range (lib/money.ts).
    const cents = readMoney(text(body.amount, 20), currency);
    if (cents === null || !priceInRange(cents, currency)) return { ok: false, reason: "amount" };
    off = { kind: "amount", cents, currency };
  } else {
    const percent = Number(text(body.percent, 10));
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) return { ok: false, reason: "percent" };
    off = { kind: "percent", percent };
  }

  const rawUses = text(body.uses, 10);
  let maxRedemptions: number | null = null;
  if (rawUses) {
    const uses = Number(rawUses);
    if (!Number.isInteger(uses) || uses < 1) return { ok: false, reason: "uses" };
    maxRedemptions = uses;
  }

  // The smallest order it comes off (554 [DS1]): optional, in the store's
  // currency and within its price range, checked by Stripe at checkout.
  const rawMinimum = text(body.minimum, 20);
  let minimum: CodeMinimum | null = null;
  if (rawMinimum) {
    const cents = readMoney(rawMinimum, currency);
    if (cents === null || !priceInRange(cents, currency)) return { ok: false, reason: "minimum" };
    minimum = { cents, currency };
  }
  return { ok: true, asked: { code, off, maxRedemptions, minimum } };
}
