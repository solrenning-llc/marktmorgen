/**
 * An affiliate's months on a membership, read only in the shape every writer
 * sets them (CX-123 rule 24, unknown is never zero). lib/store-checkout.ts
 * writes `via_months` (a whole number from 1) and `via_at` (whole seconds)
 * beside `via` on every membership it credits, so a value in any other shape
 * on a membership that carries `via` is unknown: the yearly price is then not
 * offered (lib/yearly-switch-rules.ts, affiliateMonthsLeft), as when the share
 * is known to still run, never offered as if no share ran.
 */
import { affiliateMonthsLeft } from "@/lib/yearly-switch-rules";
import { done, is, part } from "./check";

const NOW = 1_790_000_000;
const DAY = 86_400;
const meta = (fields: Record<string, string>) => ({ store: "harbor", product: "club", via: "0123456789ab", via_rate: "30", ...fields });

part("Months that do not read: unknown, never offered");
is(
  "via_months missing, empty, text, a fraction, negative, zero or with a sign, on a membership with an affiliate",
  [
    affiliateMonthsLeft(meta({ via_at: String(NOW - 10 * DAY) }), NOW),
    affiliateMonthsLeft(meta({ via_months: "", via_at: String(NOW - 10 * DAY) }), NOW),
    affiliateMonthsLeft(meta({ via_months: "three", via_at: String(NOW - 10 * DAY) }), NOW),
    affiliateMonthsLeft(meta({ via_months: "2.5", via_at: String(NOW - 10 * DAY) }), NOW),
    affiliateMonthsLeft(meta({ via_months: "-3", via_at: String(NOW - 10 * DAY) }), NOW),
    affiliateMonthsLeft(meta({ via_months: "0", via_at: String(NOW - 10 * DAY) }), NOW),
    affiliateMonthsLeft(meta({ via_months: "+3", via_at: String(NOW - 10 * DAY) }), NOW),
  ],
  [true, true, true, true, true, true, true],
);

part("A sale date that does not read: unknown, never offered");
is(
  "via_at negative, a fraction or text, with months that read",
  [
    affiliateMonthsLeft(meta({ via_months: "3", via_at: "-100" }), NOW),
    affiliateMonthsLeft(meta({ via_months: "3", via_at: "1.5" }), NOW),
    affiliateMonthsLeft(meta({ via_months: "3", via_at: "soon" }), NOW),
  ],
  [true, true, true],
);

part("What reads is unchanged");
is(
  "3 months still running; 3 months run out; for as long as they pay; no affiliate at all",
  [
    affiliateMonthsLeft(meta({ via_months: "3", via_at: String(NOW - 40 * DAY) }), NOW),
    affiliateMonthsLeft(meta({ via_months: "3", via_at: String(NOW - 120 * DAY) }), NOW),
    affiliateMonthsLeft(meta({ via_months: "1200", via_at: String(NOW - 40 * DAY) }), NOW),
    affiliateMonthsLeft({}, NOW),
    affiliateMonthsLeft(null, NOW),
  ],
  [true, false, false, false, false],
);

done();
