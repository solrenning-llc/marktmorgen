/**
 * 613 [WP12] unit 2: the Reddit pixel (lib/pixels.ts, lib/reddit-pixel.ts,
 * lib/csp.ts, components/store-pixels.tsx, components/pixel-editor.tsx),
 * built only from what Claude 1 confirmed on Reddit's pages on 2 November
 * 2026. Checked: the ID's safe shape; the pixel is saved only with the
 * creator's word that Automated Advanced Matching is off; Reddit's own
 * script; init marked Limited Data Use with country and region for a visitor
 * who never said yes; Purchase and Lead with value, currency and
 * conversionId; nothing for a started checkout; never an identifier; the
 * page policy lets Reddit in on store pages only; the save is confirmed only
 * as sent.
 */
import { readFileSync } from "node:fs";
import { NO_PIXELS, parsePixels, pixelNames, readPixels } from "@/lib/pixels";
import { placeOf, redditInitCall, redditScript, redditTrackCall } from "@/lib/reddit-pixel";
import { dynamicPolicy } from "@/lib/csp";
import { pixelSettingsConfirmed } from "@/lib/marketing-settings-response";
import { done, is, part } from "./check";

part("The ID and the matching switch");
is("saved with the creator's word on matching", readPixels({ reddit: "a2_abc123", redditMatchingOff: true }), { ok: true, pixels: { ...NO_PIXELS, reddit: "a2_abc123", redditMatchingOff: true } });
is("refused without it", readPixels({ reddit: "a2_abc123" }), { ok: false, bad: "redditMatching" });
for (const bad of ["a2'); x//", "<script>", "a b", "ab"]) is(`ID ${JSON.stringify(bad)} refused`, readPixels({ reddit: bad, redditMatchingOff: true }), { ok: false, bad: "reddit" });
is("no Reddit pixel: no word needed", readPixels({ meta: "123456789012345" }).ok, true);
is("kept without the word: never put on a page", parsePixels({ ...NO_PIXELS, reddit: "a2_abc123" }).reddit, null);
is("named to the visitor", pixelNames({ ...NO_PIXELS, reddit: "a2_abc123", redditMatchingOff: true }), "Reddit");

part("What Reddit is told");
is("Reddit's own script, with the pixel's ID", redditScript("a2_abc123"), "https://www.redditstatic.com/ads/pixel.js?pixel_id=a2_abc123");
const ca = placeOf("US", "CA");
is("the place: country and ISO 3166-2 region", ca, { country: "US", region: "US-CA" });
is("a header that is not a code is unknown", placeOf("usa", "<x>"), { country: null, region: null });
is("init for a visitor who said yes", redditInitCall("a2_abc123", false, ca), ["init", "a2_abc123"]);
is("init for one who never said yes: Limited Data Use, country and region", redditInitCall("a2_abc123", true, ca), ["init", "a2_abc123", { dpm: "LDU", dpcc: "US", dprc: "US-CA" }]);
is("with no region known: the country alone", redditInitCall("a2_abc123", true, placeOf("US", null)), ["init", "a2_abc123", { dpm: "LDU", dpcc: "US" }]);
const pixels = { reddit: "a2_abc123" };
is(
  "a purchase: value, currency in capitals, the order as conversionId, the product",
  redditTrackCall(pixels, { type: "purchase", id: "cs_test_1", value: 27.5, currency: "eur", productId: "prod000001", title: "Knife Skills" }),
  ["track", "Purchase", { itemCount: 1, value: 27.5, currency: "EUR", conversionId: "cs_test_1", products: [{ id: "prod000001", name: "Knife Skills", quantity: 1 }] }],
);
is("a lead with the server's id", redditTrackCall(pixels, { type: "lead", id: "lead1" }), ["track", "Lead", { conversionId: "lead1" }]);
is("a started checkout: nothing", redditTrackCall(pixels, { type: "checkout" }), null);
is("no Reddit pixel: nothing", redditTrackCall({ reddit: null }, { type: "lead" }), null);
const loader = readFileSync("components/store-pixels.tsx", "utf8") + readFileSync("lib/reddit-pixel.ts", "utf8");
is("never an identifier passed to Reddit", ["email:", "phoneNumber", "externalId", "idfa", "aaid"].some((word) => loader.includes(word)), false);

part("The page's policy and the save");
const connect = (policy: string) => policy.split(";").find((d) => d.trim().startsWith("connect-src")) ?? "";
is("a store's page may reach Reddit", ["https://www.redditstatic.com", "https://*.reddit.com"].every((h) => connect(dynamicPolicy("n", { store: true })).includes(h)), true);
is("other pages may not", connect(dynamicPolicy("n", { store: false })).includes("reddit"), false);
const requested = { ...NO_PIXELS, reddit: "a2_abc123", redditMatchingOff: true as const };
is("the same back: confirmed", pixelSettingsConfirmed(true, { ok: true, pixels: requested }, requested), true);
is("the word lost on the way: not confirmed", pixelSettingsConfirmed(true, { ok: true, pixels: { ...requested, redditMatchingOff: undefined } }, requested), false);
const editor = readFileSync("components/pixel-editor.tsx", "utf8");
is("the studio asks for the word, labeled, with why", editor.includes("Automated Advanced Matching is switched off for this pixel in Reddit.") && editor.includes('aria-describedby="px-redditMatching-help"'), true);
done();
