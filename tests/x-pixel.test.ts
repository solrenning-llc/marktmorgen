/**
 * 613 [WP12], unit 1: the X pixel on a store's pages (lib/pixels.ts,
 * lib/x-pixel.ts, lib/csp.ts, components/store-pixels.tsx), built only from
 * what Claude 1 confirmed on X's own pages on 2 November 2026
 * (docs/x-reddit-pixels-official-check-2026-11-02.md). What is checked: the
 * ID and the two event IDs are held to a safe shape, nothing that could
 * close a string passes; the event names are X's `tw-<pixel>-<event>`; a
 * purchase carries value, currency and conversion_id; an event with no ID
 * from the creator, and a started checkout, are never sent; a visitor who
 * never said yes is sent with restricted_data_use; the page's security
 * policy lets X's hosts in on store pages only; a save is confirmed only when
 * the event IDs come back as sent. Nothing about Reddit.
 */
import { NO_PIXELS, PIXEL_KINDS, parsePixels, pixelNames, readPixels, tidyXEvent, xEventName } from "@/lib/pixels";
import { X_RESTRICTED, X_SCRIPT, xConfigCall, xEventCall } from "@/lib/x-pixel";
import { dynamicPolicy } from "@/lib/csp";
import { pixelSettingsConfirmed } from "@/lib/marketing-settings-response";
import { done, is, part } from "./check";

part("The IDs a creator pastes");
is("X is one of the pixels, off by default", [PIXEL_KINDS.includes("x"), NO_PIXELS.x], [true, null]);
const saved = readPixels({ x: " a1b2c ", xPurchase: "tw-a1b2c-p9q8r", xLead: "l7m6n" });
is("the pixel and both events kept; the whole tw-… name cut to its event ID", saved.ok ? [saved.pixels.x, saved.pixels.xEvents] : null, ["a1b2c", { purchase: "p9q8r", lead: "l7m6n" }]);
for (const bad of ["a1b2c'); alert(1)//", "<script>", "a b", "ab", "x".repeat(33)]) is(`pixel ${JSON.stringify(bad)} refused`, readPixels({ x: bad }), { ok: false, bad: "x" });
is("a purchase event ID that could close a string is refused", readPixels({ x: "a1b2c", xPurchase: "p9'q" }), { ok: false, bad: "xPurchase" });
is("so is a lead one", readPixels({ x: "a1b2c", xLead: "</script>" }), { ok: false, bad: "xLead" });
const none = readPixels({ x: "", xPurchase: "p9q8r" });
is("no X pixel: no X events kept", none.ok ? none.pixels.xEvents : "refused", undefined);
const empty = readPixels({ x: "a1b2c" });
is("a pixel with no event IDs keeps both empty", empty.ok ? empty.pixels.xEvents : null, { purchase: null, lead: null });
is("tidying a quoted ID", tidyXEvent(' "p9q8r" '), "p9q8r");
is("the stored shape reads back", parsePixels({ ...NO_PIXELS, x: "a1b2c", xEvents: { purchase: "p9q8r", lead: null } }).xEvents, { purchase: "p9q8r", lead: null });
is("a stored event ID that no longer passes is dropped alone", parsePixels({ ...NO_PIXELS, meta: "123456789012345", x: "a1b2c", xEvents: { purchase: "p'9", lead: "l7m6n" } }), { ...NO_PIXELS, meta: "123456789012345", x: "a1b2c", xEvents: { purchase: null, lead: "l7m6n" } });
is("named to the visitor with the others", pixelNames({ ...NO_PIXELS, meta: "123456789012345", x: "a1b2c" }), "Meta and X");

part("What X is told");
const pixels = { x: "a1b2c", xEvents: { purchase: "p9q8r", lead: "l7m6n" } };
is("the event name is X's tw-<pixel>-<event>", xEventName("a1b2c", "p9q8r"), "tw-a1b2c-p9q8r");
is("X's own script, from X's host", X_SCRIPT, "https://static.ads-twitter.com/uwt.js");
is("config for a visitor who said yes", xConfigCall("a1b2c", false), ["config", "a1b2c"]);
is("config for a visitor who never said yes: limited", xConfigCall("a1b2c", true), ["config", "a1b2c", { restricted_data_use: "restrict_optimization" }]);
is(
  "a purchase: value, currency in capitals and the order as conversion_id",
  xEventCall(pixels, { type: "purchase", id: "cs_test_1", value: 27.5, currency: "eur" }, false),
  ["event", "tw-a1b2c-p9q8r", { value: 27.5, currency: "EUR", conversion_id: "cs_test_1" }],
);
is(
  "…limited when the visitor never said yes",
  xEventCall(pixels, { type: "purchase", id: "cs_test_1", value: 27.5 }, true),
  ["event", "tw-a1b2c-p9q8r", { value: 27.5, currency: "USD", conversion_id: "cs_test_1", ...X_RESTRICTED }],
);
is("a lead, with the server's id when there is one", xEventCall(pixels, { type: "lead", id: "lead1" }, false), ["event", "tw-a1b2c-l7m6n", { conversion_id: "lead1" }]);
is("a lead without one", xEventCall(pixels, { type: "lead" }, false), ["event", "tw-a1b2c-l7m6n", {}]);
is("a started checkout is never sent to X", xEventCall(pixels, { type: "checkout" }, false), null);
is("no purchase event ID: the purchase is not sent", xEventCall({ x: "a1b2c", xEvents: { purchase: null, lead: "l7m6n" } }, { type: "purchase", id: "cs_test_1", value: 1 }, false), null);
is("no X pixel: nothing is sent", xEventCall({ x: null, xEvents: pixels.xEvents }, { type: "lead" }, false), null);

part("The page's security policy");
const connect = (policy: string) => policy.split(";").find((d) => d.trim().startsWith("connect-src")) ?? "";
const store = connect(dynamicPolicy("n0nce", { store: true }));
for (const host of ["https://static.ads-twitter.com", "https://ads-twitter.com", "https://ads-api.twitter.com", "https://analytics.twitter.com"]) {
  is(`a store's page may reach ${host}`, store.trim().split(/\s+/).includes(host), true);
}
const sources = (directive: string) => directive.trim().split(/\s+/).slice(1);
is("a page that is not a store's reaches none of them", sources(connect(dynamicPolicy("n0nce", { store: false }))).some((src) => /^https:\/\/([a-z0-9-]+\.)*(ads-)?twitter\.com$/.test(src)), false);

part("A save is confirmed only as sent");
const requested = { ...NO_PIXELS, x: "a1b2c", xEvents: { purchase: "p9q8r", lead: null } };
is("the same IDs back: confirmed", pixelSettingsConfirmed(true, { ok: true, pixels: requested }, requested), true);
is("an event ID lost on the way: not confirmed", pixelSettingsConfirmed(true, { ok: true, pixels: { ...requested, xEvents: { purchase: null, lead: null } } }, requested), false);

done();
