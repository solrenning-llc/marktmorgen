/**
 * The store's look on Stripe's payment page (536 [CB1], unit 1,
 * lib/checkout-branding.ts; added 1 November 2026). Checked over every
 * theme, every offered color and every font: only Stripe's own field names
 * and values; colors sent only with 7:1 for black or white on them, and
 * left out otherwise; rounded corners like the store's buttons; a font only
 * when Stripe has the very family, else "default".
 */
import { readFileSync } from "node:fs";
import { STRIPE_FONTS, brandingFrom, checkoutBranding, readableOn } from "@/lib/checkout-branding";
import { ACCENTS, FONTS, THEMES, contrast, lookColours } from "@/lib/store-look";
import { done, is, part } from "./check";

const FIELDS = new Set(["branding_settings[background_color]", "branding_settings[button_color]", "branding_settings[border_style]", "branding_settings[font_family]"]);
const looks = THEMES.flatMap((t) => ACCENTS.flatMap((a) => FONTS.map((f) => ({ theme: t.id, accent: a.hex, font: f.id }))));

part("Only Stripe's fields and values");
const all = looks.map((l) => checkoutBranding(l));
is("only the four fields", all.every((b) => Object.keys(b).every((k) => FIELDS.has(k))), true);
is("colors are #rrggbb", all.every((b) => ["branding_settings[background_color]", "branding_settings[button_color]"].every((k) => !(k in b) || /^#[0-9a-f]{6}$/.test(b[k]))), true);
is("corners rounded, like the store's buttons", all.every((b) => b["branding_settings[border_style]"] === "rounded") && /\n\.btn \{[^}]*border-radius: var\(--r-sm\);/.test(readFileSync("app/globals.css", "utf8")), true);
is("the font is always on Stripe's list", all.every((b) => (STRIPE_FONTS as readonly string[]).includes(b["branding_settings[font_family]"])), true);

part("Colors only at 7:1");
is("every color sent has 7:1 for black or white on it", all.every((b) => ["branding_settings[background_color]", "branding_settings[button_color]"].every((k) => !(k in b) || readableOn(b[k]))), true);
is("the readable test, both ways", [readableOn("#ffffff"), readableOn("#000000"), readableOn("#777777")], [true, true, false]);
is("a color that would fail is left out, field by field (a palette that fails, given directly)", [brandingFrom({ bg: "#777777", accent: "#15112e" }, "modern"), brandingFrom({ bg: "#ffffff", accent: "#777777" }, "modern")].map((b) => ["branding_settings[background_color]" in b, "branding_settings[button_color]" in b]), [[false, true], [true, false]]);
is("with every offered theme and color the store's palette already passes, so nothing is left out today", all.every((b) => "branding_settings[background_color]" in b && "branding_settings[button_color]" in b), true);
is("the store's own pages' colors are what is sent", checkoutBranding({ theme: "night", accent: "#2f74f5", font: "modern" })["branding_settings[background_color]"], lookColours({ theme: "night", accent: "#2f74f5" }).bg);
is("the night background reads with white", contrast(lookColours({ theme: "night", accent: "#5a36ee" }).bg, "#ffffff") >= 7, true);

part("The font, only the same family");
is("Friendly is Nunito, which Stripe has", checkoutBranding({ theme: "light", accent: "#5a36ee", font: "friendly" })["branding_settings[font_family]"], "nunito");
is("every other store font: default", FONTS.filter((f) => f.id !== "friendly").map((f) => checkoutBranding({ theme: "light", accent: "#5a36ee", font: f.id })["branding_settings[font_family]"]), FONTS.filter((f) => f.id !== "friendly").map(() => "default"));
is("Friendly is Nunito in the app's own fonts", /Nunito\(\{ variable: "--font-st-friendly"/.test(readFileSync("app/layout.tsx", "utf8")), true);
done();
