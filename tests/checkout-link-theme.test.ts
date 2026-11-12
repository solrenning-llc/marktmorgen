/**
 * 643 [WG3], part A: a short link may carry its own Checkout appearance.
 * This pure boundary accepts only the appearance itself, refuses colors that
 * cannot support AAA text, and uses the store appearance only when the link
 * deliberately has no theme.
 */
import { checkoutBranding, readCheckoutLinkTheme } from "@/lib/checkout-branding";
import { done, is, part } from "./check";

const store = { theme: "night", accent: "#2f74f5", font: "friendly" } as const;
const first = { background: "#ffffff", button: "#15112e", border: "pill", font: "nunito" };
const second = { background: "#000000", button: "#ffffff", border: "rectangular", font: "inter" };

part("A link theme is read as an exact, normalized appearance");
const one = readCheckoutLinkTheme(first, store);
const two = readCheckoutLinkTheme(second, store);
is("the first link keeps its own complete theme", one, {
  ok: true,
  source: "link",
  theme: first,
  branding: {
    "branding_settings[background_color]": "#ffffff",
    "branding_settings[button_color]": "#15112e",
    "branding_settings[border_style]": "pill",
    "branding_settings[font_family]": "nunito",
  },
});
is("the same store can have a different theme on another link", two, {
  ok: true,
  source: "link",
  theme: second,
  branding: {
    "branding_settings[background_color]": "#000000",
    "branding_settings[button_color]": "#ffffff",
    "branding_settings[border_style]": "rectangular",
    "branding_settings[font_family]": "inter",
  },
});
is("accepted shorthand is normalized before it can be stored", readCheckoutLinkTheme({ background: "fff", button: "#000", border: "rounded", font: "default" }, store), {
  ok: true,
  source: "link",
  theme: { background: "#ffffff", button: "#000000", border: "rounded", font: "default" },
  branding: {
    "branding_settings[background_color]": "#ffffff",
    "branding_settings[button_color]": "#000000",
    "branding_settings[border_style]": "rounded",
    "branding_settings[font_family]": "default",
  },
});

part("AAA is a save boundary, not a best-effort omission");
is("an unreadable background refuses the whole link theme", readCheckoutLinkTheme({ ...first, background: "#777777" }, store), { ok: false, reason: "contrast" });
is("an unreadable button refuses the whole link theme", readCheckoutLinkTheme({ ...first, button: "#777777" }, store), { ok: false, reason: "contrast" });
is("an invalid theme never falls back and looks saved", readCheckoutLinkTheme({ ...first, font: "private-font" }, store), { ok: false, reason: "invalid" });

part("Only appearance crosses the pure boundary");
for (const [name, raw] of [
  ["an extra email", { ...first, email: "person@example.test" }],
  ["an extra destination", { ...first, url: "https://person.example.test/private" }],
  ["a missing field", { background: first.background, button: first.button, border: first.border }],
  ["an array", [first]],
  ["text", JSON.stringify(first)],
] as const) {
  is(name, readCheckoutLinkTheme(raw, store), { ok: false, reason: "invalid" });
}
const inherited = Object.create({ email: "person@example.test" }) as Record<string, unknown>;
Object.assign(inherited, first);
is("a non-JSON prototype is refused rather than carrying inherited data", readCheckoutLinkTheme(inherited, store), { ok: false, reason: "invalid" });
let getterReads = 0;
const accessor = { ...first } as Record<string, unknown>;
Object.defineProperty(accessor, "button", { enumerable: true, get() { getterReads += 1; return "#15112e"; } });
is("an accessor is refused without executing it", readCheckoutLinkTheme(accessor, store), { ok: false, reason: "invalid" });
is("the accessor was never read", getterReads, 0);

part("No theme means the store theme, and only no theme means that");
const fallback = { ok: true, source: "store", theme: null, branding: checkoutBranding(store) };
is("undefined uses the store", readCheckoutLinkTheme(undefined, store), fallback);
is("null uses the store", readCheckoutLinkTheme(null, store), fallback);
is("an empty object is invalid, not the store", readCheckoutLinkTheme({}, store), { ok: false, reason: "invalid" });

done();
