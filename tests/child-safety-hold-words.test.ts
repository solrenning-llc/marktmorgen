/**
 * A product held for a child-safety report is refused by the shipping, pairs, preview, checkout-fields and
 * after-payment routes (409 `on_hold`), and a hold that cannot be read is refused too (503). Claude 3 cloud P's
 * accessibility review of #3471 (6871891162): those five studio screens had no words for `on_hold`, so the creator
 * read a wrong reason and was told to retry what cannot succeed (WCAG 3.3.1, 3.3.3); and an unreadable hold answered
 * `unavailable`, which the product editor reads as "Stores are not switched on yet".
 *  - Each screen says the hold's own sentence for `on_hold`, and the unreadable-hold sentence for `hold_unread`.
 *  - The refusal for an unreadable hold is its own code, `hold_unread`, never `unavailable`.
 */
import * as shipping from "@/components/shipping-editor";
import * as pairs from "@/components/pairs-editor";
import * as preview from "@/components/pdf-preview-toggle";
import * as fields from "@/components/checkout-fields-editor";
import * as paths from "@/components/buyer-paths";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

type Words = (code: unknown) => string;
const screens: [string, Words | undefined][] = [
  ["shipping", (shipping as Record<string, unknown>).shippingRefusal as Words | undefined],
  ["pairs", (pairs as Record<string, unknown>).pairsRefusal as Words | undefined],
  ["preview", (preview as Record<string, unknown>).previewRefusal as Words | undefined],
  ["checkout fields", (fields as Record<string, unknown>).fieldsRefusal as Words | undefined],
  ["after paying", (paths as Record<string, unknown>).offerRefusal as Words | undefined],
];

part("The hold's own words exist");
is("on_hold says the product is on hold", typeof STUDIO_MESSAGES.on_hold === "string" && STUDIO_MESSAGES.on_hold.includes("on hold"), true);
is("hold_unread says the hold could not be read, and to try again later", typeof STUDIO_MESSAGES.hold_unread === "string" && /could not (be )?read|could not check/i.test(STUDIO_MESSAGES.hold_unread) && /try again/i.test(STUDIO_MESSAGES.hold_unread), true);
is("and it never says stores are not switched on", /switched on/i.test(STUDIO_MESSAGES.hold_unread ?? "switched on"), false);

part("Each screen a held product's route answers says why, in the hold's own words");
for (const [name, words] of screens) {
  is(`${name}: on_hold is the hold's sentence`, words?.("on_hold"), STUDIO_MESSAGES.on_hold);
  is(`${name}: hold_unread is the unreadable hold's sentence`, words?.("hold_unread"), STUDIO_MESSAGES.hold_unread);
}

part("An unreadable hold is refused with its own code");
const holds = readFileSync("lib/child-safety.ts", "utf8");
is("heldRefusal and heldRefusalAmong answer hold_unread, never unavailable, when the hold cannot be read", [/error: "hold_unread" \}, \{ status: 503 \}/.test(holds), /error: "unavailable" \}, \{ status: 503 \}/.test(holds)], [true, false]);

done();
