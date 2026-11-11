import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { MAX_BENEFITS_KEPT, MAX_BENEFITS_PER_TIER, MAX_BENEFIT_TEXT, MAX_GIVE_AT_ONCE } from "@/lib/tier-benefit-rules";
import { addBenefit, giveBenefit, retireBenefit, undoGiven } from "@/lib/tier-benefits";

/**
 * Benefits handed over by hand on a membership (422 [PT2], lib/tier-benefits.ts):
 *
 *   { action: "add", product, text, cadence }      a benefit on one membership ("settings")
 *   { action: "retire", benefit }                  owed no more from now on ("settings")
 *   { action: "give", benefit, items: [{ sub, period }] }   marked given, at most MAX_GIVE_AT_ONCE ("orders")
 *   { action: "undo", benefit, sub, period }       one mark taken back ("orders")
 *
 * Who is owed what is read again from the creator's Stripe on every press;
 * nothing the page sends is trusted but the choice. Marking is the creator's
 * own record: nothing is sent, charged or shipped.
 */
const need = (body: Record<string, unknown>) => (body.action === "add" || body.action === "retire" ? "settings" : body.action === "give" || body.action === "undo" ? "orders" : null);

export async function POST(request: NextRequest) {
  // A press of MAX_GIVE_AT_ONCE rows, each a benefit id, a subscription id and a period.
  const guarded = await guardStoreWrite(request, need, 24_000);
  if (!guarded.ok) return guarded.response;
  const { body, store, email } = guarded;
  const refuse = (error: string, message: string, status = 400) => Response.json({ ok: false, error, message }, { status });
  const unread = "Your Stripe account could not be read just now, so nothing was changed. Try again in a minute.";
  const benefitsUnread = "Your benefits could not be read just now, so nothing was changed. Try again in a minute.";

  if (body.action === "add") {
    const done = await addBenefit(store, { product: body.product, text: body.text, cadence: body.cadence });
    if (done.ok) return Response.json({ ok: true, benefit: done.benefit });
    const words: Record<typeof done.reason, string> = {
      product: "Choose one of your memberships.",
      text: `Describe the benefit in 1 to ${MAX_BENEFIT_TEXT} characters.`,
      cadence: "Choose once or every month.",
      full_tier: `A membership can have ${MAX_BENEFITS_PER_TIER} benefits at a time. Retire one to add another.`,
      full_store: `Your store keeps ${MAX_BENEFITS_KEPT} benefits, retired ones included, because they stay owed for what came before.`,
      unknown: benefitsUnread,
    };
    return refuse(done.reason, words[done.reason], done.reason === "unknown" ? 502 : 400);
  }
  if (body.action === "retire") {
    const done = await retireBenefit(store, body.benefit);
    if (done.ok) return Response.json({ ok: true });
    return done.reason === "missing" ? refuse("missing", "That benefit is not one of yours. Reload the page.", 409) : refuse("unknown", benefitsUnread, 502);
  }
  if (body.action === "give") {
    const done = await giveBenefit(store, email, body.benefit, body.items);
    if (done.ok) return Response.json(done);
    const words: Record<typeof done.reason, [string, number]> = {
      too_many: [`Mark at most ${MAX_GIVE_AT_ONCE} at a time.`, 400],
      missing: ["That benefit is not one of yours. Reload the page.", 409],
      benefits: [benefitsUnread, 502],
      stripe: [unread, 502],
      full: [done.message ?? "Your store's data room is full, so nothing was marked.", 409],
      room: ["Your store's data room could not be counted just now, so nothing was marked. Try again in a minute.", 502],
      unknown: ["Nothing was marked just now. Try again in a minute.", 502],
    };
    return refuse(done.reason, words[done.reason][0], words[done.reason][1]);
  }
  if (body.action === "undo") {
    const done = await undoGiven(store, body.benefit, body.sub, body.period);
    if (done.ok) return Response.json(done);
    const words: Record<typeof done.reason, [string, number]> = {
      missing: ["That benefit is not one of yours. Reload the page.", 409],
      not_owed: ["That member is not owed this benefit right now, so there is nothing to take back here. Reload the page.", 409],
      benefits: [benefitsUnread, 502],
      stripe: [unread, 502],
      unknown: ["The mark could not be taken back just now. Try again in a minute.", 502],
    };
    return refuse(done.reason, words[done.reason][0], words[done.reason][1]);
  }
  return refuse("invalid", "That is not something this page can do.");
}
