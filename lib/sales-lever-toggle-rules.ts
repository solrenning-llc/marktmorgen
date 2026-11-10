/**
 * Which "Grow your sales" card (components/sales-levers.tsx) may switch its
 * lever on or off in place, and what that switch is (752 [CD3], unit 1).
 *
 * Nothing new is switched here. A card can switch a lever only where the
 * store already has an on/off setting for it, and then through that
 * setting's own route, under that route's own permission (lib/team-roles.ts),
 * with the same body the setting's own screen sends; the route checks every
 * rule again. Today that is two levers:
 *
 *   - Checkout recovery: /api/store/recovery, "settings", { enabled, address }.
 *     The saved postal address goes with both directions, because the route
 *     saves what it is sent and an empty address would erase it.
 *   - Next offer: /api/store/assistant-settings, "page", { next: { on, email } }.
 *     Offered on only while the Store assistant add-on is active, since
 *     buyers see nothing without it; off always works.
 *
 * Order bumps, offers after paying, downsells and bundles have no switch of
 * their own: each is a product and a price the creator chose. Turning one off
 * would delete that choice and turning it on needs a price, so their cards
 * open their settings, as they do today. So does any lever that would start
 * a new spend, change a price, a limit or a commission, or need the owner.
 *
 * Unknown is never a state to switch from (rule 24): a store record that
 * could not be read, a setting of the wrong shape or an add-on state that
 * could not be read offers no switch. A reply is "saved" only when the route
 * answered ok and echoed the state that was asked for; anything else is
 * unknown, and the creator is asked to reload rather than told it worked.
 * "Nothing was changed" is said only for a refusal the route gives before
 * any write; a server error may come after an applied write, so it is unknown.
 *
 * Pure and browser-safe: no server import, no request, no write.
 */
import { type Permission, type Role, can } from "@/lib/team-roles";
import { MAX_RECOVERY_ADDRESS } from "@/lib/recovery-setting-rules";
import { NEXT_OFFER_WORDS } from "@/lib/buyer-words/next-offer";
import type { LeverKey } from "@/lib/sales-levers";

/** How long the card offers "Undo" after a saved switch, in seconds. */
export const UNDO_SECONDS = 10;

/**
 * What switching a lever on can spend. "plan-capped": only what the plan or
 * the add-on already pays for, under ceilings checked before each spend.
 * "new-spend": anything else, such as ads; never switched from a card.
 */
export type LeverSpend = "none" | "plan-capped" | "new-spend";

export type LeverRoute = "/api/store/recovery" | "/api/store/assistant-settings";

export type LeverSpec = {
  key: string;
  title: string;
  /** The studio path the card already links to (lib/sales-levers.ts, salesLeverSettings). */
  path: string;
  /** The permission the lever's own settings route asks for. */
  permission: Permission;
  /** The existing on/off setting, or null when the lever has none. */
  setting: { route: LeverRoute } | null;
  spend: LeverSpend;
  /** Whether switching it would set or change a price, a limit or a commission. */
  changesTerms: boolean;
  /** Whether switching it needs the store owner's or Marktmorgen's owner's decision. */
  needsOwner: boolean;
  /** Why the card opens the settings instead, for a lever with no switch. */
  why: string;
};

const PRODUCT_PRICE = "Change it in the product's settings, where you choose the product and its price.";

export const LEVER_TOGGLE_SPECS: Record<LeverKey, LeverSpec> = {
  bump: {
    key: "bump",
    title: "Order bump",
    path: "#products",
    permission: "products",
    setting: null,
    spend: "none",
    changesTerms: true,
    needsOwner: false,
    why: `An order bump has no on/off switch of its own: it is the extra product and price you chose on a product. Turning it off here would delete that choice. ${PRODUCT_PRICE}`,
  },
  upsell: {
    key: "upsell",
    title: "Upsell",
    path: "#products",
    permission: "products",
    setting: null,
    spend: "none",
    changesTerms: true,
    needsOwner: false,
    why: `An upsell is a step you build after a product's checkout, with its own product and price. There is no single switch for it. ${PRODUCT_PRICE}`,
  },
  downsell: {
    key: "downsell",
    title: "Downsell",
    path: "#products",
    permission: "products",
    setting: null,
    spend: "none",
    changesTerms: true,
    needsOwner: false,
    why: `A downsell is the step shown when a buyer says no to an upsell, with its own product and price. There is no single switch for it. ${PRODUCT_PRICE}`,
  },
  bundle: {
    key: "bundle",
    title: "Bundle",
    path: "bundles",
    permission: "products",
    setting: null,
    spend: "none",
    changesTerms: true,
    needsOwner: false,
    why: "A bundle is a product with its own price and contents, so it has no on/off switch. Turning it off would change that product. Change it on the Bundles page, where you choose the products and the price.",
  },
  recovery: {
    key: "recovery",
    title: "Checkout recovery",
    path: "#recovery",
    permission: "settings",
    setting: { route: "/api/store/recovery" },
    spend: "plan-capped",
    changesTerms: false,
    needsOwner: false,
    why: "",
  },
  next: {
    key: "next",
    title: "Next offer",
    path: "#answers",
    permission: "page",
    setting: { route: "/api/store/assistant-settings" },
    spend: "plan-capped",
    changesTerms: false,
    needsOwner: false,
    why: "",
  },
};

/** What the card knows: the store record as loaded (null when it could not be read), the viewer's role, and whether the add-on is active. */
export type LeverFacts = {
  store: { name?: unknown; stripeAccountId?: unknown; recovery?: unknown; nextOffer?: unknown } | null;
  role: Role;
  /** Whether the Store assistant add-on is paid for this month (lib/store-assistant-rules.ts, assistantWindow). */
  addOn: boolean | "unknown";
};

type Base = { key: string; title: string; path: string };
/** A switch the card may show. */
export type LeverSwitch = Base & {
  kind: "toggle";
  permission: Permission;
  route: LeverRoute;
  /** The saved state now, and the state the switch asks for. */
  on: boolean;
  to: boolean;
  /** Sent to the route; undoBody puts back exactly the state read. */
  body: Record<string, unknown>;
  undoBody: Record<string, unknown>;
  /** The button's words. */
  label: string;
  /** Told beside the switch, before it is pressed. */
  before: string;
  /** What buyers see once it is on. */
  buyerSees: string;
  /** The words for the press back, once this one is saved (switchBack). */
  back: { label: string; before: string };
};
export type LeverControl =
  | LeverSwitch
  | (Base & { kind: "settings"; on: boolean | "unknown"; reason: string; mayOpen: boolean })
  | (Base & { kind: "unknown"; reason: string; mayOpen: boolean })
  /** The viewer's role cannot change this setting: no button. */
  | (Base & { kind: "hidden"; on: boolean | "unknown" });

const UNKNOWN = "Its saved setting could not be read just now, so it cannot be switched here. Reload the page, or open its settings.";
const BLOCKED = {
  spend: "Switching this on would start spending money that your plan does not already cover, so it is never switched from this screen. Open its settings to decide.",
  terms: "Switching this would set or change a price, a limit or a commission, so it is never switched from this screen. Open its settings to decide.",
  owner: "This needs a decision by the store's owner, so it is never switched from this screen. Open its settings.",
};

const RECOVERY_BEFORE = {
  on: "A reminder goes only to a buyer who asks for one: one email with the link back to what they left, sent under the reminder limits that already apply. No charge is added to your plan.",
  off: "Turning this off stops new reminder emails. Your postal address stays saved.",
};

/** What a press that turns the next offer on (to) or off says first; `back` when it puts back a setting just changed. */
function nextBefore(to: boolean, addOn: LeverFacts["addOn"], back = false): string {
  if (!to) {
    return addOn === false
      ? "Buyers do not see it now, because the Store assistant add-on is not active. Turning it off keeps it from coming back on its own when the add-on is."
      : "Turning this off stops suggesting a next product after a purchase, on the page and in the confirmation email.";
  }
  if (back && addOn === false) return "Turning it back on puts back the setting you had. Buyers do not see it while the Store assistant add-on is not active.";
  if (back && addOn === "unknown") return "Turning it back on puts back the setting you had. Whether buyers see it depends on the Store assistant add-on, which could not be read just now.";
  return "After paying, a buyer may be shown one more of your own products, at its own price. Any AI choice is paid from the add-on's monthly allowance. It is never turned on for you.";
}

type Recovery = { enabled: boolean; address: string };
type NextSetting = { on: boolean; email: boolean };

function readRecovery(raw: unknown): Recovery | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return typeof value.enabled === "boolean" && typeof value.address === "string" ? { enabled: value.enabled, address: value.address } : null;
}

function readNext(raw: unknown): NextSetting | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return typeof value.on === "boolean" && typeof value.email === "boolean" ? { on: value.on, email: value.email } : null;
}

function currentOf(spec: LeverSpec, store: LeverFacts["store"]): boolean | "unknown" {
  if (!store) return "unknown";
  if (spec.key === "recovery") return readRecovery(store.recovery)?.enabled ?? "unknown";
  if (spec.key === "next") return readNext(store.nextOffer)?.on ?? "unknown";
  return "unknown";
}

const storeName = (store: LeverFacts["store"]) =>
  store && typeof store.name === "string" && store.name.trim() ? store.name.replace(/\s+/g, " ").trim() : "your store";

/** The control for one card's lever, from what the card already has. */
export function leverToggle(key: LeverKey, facts: LeverFacts): LeverControl {
  return leverToggleFor(LEVER_TOGGLE_SPECS[key], facts);
}

/** The same, for any lever described by a spec. */
export function leverToggleFor(spec: LeverSpec, facts: LeverFacts): LeverControl {
  const base: Base = { key: spec.key, title: spec.title, path: spec.path };
  const mayOpen = can(facts.role, spec.permission);
  const on = currentOf(spec, facts.store);
  if (spec.spend === "new-spend") return { ...base, kind: "settings", on, reason: BLOCKED.spend, mayOpen };
  if (spec.changesTerms && spec.setting) return { ...base, kind: "settings", on, reason: BLOCKED.terms, mayOpen };
  if (spec.needsOwner) return { ...base, kind: "settings", on, reason: BLOCKED.owner, mayOpen };
  if (!spec.setting || (spec.key !== "recovery" && spec.key !== "next")) {
    return { ...base, kind: "settings", on, reason: spec.why || "This lever has no switch on this screen. Open its settings to change it.", mayOpen };
  }
  if (!mayOpen) return { ...base, kind: "hidden", on };
  if (on === "unknown" || !facts.store) return { ...base, kind: "unknown", reason: UNKNOWN, mayOpen };
  const route = spec.setting.route;
  const lower = spec.title.toLowerCase();
  const label = `${on ? "Turn off" : "Turn on"} ${lower}`;

  const backLabel = `${on ? "Turn on" : "Turn off"} ${lower}`;

  if (spec.key === "recovery") {
    const saved = readRecovery(facts.store.recovery)!;
    const address = saved.address;
    if (!on) {
      if (!address.trim() || address.length > MAX_RECOVERY_ADDRESS) {
        return { ...base, kind: "settings", on, mayOpen, reason: "Reminder emails must show your postal address. Add it in the reminder settings first, then turn this on." };
      }
      if (typeof facts.store.stripeAccountId !== "string" || !facts.store.stripeAccountId) {
        return { ...base, kind: "settings", on, mayOpen, reason: "Connect your Stripe account first. Reminders are about checkouts on your Stripe account." };
      }
    }
    return {
      ...base,
      kind: "toggle",
      permission: spec.permission,
      route,
      on,
      to: !on,
      // Each with the state it expects to find, compared under the store's lock (lib/setting-expect.ts).
      body: { enabled: !on, address, expect: { enabled: on, address } },
      undoBody: { enabled: on, address, expect: { enabled: !on, address } },
      label,
      before: RECOVERY_BEFORE[on ? "off" : "on"],
      back: { label: backLabel, before: RECOVERY_BEFORE[on ? "on" : "off"] },
      buyerSees:
        "A buyer who leaves checkout without paying can ask for one reminder email with the link back. If your Stripe account is in the United States, Stripe's checkout also asks for consent.",
    };
  }

  const saved = readNext(facts.store.nextOffer)!;
  if (!on && facts.addOn === "unknown") return { ...base, kind: "unknown", mayOpen, reason: "Whether your Store assistant add-on is active could not be read just now, so this cannot be turned on here. Reload the page, or open its settings." };
  if (!on && facts.addOn !== true) {
    return { ...base, kind: "settings", on, mayOpen, reason: "Next offer works only with the Store assistant add-on, and this store does not have it active now, so buyers would not see it. Open its settings to learn more." };
  }
  const words = NEXT_OFFER_WORDS.en;
  const name = storeName(facts.store);
  /** What the route saves for the switch (lib/next-offer-rules.ts: the email line only while on). */
  const after = { on: !on, email: on ? false : saved.email };
  return {
    ...base,
    kind: "toggle",
    permission: spec.permission,
    route,
    on,
    to: !on,
    body: { next: after, expect: { on: saved.on, email: saved.email } },
    undoBody: { next: { on: saved.on, email: saved.email }, expect: after },
    label,
    before: nextBefore(!on, facts.addOn),
    back: { label: backLabel, before: nextBefore(on, facts.addOn, true) },
    buyerSees: `One of your products under "${words.label(name)}", or under "${words.aiLabel}" when the assistant chose it, with a "${words.dismiss}" button.`,
  };
}

/** What happened after the card sent a switch, read from the route's reply. */
export type LeverOutcome =
  | { state: "saved"; text: string; undoBody: Record<string, unknown>; undoSeconds: number }
  /** changed: the setting was changed elsewhere since the page read it; the card no longer knows it. */
  | { state: "refused"; text: string; changed?: true }
  | { state: "unknown"; text: string };

/**
 * The refusals the two routes give before they write anything (the request
 * guard, lib/store-request.ts and studioAccess, and each route's own checks
 * ahead of its write): only these may say "Nothing was changed". A
 * "server_error" can follow a write that was applied and whose reply was
 * lost, and a code not listed here is not known to come first, so both are
 * unknown (rule 24).
 */
const REFUSED: Record<string, string> = {
  address: "Reminder emails must show your postal address. Add it in the reminder settings.",
  address_long: "The postal address is too long. Shorten it in the reminder settings.",
  stripe: "Connect your Stripe account first.",
  role: "Your role on this store does not include that setting.",
  forbidden: "This request came from another site.",
  signed_out: "You were signed out. Sign in again.",
  unavailable: "This could not be done just now, because a service it needs is not available. Try again later.",
  studio_used: "Your studio has reached its limit of changes for now. Try again later.",
  locked: "The store is locked right now.",
  two_step_required: "This needs your second sign-in step first.",
  store_gone: "This store is no longer open in your studio.",
  none: "The store could not be found.",
  invalid: "The request was not understood.",
  changed: "It was changed in another tab or by someone else after this page loaded. Reload the page to see the saved setting.",
};

const UNSURE = "We could not confirm the change. Reload the page to see the saved setting before you try again.";

/** The route's reply, read exactly: saved only when it echoes the state asked for. */
export function toggleOutcome(control: LeverSwitch, reply: unknown): LeverOutcome {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) return { state: "unknown", text: UNSURE };
  const value = reply as Record<string, unknown>;
  if (value.ok === false) {
    if (typeof value.error !== "string" || !Object.hasOwn(REFUSED, value.error)) return { state: "unknown", text: UNSURE };
    const text = `Nothing was changed. ${REFUSED[value.error]}`;
    return value.error === "changed" ? { state: "refused", text, changed: true } : { state: "refused", text };
  }
  if (value.ok !== true) return { state: "unknown", text: UNSURE };
  const echoed = control.route === "/api/store/recovery" ? readRecovery(value.recovery)?.enabled : readNext(value.next)?.on;
  if (echoed !== control.to) return { state: "unknown", text: UNSURE };
  return {
    state: "saved",
    text: `${control.title} is ${control.to ? "on" : "off"}.`,
    undoBody: control.undoBody,
    undoSeconds: UNDO_SECONDS,
  };
}

/**
 * The press back, once a switch is saved: the exact reverse (the state read
 * goes back with the body read), with its own words. Its own reverse is the
 * switch again.
 */
export function switchBack(control: LeverSwitch): LeverSwitch {
  return {
    ...control,
    on: control.to,
    to: control.on,
    body: control.undoBody,
    undoBody: control.body,
    label: control.back.label,
    before: control.back.before,
    back: { label: control.label, before: control.before },
  };
}

/**
 * What the card's switch knows after its presses: whether the saved state is
 * now the one its first press asked for ("unknown" once a reply did not
 * confirm, rule 24: nothing more is sent until the page is reloaded),
 * whether Undo is offered, and the last outcome.
 */
export type SwitchView = { flipped: boolean | "unknown"; undo: boolean; outcome: LeverOutcome | null };
export const SWITCH_START: SwitchView = { flipped: false, undo: false, outcome: null };

/** The switch as it stands in a view whose state is known. */
export function switchNow(control: LeverSwitch, flipped: boolean): LeverSwitch {
  return flipped ? switchBack(control) : control;
}

/**
 * One press of the card's switch or of its Undo, through `post` (the card's
 * fetch to the setting's own route). Undo is the press back, offered once
 * after a saved switch and kept after a refusal; a press from an unknown
 * state sends nothing. A thrown request is unknown, never refused or saved.
 */
export async function pressLever(
  control: LeverSwitch,
  view: SwitchView,
  how: "switch" | "undo",
  post: (route: LeverRoute, body: Record<string, unknown>) => Promise<unknown>,
): Promise<SwitchView> {
  if (view.flipped === "unknown" || (how === "undo" && !view.undo)) return view;
  const active = switchNow(control, view.flipped);
  let reply: unknown;
  try {
    reply = await post(active.route, active.body);
  } catch {
    reply = undefined;
  }
  const outcome = toggleOutcome(active, reply);
  if (outcome.state === "saved") return { flipped: !view.flipped, undo: how === "switch", outcome };
  // Changed elsewhere: what the card shows is no longer what is saved, so it asks for a reload.
  if (outcome.state === "refused") return outcome.changed ? { flipped: "unknown", undo: false, outcome } : { ...view, outcome };
  return { flipped: "unknown", undo: false, outcome };
}
