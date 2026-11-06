/**
 * A share of its own for a membership (397 [SL1], unit 2; added 2 November
 * 2026). Checked: the share an affiliate earns on a membership's payment is
 * the one chosen for that product (commissionRate, the same the checkout puts
 * on the subscription as via_rate); in the studio, a membership joins the
 * list of products with a share of their own as soon as months are chosen
 * for memberships, not only after saving; and the checkout puts the chosen
 * months and share on the subscription. Read from the source where it is a
 * screen's state or a request to Stripe.
 */
import { readFileSync } from "node:fs";
import { commissionRate, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { done, is, part } from "./check";

part("The share a membership earns");
const setting = parseAffiliateSetting({ enabled: true, percent: 20, days: 30, rule: "last", payday: 15, hold: 30, buyers: true, directory: false, lifetime: true, recurring: 12, rates: { clubmembership: 40 } });
is("its own share when chosen, the program's otherwise", [commissionRate(setting, "clubmembership"), commissionRate(setting, "otherproduct")], [40, 20]);

part("In the studio and at checkout");
const studio = readFileSync("components/affiliate-studio.tsx", "utf8").replace(/\s+/g, " ");
is("a membership takes a share as soon as months are chosen", [studio.includes("const recurringOn = Number(recurringMonths) > 0;"), studio.includes("const credited = products.filter((p) => (p.recurring ? recurringOn : p.credited));")], [true, true]);
const checkout = readFileSync("lib/store-checkout.ts", "utf8").replace(/\s+/g, " ");
is("the checkout puts the share and the months on the subscription", [checkout.includes('body.set("subscription_data[metadata][via_rate]", String(extras.via.rate));'), checkout.includes('body.set("subscription_data[metadata][via_months]", String(store.affiliates.recurring));')], [true, true]);

done();
