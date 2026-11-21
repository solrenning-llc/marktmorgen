import { previewKnown } from "@/lib/tier-switch";
import { dueNow } from "@/lib/tier-rules";
import { is, done } from "./check";

const at = 1_800_000_000;
const invoice = (amount: number) => ({ currency: "usd", starting_balance: 0,
  lines: { object: "list", has_more: false, data: [{ amount, proration: true, period: { start: at } }] } });
for (const amount of [0, -500, 1240]) {
  const value = invoice(amount);
  is(`known complete preview retains ${amount} cents`, [previewKnown(value), dueNow(value, at)], [true, amount]);
}
is("unsafe cents remain unknown", previewKnown(invoice(Number.MAX_SAFE_INTEGER + 1)), false);
done();
