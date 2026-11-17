import { REFUND_HISTORY_LIST, historyFrom } from "@/lib/buyer-history";
import { done, is, part } from "./check";

const email = "buyer@example.com";
const handles = new Set(["fixture"]);
const session = (index: number) => ({
  id: `cs_fixture${index}`,
  status: "complete",
  customer_details: { email },
  metadata: { store: "fixture" },
  mode: "payment",
  payment_status: "paid",
  payment_intent: {
    latest_charge: { refunded: false, disputed: false, amount_refunded: 0 },
  },
});
const outcome = (page: unknown) => historyFrom(handles, [page], email);
const rows = Array.from({ length: REFUND_HISTORY_LIST }, (_, index) => session(index));

part("Refund history requires a recognizable, bounded page");
is("a reply missing the list discriminator is unknown", outcome({ data: [], has_more: false }).state, "unknown");
is("a reply with another object type is unknown", outcome({ object: "checkout.session", data: [session(0)], has_more: false }).state, "unknown");
is("an overfull page is unknown", outcome({ object: "list", data: [...rows, session(rows.length)], has_more: false }).state, "unknown");
is("an empty page claiming more results is unknown", outcome({ object: "list", data: [], has_more: true }).state, "unknown");

const complete = outcome({ object: "list", data: rows, has_more: false });
is("a page exactly at the requested size is counted", complete.state === "known" && complete.checked, REFUND_HISTORY_LIST);
const partial = outcome({ object: "list", data: rows, has_more: true });
is("a nonempty partial page is marked incomplete", partial.state === "known" && partial.more, true);
const absent = outcome({ object: "list", data: [], has_more: false });
is("a confirmed empty result is still a known zero", absent.state === "known" && absent.checked, 0);
done();
