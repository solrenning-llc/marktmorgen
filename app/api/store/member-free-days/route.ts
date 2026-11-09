import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { freeDaysSubs, giveFreeDays, type GiveResult } from "@/lib/member-free-days";
import { BLOCK_WORDS, FREE_DAYS_MAX } from "@/lib/member-free-days-rules";

/**
 * Free days on one member's running membership (641 [WG1],
 * lib/member-free-days.ts), for a role that may touch payments: it puts off
 * what the member pays, so it is the owner's (lib/team-roles.ts).
 *
 *   { action: "find", email }                                  the member's running memberships here, with each next charge
 *   { action: "give", email, subscription, days, expected }    the next charge `expected` moved `days` later
 *
 * Everything is read again from the creator's Stripe on "give"; nothing the
 * page sends is trusted but the choice and the date it was shown.
 */
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "payments");
  if (!guarded.ok) return guarded.response;
  const { body, store, email: who, role } = guarded;
  const refuse = (error: string, message: string, status = 400) => Response.json({ ok: false, error, message }, { status });
  if (!store.stripeAccountId) return refuse("no_stripe", "Connect your Stripe account first: memberships are kept there.");
  const raw = text(body.email, 320).trim();
  if (!EMAIL.test(raw)) return refuse("email", "Type the address the member pays with.");
  // The address as the creator typed it: Stripe keeps a member's with their capitals, and its filter is case-sensitive.
  const action = text(body.action, 10);

  if (action === "find") {
    const subs = await freeDaysSubs(store, raw);
    if (subs === null) return refuse("stripe", "Your Stripe account could not be read just now. Try again in a minute.", 502);
    return Response.json({ ok: true, memberships: subs });
  }
  if (action === "give") {
    const done = await giveFreeDays(store, raw, text(body.subscription, 80), body.days, body.expected, { who, role });
    if (done.ok) return Response.json({ ok: true, nextCharge: done.nextCharge, emailed: done.emailed });
    const words: Record<Exclude<GiveResult, { ok: true }>["reason"], [string, number]> = {
      days: [`Type a whole number of days from 1 to ${FREE_DAYS_MAX}.`, 400],
      not_member: ["That membership is not a running one of this member at your store. Find the member again.", 409],
      blocked: ["That membership's next charge cannot be moved. Find the member again to see why.", 409],
      changed: ["That membership's next charge is not the date you were shown any more, so nothing was added. Find the member again to see the date it has now.", 409],
      busy: ["Free days on that membership are already being given. Find the member again in a moment to see its next charge.", 409],
      refused: ["Stripe did not accept the change, so nothing was changed.", 409],
      unknown: ["Stripe's answer could not be read, so this is not shown as done and the member was not emailed. Find the member again to see the next charge Stripe has before you try again.", 502],
      stripe: ["Your Stripe account could not be reached just now, so nothing was changed. Try again in a minute.", 502],
    };
    const message = done.reason === "blocked" ? `That membership is ${BLOCK_WORDS[done.blocked]}. Nothing was changed.` : words[done.reason][0];
    return refuse(done.reason, message, words[done.reason][1]);
  }
  return refuse("invalid", "That is not something this page can do.");
}
