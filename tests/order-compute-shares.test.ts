/**
 * The declared shares of ORDER_COMPUTE (tests/plan-cost-registry.ts) against what one order really spends (the Claude 4
 * coordinator's cost finding of 21 November 2026, 07:20 UTC: the named shares add up to 1.47 and nothing proved they do
 * not meet in one order).
 *
 * Holds:
 *   - an order's contact write, at its worst, is priced in its own line (order-contact-write, ORDER_CONTACT_WRITE), not
 *     inside ORDER_COMPUTE (Claude 5's decision of 21 November 2026). Its worst is one checkout handing over
 *     MAX_DELIVERED products (lib/bundle-rules.ts: the product, each bump, a bundle's items for each and the
 *     affiliate's extras; Claude 6's review of #5026) put on the list (lib/buyer-list.ts putOnList): with the box
 *     ticked, one upsertContact and a noteProduct for every other product; without it, a noteProduct for every product.
 *     Each is counted at CONTACT_COMMANDS_MOST (lib/contacts.ts), which tests/contacts-write-cost.test.ts checks
 *     against the real scripts. Both callers of putOnList hand over at most MAX_DELIVERED products;
 *   - an order's shipment mark (lib/shipments.ts, SHIPMENT_MARK_COMMANDS since #5258) is held to its own declared share;
 *   - the shares one paid cart order can spend together inside ORDER_COMPUTE (its stock holds, its stock confirmation,
 *     a purchase for several's settling waits and its shipment mark) stay inside one ORDER_COMPUTE;
 *   - an offer after paying is an order of its own: lib/upsell.ts admits it as one more order before anything is
 *     charged and puts nothing on the list or in stock. So OFFER_WATCH_SHARE_OF_ORDER_COMPUTE is a share of that
 *     order's compute, never added to the cart's.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUMP_KEYS, MAX_AFFILIATE_EXTRAS, MAX_BUNDLE_ITEMS, MAX_DELIVERED, deliveredIds } from "@/lib/bundle-rules";
import { CONTACT_COMMANDS_MOST } from "@/lib/contacts";
import { SHIPMENT_MARK_COMMANDS } from "@/lib/shipments";
import { done, is, part } from "./check";
import * as registry from "./plan-cost-registry";

const { CART_STOCK_SHARE_OF_ORDER_COMPUTE, COMMAND, GROUP_SETTLE_STRIPE_WAIT, OFFER_WATCH_SHARE_OF_ORDER_COMPUTE, ORDER_COMPUTE, STOCK_CONFIRM_SHARE_OF_ORDER_COMPUTE } = registry;
// Read by name, so this test also fails while the line is missing (RED on main), not only fails to build.
const contactLine = (registry as Record<string, unknown>).ORDER_CONTACT_WRITE;
const contactCommands = (registry as Record<string, unknown>).ORDER_CONTACT_WRITE_COMMANDS;
const contactShare = (registry as Record<string, unknown>).CONTACT_SHARE_OF_ORDER_COMPUTE;
const shipmentShare = (registry as Record<string, unknown>).SHIPMENT_MARK_SHARE_OF_ORDER_COMPUTE;

const source = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

part("What one order hands to putOnList is at most MAX_DELIVERED products");
{
  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  // The fullest checkout deliveredIds can read: a product, three bumps, a full bundle under each and every extra.
  const meta: Record<string, string> = { product: "p", aff_extra: ids("x", MAX_AFFILIATE_EXTRAS + 2).join(",") };
  BUMP_KEYS.forEach((key, i) => {
    meta[key] = `b${i}`;
    meta[`${key}_bundle`] = ids(`${key}i`, MAX_BUNDLE_ITEMS + 5).join(",");
  });
  meta.bundle = ids("pi", MAX_BUNDLE_ITEMS + 5).join(",");
  const delivered = deliveredIds(meta);
  is("the fullest checkout hands over exactly MAX_DELIVERED products", delivered.length, MAX_DELIVERED);
  const sweep = source("lib/checkout-sweep.ts");
  is("the sweep lists only what deliveredIds names (listingsNamed)", /const products = await listingsNamed\(store, row\.metadata\);\s*const outcome = await putOnList\(/.test(sweep), true);
  is("listingsNamed reads only deliveredIds", /const ids = deliveredIds\(meta\);/.test(source("lib/catalog.ts")), true);
  const thanks = source("app/[handle]/thanks/page.tsx");
  is(
    "the thanks page lists the product, its bumps and their bundles' items, never more than deliveredIds would",
    thanks.includes("products: [order.product, ...order.bumps.map((added) => added.product), ...bundled]") &&
      thanks.includes("[...(order.items?.items ?? []), ...order.bumps.flatMap((added) => added.items?.items ?? [])]"),
    true,
  );
  const checkout = source("lib/store-checkout.ts");
  is(
    "readOrder reads each bundle's items through bundleFromMeta, at most MAX_BUNDLE_ITEMS each",
    checkout.includes('const mainList = bundleFromMeta(metadata, "bundle");') && checkout.includes("const list = bundleFromMeta(metadata, `${key}_bundle`);"),
    true,
  );
  is("and a page's bundles stay inside their bound", 1 + BUMP_KEYS.length + MAX_BUNDLE_ITEMS * (1 + BUMP_KEYS.length) <= MAX_DELIVERED, true);
}

part("An order's contact write at its worst (lib/buyer-list.ts putOnList, MAX_DELIVERED products)");
{
  const t = CONTACT_COMMANDS_MOST;
  const ticked = t.upsert + (MAX_DELIVERED - 1) * t.noteProduct;
  const unticked = MAX_DELIVERED * t.noteProduct;
  const worst = Math.max(ticked, unticked);
  is("putOnList writes the contact the way this test counts it", /upsertContact\(/.test(source("lib/buyer-list.ts")) && /noteProduct\(/.test(source("lib/buyer-list.ts")), true);
  is("RED: ORDER_CONTACT_WRITE_COMMANDS is that worst", contactCommands, worst);
  is("RED: its own line prices at least every one of those commands", typeof contactLine === "number" && contactLine >= worst * COMMAND, true);
  is("and it is no longer a share of ORDER_COMPUTE", contactShare, undefined);
  const lines = registry.COST_LINES as unknown as readonly { id: string; monthlyUsd: (tier: "creator" | "pro" | "scale") => number }[];
  const line = lines.find((l) => l.id === "order-contact-write");
  is("the line order-contact-write is in the registry", Boolean(line), true);
  is("and prices every order of the plan's figure at that worst", line ? line.monthlyUsd("creator") > 0 : false, true);
}

part("An order's shipment mark is a declared share of ORDER_COMPUTE (#5258, #5396)");
{
  // lib/shipments.ts is priced as ORDER (tests/plan-cost-registry.ts): the done-mark, taken once an order through the
  // store's claim fence, is SHIPMENT_MARK_COMMANDS (an EVAL and its three calls, one plain SET before #5258).
  is("RED: SHIPMENT_MARK_SHARE_OF_ORDER_COMPUTE is declared", typeof shipmentShare, "number");
  is("the mark's commands stay inside that share", SHIPMENT_MARK_COMMANDS * COMMAND <= (shipmentShare as number) * ORDER_COMPUTE, true);
  is("lib/shipments.ts takes the mark only through takeMark (claimOnceWhileStoreLive)", /const takeMark = \(store: Store, session: string, shipped: Shipped\) =>\s*claimOnceWhileStoreLive\(/.test(source("lib/shipments.ts")), true);
}

part("The shares one paid cart order can spend together");
{
  const together =
    CART_STOCK_SHARE_OF_ORDER_COMPUTE + STOCK_CONFIRM_SHARE_OF_ORDER_COMPUTE + GROUP_SETTLE_STRIPE_WAIT / ORDER_COMPUTE + ((shipmentShare as number) ?? Number.NaN);
  is("its stock holds, stock confirmation, a group's settling waits and its shipment mark stay inside one ORDER_COMPUTE", together <= 1, true);
}

part("An offer after paying is an order of its own, so its watch is not added to the cart's shares");
{
  const upsell = source("lib/upsell.ts");
  is("lib/upsell.ts admits the offer as one more order before anything is charged", /admitOrders\(store, 1\)/.test(upsell), true);
  is("and it neither puts anybody on the list nor touches stock", /from "@\/lib\/(buyer-list|stock)"|upsertContact\(|noteProduct\(/.test(upsell), false);
  is("its watch stays inside one ORDER_COMPUTE", OFFER_WATCH_SHARE_OF_ORDER_COMPUTE <= 1, true);
}

done();
