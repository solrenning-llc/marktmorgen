/**
 * An annual switch is offered only when the membership is confirmed to carry no discount (#4711, Codex X8). With
 * `discounts` missing or in a shape that does not read, and the legacy `discount` null, the switch claimed a saving
 * a monthly discount in force could undo, and ran. An unread discount list now means the switch is not offered.
 * Pure rules; synthetic subscription.
 */
import { yearlyChoice, discounted } from "@/lib/yearly-switch-rules";
import { done, is, part } from "./check";

const NOW = Math.floor(Date.now() / 1000);
const club = { id: "club", priceCents: 2000, recurring: { interval: "month", trialDays: 0, payments: 0 }, options: [], pwyw: null, yearly: { cents: 20000 } };
const base = {
  status: "active", discount: null, metadata: { store: "harbor", product: "club" },
  items: { data: [{ quantity: 1, price: { unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
};

async function main(): Promise<void> {
  part("Controls");
  is("discounts [] offered", yearlyChoice({ ...base, discounts: [] } as never, club as never, [], "usd", NOW), { cents: 20000, saving: 4000, monthly: 2000 });
  is("discounts [id] refused", yearlyChoice({ ...base, discounts: ["di_fixture"] } as never, club as never, [], "usd", NOW), null);
  is("a legacy discount refused", yearlyChoice({ ...base, discount: { id: "di_old" }, discounts: [] } as never, club as never, [], "usd", NOW), null);

  part("A discount list that does not read is never taken as none");
  is("discounts absent, discount null: not offered", yearlyChoice({ ...base } as never, club as never, [], "usd", NOW), null);
  is("discounts {}: not offered", yearlyChoice({ ...base, discounts: {} } as never, club as never, [], "usd", NOW), null);
  is("discounts null: not offered", yearlyChoice({ ...base, discounts: null } as never, club as never, [], "usd", NOW), null);
  is("discounted() says so for each", [discounted({ ...base } as never), discounted({ ...base, discounts: {} } as never), discounted({ ...base, discounts: null } as never), discounted({ ...base, discounts: [] } as never)], [true, true, true, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
