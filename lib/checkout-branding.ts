/**
 * The store's look on Stripe's payment page (536 [CB1], unit 1; added
 * 1 November 2026): the branding_settings a Checkout Session takes,
 * worked out from what the store already keeps (store.look), so the page a
 * buyer pays on looks like the store they came from, with nothing for the
 * creator to set.
 *
 * Fields, as Stripe's API reference lists them for creating a Checkout
 * Session (docs.stripe.com/api/checkout/sessions/create, read 1 November
 * 2026): background_color and button_color (a hex color starting with #),
 * border_style (pill, rectangular, rounded) and font_family (a closed list).
 *
 *   colors   the store's own computed palette (lib/store-look.ts,
 *            lookColours): the page's background and the buttons' fill. Each
 *            is sent only when black or white, whichever reads better, has
 *            at least 7:1 on it; a color that fails is left out, and the
 *            branding the creator set in their own Stripe dashboard stays
 *            (Stripe picks the ink on these colors itself: which one, on the
 *            Night theme's light-violet buttons above all, is to be seen in
 *            Stripe's test mode before the wiring unit sends any color);
 *   border   the store's buttons have a small rounding (app/globals.css .btn,
 *            border-radius: var(--r-sm)), so rounded;
 *   font     only a family on Stripe's list that is the store's own: the
 *            Friendly letters are Nunito, which Stripe has; the store's other
 *            families (Geist, Fraunces, Playfair Display, Bricolage) are not
 *            on it, so "default".
 *
 * Wiring it into every place a session is made, in one shared call, is the
 * next unit. Logo and icon only on the creator's own click, also later.
 * Browser-safe: plain data and pure functions.
 */
import { contrast, lookColours, normaliseHex, type StoreLook } from "@/lib/store-look";

/** Stripe's font families, exactly as its API lists them on 1 November 2026. */
export const STRIPE_FONTS = [
  "be_vietnam_pro", "bitter", "chakra_petch", "default", "hahmlet", "inconsolata", "inter", "lato", "lora", "m_plus_1_code", "montserrat",
  "noto_sans", "noto_sans_jp", "noto_serif", "nunito", "open_sans", "pridi", "pt_sans", "pt_serif", "raleway", "roboto", "roboto_slab",
  "source_sans_pro", "titillium_web", "ubuntu_mono", "zen_maru_gothic",
] as const;

/** The only border shapes Stripe accepts for Checkout branding. */
export const CHECKOUT_BORDER_STYLES = ["pill", "rectangular", "rounded"] as const;

/**
 * The appearance a short link may keep for Checkout. It contains appearance
 * only: the destination, buyer, creator and link code stay outside this
 * value, so none of them can become part of a shared URL by accident.
 */
export type CheckoutLinkTheme = {
  background: string;
  button: string;
  border: (typeof CHECKOUT_BORDER_STYLES)[number];
  font: (typeof STRIPE_FONTS)[number];
};

export type CheckoutLinkThemeRead =
  | { ok: true; source: "link"; theme: CheckoutLinkTheme; branding: Record<string, string> }
  | { ok: true; source: "store"; theme: null; branding: Record<string, string> }
  | { ok: false; reason: "invalid" | "contrast" };

/** The store's fonts that are, letter for letter, a family on Stripe's list; every other one is "default". */
const SAME_FONT: Partial<Record<StoreLook["font"], (typeof STRIPE_FONTS)[number]>> = { friendly: "nunito" };

/** Whether black or white, the better of the two, has at least 7:1 on a color. */
export function readableOn(color: string): boolean {
  return Math.max(contrast(color, "#000000"), contrast(color, "#ffffff")) >= 7;
}

/** The branding_settings fields for a Checkout Session, as form fields, from the store's look. */
export function checkoutBranding(look: Pick<StoreLook, "theme" | "accent" | "font">): Record<string, string> {
  return brandingFrom(lookColours(look), look.font);
}

/**
 * Reads the optional Checkout appearance carried by a short link.
 *
 * `null` and `undefined` mean that the link deliberately has no appearance,
 * so the store's current theme applies. Every present value is an exact JSON
 * object: extra fields (including a destination or personal data), inherited
 * fields and accessors are refused. Colors are normalized before they can be
 * saved, and both must support AAA text; an invalid present theme never falls
 * back and masquerades as a successfully saved store theme.
 */
export function readCheckoutLinkTheme(
  raw: unknown,
  storeLook: Pick<StoreLook, "theme" | "accent" | "font">,
): CheckoutLinkThemeRead {
  if (raw === null || raw === undefined) {
    return { ok: true, source: "store", theme: null, branding: checkoutBranding(storeLook) };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "invalid" };

  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) return { ok: false, reason: "invalid" };
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== 4 || keys.some((key) => typeof key !== "string" || !["background", "button", "border", "font"].includes(key))) {
      return { ok: false, reason: "invalid" };
    }
    descriptors = Object.getOwnPropertyDescriptors(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }

  const value = (key: keyof CheckoutLinkTheme): unknown => {
    const descriptor = descriptors[key];
    return descriptor?.enumerable && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  };
  const background = normaliseHex(value("background"));
  const button = normaliseHex(value("button"));
  const border = value("border");
  const font = value("font");
  const borderKnown = typeof border === "string" && (CHECKOUT_BORDER_STYLES as readonly string[]).includes(border);
  const fontKnown = typeof font === "string" && (STRIPE_FONTS as readonly string[]).includes(font);
  if (!background || !button || !borderKnown || !fontKnown) {
    return { ok: false, reason: "invalid" };
  }
  if (!readableOn(background) || !readableOn(button)) return { ok: false, reason: "contrast" };

  const theme: CheckoutLinkTheme = {
    background,
    button,
    border: border as CheckoutLinkTheme["border"],
    font: font as CheckoutLinkTheme["font"],
  };
  return {
    ok: true,
    source: "link",
    theme,
    branding: {
      "branding_settings[background_color]": theme.background,
      "branding_settings[button_color]": theme.button,
      "branding_settings[border_style]": theme.border,
      "branding_settings[font_family]": theme.font,
    },
  };
}

/** The same from a palette already worked out: apart, so the 7:1 guard can be tested with one that fails. */
export function brandingFrom(colours: { bg: string; accent: string }, font: StoreLook["font"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (readableOn(colours.bg)) out["branding_settings[background_color]"] = colours.bg;
  if (readableOn(colours.accent)) out["branding_settings[button_color]"] = colours.accent;
  out["branding_settings[border_style]"] = "rounded";
  // "default" when Stripe has no such family, as the owner's request says, which also sets aside a font chosen in the dashboard.
  out["branding_settings[font_family]"] = SAME_FONT[font] ?? "default";
  return out;
}
