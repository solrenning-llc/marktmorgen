/**
 * Add-ons on a booking (637 [GL5], unit 7a; added 4 November 2026): the
 * rules, browser-safe. A creator's call may offer up to MAX_BUMPS of their
 * own products beside the time, each in a box the buyer checks before paying,
 * at a price of the creator's choosing (extra material, a workbook, a
 * recording). The booking page, the checkout's lines and the delivery are
 * the next units; nothing here is offered, charged or delivered yet.
 *
 * The same thing as an order bump on a one-off product (lib/product-extras.ts),
 * so the same rules decide what can be added, read from the same record
 * (`bumps`): one price and one delivery (bumpTargetPause), never the call
 * itself, never dearer than buying it on its own, never checked for the buyer.
 * Only the host differs: a paid call, with its own reasons an add-on is not
 * offered on it, each said to the creator by name (CallAddOnPause):
 *
 *   - A session from a package pays nothing here, so nothing is added to it.
 *   - A deposit paid online for a call in person charges part of the price
 *     now and the rest in person; an add-on would mix two payments in one
 *     line, so none is offered until the deposit is tied to it.
 *   - A recurring series is charged session by session (lib/call-series-
 *     billing.ts); an add-on is one payment, so none is offered on a series.
 *   - A move charges nothing, so nothing is offered when a booking moves.
 *   - Buyers who name their own price, or several prices, are already refused
 *     for every call (lib/store.ts, setProductCall).
 *
 * Cancellation (callAddOnRefund): an add-on is delivered as soon as the
 * booking is paid, with the buyer's consent to start access at once
 * (lib/digital-consent.ts), so it is theirs to keep when they cancel the
 * call themselves: only the call is refunded, under the creator's own
 * deadline. When the creator cancels, or the store cannot hold the time
 * (a refused or lost booking), the buyer chose the add-on for a call that
 * did not happen, so it is refunded with the call. Both are said before
 * paying (callAddOnKeepWords), from the sale's own cancellation promise
 * (lib/call-setup.ts, readCancelPromise): a refund is promised only where
 * the creator set a deadline and it has not passed, never on a call without
 * one, where canceling is between the buyer and the creator.
 */
import type { CancelPromise } from "@/lib/call-setup";
import type { Listing } from "@/lib/store";
import { type Bump, type BumpPause, MAX_BUMPS, bumpTargetPause } from "@/lib/product-extras";

/** Why an add-on set on a call is not offered right now, or a reason of the boxes'. */
export type CallAddOnPause =
  /** This product is not a paid call any more. */
  | "notCall"
  /** A session from a package pays nothing here. */
  | "package"
  /** A deposit is paid online and the rest in person. */
  | "deposit"
  /** A recurring series is charged session by session. */
  | "series"
  /** A booking that moves charges nothing. */
  | "move"
  | Exclude<BumpPause, "kind" | "pwyw">;

/** How a booking is being made: what decides whether add-ons are offered on it at all. */
export type CallAddOnContext = {
  /** A session paid by a package (lib/call-packages.ts). */
  fromPackage: boolean;
  /** A deposit is charged now and the rest in person (lib/call-deposit.ts, chargeNow). */
  deposit: boolean;
  /** One booking of a recurring series (lib/call-series-rules.ts). */
  series: boolean;
  /** An existing booking moving to another time. */
  move: boolean;
};

/** Whether the host is a paid call that may carry add-ons at all. */
function isPaidCall(product: Listing): boolean {
  return product.call !== null && product.priceCents > 0 && product.recurring === null && product.options.length === 0 && !product.pwyw;
}

/** Why no add-on is offered on this booking at all, or null when they may be. */
export function callAddOnsClosed(product: Listing, context: CallAddOnContext): CallAddOnPause | null {
  if (!isPaidCall(product)) return "notCall";
  if (context.move) return "move";
  if (context.fromPackage) return "package";
  if (context.series) return "series";
  if (context.deposit) return "deposit";
  return null;
}

/** One add-on as it stands on a call: offered, with the product it adds, or paused with its reason. */
export type CallAddOnState = { bump: Bump; target: Listing } | { paused: CallAddOnPause; bump: Bump };

/**
 * One add-on set on a call, against the store's products now: the same
 * reasons a box on a one-off product is paused for (bumpState), read for a
 * call host.
 */
export function callAddOnState(products: readonly Listing[], product: Listing, bump: Bump, context: CallAddOnContext): CallAddOnState {
  const closed = callAddOnsClosed(product, context);
  if (closed) return { paused: closed, bump };
  const target = products.find((p) => p.id === bump.productId);
  if (!target) return { paused: "gone", bump };
  if (target.id === product.id) return { paused: "itself", bump };
  // A target's reasons only (bumpTargetPause never answers "kind" or "pwyw", which are about the host).
  const wrong = bumpTargetPause(target) as Exclude<BumpPause, "kind" | "pwyw"> | null;
  if (wrong) return { paused: wrong, bump };
  // Never dearer than buying it on its own.
  if (bump.priceCents > target.priceCents) return { paused: "dearer", bump };
  return { bump, target };
}

/** The add-ons a buyer may be offered on this booking right now, in the creator's order, at most MAX_BUMPS. */
export function activeCallAddOns(products: readonly Listing[], product: Listing, context: CallAddOnContext): { bump: Bump; target: Listing }[] {
  return product.bumps
    .slice(0, MAX_BUMPS)
    .map((bump) => callAddOnState(products, product, bump, context))
    .filter((state): state is { bump: Bump; target: Listing } => "target" in state);
}

/** One add-on the buyer checked: the product added and what it costs this way, both from the creator's record. */
export type CallAddOnLine = { productId: string; title: string; cents: number };

/**
 * What the buyer checked, read against what is offered now: only products on
 * offer, each once, at the price on the creator's record, never one the form
 * names that is not offered (a stale page, a typed value). Nothing checked is
 * nothing added: a box is never checked for the buyer.
 */
export function chosenCallAddOns(active: readonly { bump: Bump; target: Listing }[], raw: unknown): CallAddOnLine[] {
  const asked = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]).filter((value): value is string => typeof value === "string").map((value) => value.trim());
  const lines: CallAddOnLine[] = [];
  for (const { bump, target } of active) {
    if (!asked.includes(target.id) || lines.some((line) => line.productId === target.id)) continue;
    lines.push({ productId: target.id, title: target.title, cents: bump.priceCents });
  }
  return lines;
}

/** What the add-ons add to a booking's price, in the store currency's smallest unit. */
export function callAddOnsTotal(lines: readonly CallAddOnLine[]): number {
  return lines.reduce((sum, line) => sum + line.cents, 0);
}

/** Who ended a booking that carried add-ons. */
export type CallEndedBy = "buyer" | "creator" | "store";

/**
 * What is refunded when a booking with add-ons ends before it takes place:
 * the call alone when the buyer cancels it (the add-on was delivered with
 * their consent and is theirs), the call and every add-on when the creator
 * cancels it or the store could not hold its time.
 */
export function callAddOnRefund(by: CallEndedBy): "call" | "callAndAddOns" {
  return by === "buyer" ? "call" : "callAndAddOns";
}

/**
 * Said beside the boxes before paying, so nobody learns the cancellation rule
 * only after it applies. It promises only what the sale promises: a refund of
 * the call where the creator set a deadline (CancelPromise) and the booking is
 * not already inside it; on a call without one, canceling is asked of the
 * creator. The creator canceling refunds the extra in every case.
 */
export function callAddOnKeepWords(promise: CancelPromise | null, store: string): string {
  const yours = "An extra is yours as soon as you pay.";
  const theirs = `If ${store} cancels the call, you get the extra refunded too.`;
  if (!promise) return `${yours} If you want to cancel the call, ask ${store}. You keep the extra either way. ${theirs}`;
  const hours = promise.hours === 1 ? "1 hour" : `${promise.hours} hours`;
  if (promise.late) return `${yours} This call starts in less than ${hours}, so canceling it now gets no refund. You keep the extra. ${theirs}`;
  return `${yours} Cancel the call at least ${hours} before it starts to get it refunded. You keep the extra. ${theirs}`;
}

/** What the creator is told when an add-on set on a call is not offered, naming what to change. */
export function callAddOnPauseWords(pause: CallAddOnPause, offer: string | null): string {
  const name = offer ? `"${offer}"` : "That product";
  switch (pause) {
    case "notCall":
      return "Add-ons are offered on a paid call only. Give this call a price first.";
    case "package":
      return "Add-ons are not offered on a session paid by a package, because that session costs nothing here. They are offered when someone books and pays for one call.";
    case "deposit":
      return "Add-ons are not offered while this call takes a deposit online, because the rest is paid in person. Remove the deposit to offer them.";
    case "series":
      return "Add-ons are not offered on a series of sessions, which is charged one session at a time.";
    case "move":
      return "Add-ons are not offered when a booking moves, because moving costs nothing.";
    case "gone":
      return "The product this add-on offers is no longer in your store. Pick another one, or remove the add-on.";
    case "itself":
      return "An add-on cannot offer the call itself. Pick another product.";
    case "targetFree":
      return `${name} is free now, so there is no price to offer it at. Give it a price, or remove the add-on.`;
    case "targetRecurring":
      return `${name} is charged every month or year now, and an add-on is one payment. Pick a one-off product.`;
    case "targetCall":
      return `${name} is a booking now, and a booking is made on its own page. Pick another product.`;
    case "targetOptions":
      return `${name} has several prices now. Give it one price, or pick another product.`;
    case "targetPwyw":
      return `Buyers choose the price of ${name} now. Give it a set price, or pick another product.`;
    case "targetLimited":
      return `${name} has a limited number for sale, which only its own checkout counts. Remove the limit, or pick another product.`;
    case "targetEmpty":
      return `${name} has no file or link to hand over yet. Add one, or pick another product.`;
    case "targetPick":
      return `${name} is a bundle whose buyers choose what is in it. Pick another product.`;
    case "dearer":
      return `This add-on charges more for ${name} than buying it on its own does. Lower the add-on's price to ${name}'s price or less.`;
  }
}
