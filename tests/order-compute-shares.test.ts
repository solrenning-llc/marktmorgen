/**
 * The declared shares of ORDER_COMPUTE (tests/plan-cost-registry.ts) against what one order really spends (the Claude 4
 * coordinator's cost finding of 21 November 2026, 07:20 UTC: the named shares add up to 1.47 and nothing proved they do
 * not meet in one order).
 *
 * Holds:
 *   - an order's contact write, at its worst, stays inside CONTACT_SHARE_OF_ORDER_COMPUTE. Its worst is a paid cart
 *     of MAX_CART products put on the list (lib/buyer-list.ts putOnList): with the box ticked, one upsertContact and a
 *     noteProduct for every other product; without it, a noteProduct for every product. Each is counted at
 *     CONTACT_COMMANDS_MOST (lib/contacts.ts), which tests/contacts-write-cost.test.ts checks against the real scripts;
 *   - the shares one paid cart order can spend together (its stock holds, its stock confirmation, its contact write
 *     and a purchase for several's settling waits) stay inside one ORDER_COMPUTE;
 *   - an offer after paying is an order of its own: lib/upsell.ts admits it as one more order before anything is
 *     charged and puts nothing on the list or in stock. So OFFER_WATCH_SHARE_OF_ORDER_COMPUTE is a share of that
 *     order's compute, never added to the cart's.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_CART } from "@/lib/cart-rules";
import { CONTACT_COMMANDS_MOST } from "@/lib/contacts";
import { done, is, part } from "./check";
import {
  CART_STOCK_SHARE_OF_ORDER_COMPUTE,
  COMMAND,
  CONTACT_SHARE_OF_ORDER_COMPUTE,
  GROUP_SETTLE_STRIPE_WAIT,
  OFFER_WATCH_SHARE_OF_ORDER_COMPUTE,
  ORDER_COMPUTE,
  STOCK_CONFIRM_SHARE_OF_ORDER_COMPUTE,
} from "./plan-cost-registry";

const source = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

part("An order's contact write at its worst (lib/buyer-list.ts putOnList, a cart of MAX_CART products)");
{
  const t = CONTACT_COMMANDS_MOST;
  const ticked = t.upsert + (MAX_CART - 1) * t.noteProduct;
  const unticked = MAX_CART * t.noteProduct;
  const worst = Math.max(ticked, unticked);
  is("putOnList writes the contact the way this test counts it", /upsertContact\(/.test(source("lib/buyer-list.ts")) && /noteProduct\(/.test(source("lib/buyer-list.ts")), true);
  is(
    "RED: its commands stay inside CONTACT_SHARE_OF_ORDER_COMPUTE",
    [worst, worst * COMMAND <= CONTACT_SHARE_OF_ORDER_COMPUTE * ORDER_COMPUTE],
    [worst, true],
  );
}

part("The shares one paid cart order can spend together");
{
  const together = CART_STOCK_SHARE_OF_ORDER_COMPUTE + STOCK_CONFIRM_SHARE_OF_ORDER_COMPUTE + CONTACT_SHARE_OF_ORDER_COMPUTE + GROUP_SETTLE_STRIPE_WAIT / ORDER_COMPUTE;
  is("its stock holds, stock confirmation, contact write and a group's settling waits stay inside one ORDER_COMPUTE", together <= 1, true);
}

part("An offer after paying is an order of its own, so its watch is not added to the cart's shares");
{
  const upsell = source("lib/upsell.ts");
  is("lib/upsell.ts admits the offer as one more order before anything is charged", /admitOrders\(store, 1\)/.test(upsell), true);
  is("and it neither puts anybody on the list nor touches stock", /from "@\/lib\/(buyer-list|stock)"|upsertContact\(|noteProduct\(/.test(upsell), false);
  is("its watch stays inside one ORDER_COMPUTE", OFFER_WATCH_SHARE_OF_ORDER_COMPUTE <= 1, true);
}

done();
