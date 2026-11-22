/**
 * A short link's own Checkout appearance (lib/checkout-branding.ts, readCheckoutLinkTheme) needs its button to be
 * seen on its background: 3:1 between the two (WCAG 1.4.11, non-text contrast), as the store's own buttons keep on
 * their cards (lib/store-look.ts, lookColours). Before, each color was only checked against black and white, so a
 * white button on a white page, or a white one on yellow, was accepted: a Pay button nobody can find.
 */
import { contrast } from "@/lib/store-look";
import { readCheckoutLinkTheme } from "@/lib/checkout-branding";
import { done, is, part } from "./check";

const store = { theme: "light", accent: "#5a36ee", font: "modern" } as const;
const theme = (background: string, button: string) => ({ background, button, border: "rounded", font: "default" });

part("A button that cannot be told from its page is refused");
is("white on white", readCheckoutLinkTheme(theme("#ffffff", "#ffffff"), store), { ok: false, reason: "contrast" });
is("white on yellow", readCheckoutLinkTheme(theme("#ffff00", "#ffffff"), store), { ok: false, reason: "contrast" });
is("near black on black", readCheckoutLinkTheme(theme("#000000", "#15112e"), store), { ok: false, reason: "contrast" });

part("A button that stands out is kept");
is("dark ink on white", readCheckoutLinkTheme(theme("#ffffff", "#15112e"), store).ok, true);
is("at least 3:1 between them", contrast("#ffffff", "#15112e") >= 3, true);
is("white on near black", readCheckoutLinkTheme(theme("#15112e", "#ffffff"), store).ok, true);

done();
