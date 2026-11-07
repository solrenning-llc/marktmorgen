/** Independent residual parent-shape evidence. Synthetic, pure, no I/O. */
import { readSub } from "@/lib/membership-numbers";
import { done, is } from "./check";
const handles = new Set(["reviewsub"]);
const base = { id: "sub_review1", status: "active", currency: "usd", metadata: { store: "reviewsub", product: "club" } };
const good = { quantity: 1, price: { unit_amount: 1500, recurring: { interval: "month", interval_count: 1 } } };
function read(item: unknown): unknown {
  try {
    const sub = readSub({ ...base, items: { data: [item] } } as never, handles);
    return sub ? [sub.amount, sub.interval, sub.count] : null;
  } catch { return "unknown"; }
}
is("healthy parent control", read(good), [1500, "month", 1]);
is("zero quantity control", read({ ...good, quantity: 0 }), [0, "month", 1]);
is("malformed scalar quantity already rejected", read({ ...good, quantity: "1" }), "unknown");
is("price in text is unknown, not a free membership", read({ ...good, price: "broken" }), "unknown");
is("price as a list is unknown, not a free membership", read({ ...good, price: [] }), "unknown");
is("recurring in text is unknown, not monthly", read({ ...good, price: { ...good.price, recurring: "broken" } }), "unknown");
is("recurring as a list is unknown, not monthly", read({ ...good, price: { ...good.price, recurring: [] } }), "unknown");
done();
