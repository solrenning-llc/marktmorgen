/**
 * The gift and group-buy buyer indexes key a buyer by the same field (#5125). The helper was written twice, identically,
 * in lib/gifts.ts and lib/group-buy.ts; one changed alone would have split the two indexes with no error (Claude 1 and
 * Claude 4 Z's NIT on #5148). Both now read it from lib/buyer-field.ts, and so does the call-package index (#5149).
 * Synthetic addresses only.
 */
import { buyerField, buyerOf } from "@/lib/buyer-field";
import { buyerField as giftField } from "@/lib/gifts";
import { buyerField as groupField } from "@/lib/group-buy";
import { buyerField as packageField } from "@/lib/call-packages";
import { done, is, part } from "./check";

part("One buyer field for gifts and purchases for several");
// The same function, compared by identity: `is` compares by JSON, where every function reads the same.
is("lib/gifts.ts hands out the shared helper", giftField === buyerField, true);
is("lib/group-buy.ts hands out the shared helper", groupField === buyerField, true);
// The call-package buyer index (#5149) keys its buyer the same way, by the same helper (one place to change it).
is("lib/call-packages.ts hands out the shared helper", packageField === buyerField, true);
is("trimmed and in lower case", buyerField("  Ada@Example.COM "), buyerField("ada@example.com"));
is("a checkout with an address names its buyer", buyerOf({ customer_details: { email: " Ada@example.com" } }), { b: buyerField("ada@example.com") });
is("a checkout with no address names none", buyerOf({ customer_details: null }), {});
done();
