import type { NextRequest } from "next/server";
import { checkMemberEdit } from "@/lib/member-price-edit";
import { memberEditChoices } from "@/lib/member-price-choices";
import { setMemberPrices } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";

/**
 * Member and past-buyer prices (620 [SZ4], lib/member-price-rules.ts), from
 * the studio: `{ on, rules: [{ id, percent, by, all, products }] }`, the
 * whole setting at once. Prices are the "settings" permission, as a sale and
 * fair prices are.
 *
 * Checked against what the store sells now (lib/member-price-edit.ts,
 * checkMemberEdit): saved exactly as sent, or refused with the field to fix
 * and nothing changed. Switched on only with the store's Stripe connected.
 * These are the creator's own prices on their own Stripe account.
 */
const SERVER_ERROR = "It could not be saved just now. Nothing was changed. Try again in a moment.";

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 24_000);
  if (!guarded.ok) return guarded.response;
  try {
    const checked = checkMemberEdit(guarded.body, await memberEditChoices(guarded.store), Boolean(guarded.store.stripeAccountId));
    if (!checked.ok) {
      return Response.json({ ok: false, error: checked.error, field: checked.field, rule: checked.rule, message: checked.message }, { status: 400 });
    }
    const store = await setMemberPrices(guarded.ref, checked.value);
    if (!store) return Response.json({ ok: false, error: "none", message: "This store is no longer available to you. Reload to see your stores." }, { status: 400 });
    return Response.json({ ok: true, memberPrices: store.memberPrices });
  } catch (error) {
    console.error("saving member prices failed", error);
    return Response.json({ ok: false, error: "server_error", message: SERVER_ERROR }, { status: 500 });
  }
}
