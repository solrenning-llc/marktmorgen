/**
 * A member price never lowers the price of the very product that qualifies for it.
 *
 * Found by two auditors of the triple audit, 3rd batch (coordinator C1-20261122-0003-TODOS-7, comment 7073298184),
 * in main's code that #2999 shipped (lib/member-price-rules.ts memberOffFrom): a rule "whoever bought the guide pays
 * 20% less on every product" also took 20% off the guide itself, for a buyer who already held it and bought it again.
 * The studio check on #3026 refuses the same product on both sides of a list, but an "every product" rule, and a rule
 * saved before that check, still reached the checkout.
 *
 * The rule now: a qualifying product never qualifies for itself; another product the buyer holds still does.
 *
 * Synthetic only.
 */
import { memberOffFrom, parseMemberPrices, qualifyingFor } from "@/lib/member-price-rules";
import { done, is, part } from "./check";

const candidate = (over: Record<string, unknown> = {}) => ({ id: "p1", priceCents: 2700, recurring: null, call: null, pwyw: null, options: [], ...over });

async function main(): Promise<void> {
  part("An 'every product' rule never lowers the product that qualifies for it");
  const every = parseMemberPrices({ on: true, rules: [{ id: "buyers", percent: 20, by: ["guide"], all: true, products: [] }] });
  const guide = candidate({ id: "guide" });
  is("the guide's holder buying the guide again pays the full price", memberOffFrom(every, guide, new Set(["guide"]), 50), 0);
  is("  and the page reads nothing for it, since nothing can qualify", qualifyingFor(every, guide), []);
  is("the guide's holder still pays 20% less on another product", memberOffFrom(every, candidate({ id: "course" }), new Set(["guide"]), 50), 20);

  part("A list rule naming the same product on both sides does the same");
  const listed = parseMemberPrices({ on: true, rules: [{ id: "pair", percent: 30, by: ["guide", "kit"], all: false, products: ["guide", "kit"] }] });
  is("the guide's holder pays the full price for the guide", memberOffFrom(listed, guide, new Set(["guide"]), 50), 0);
  is("  but the kit's holder pays 30% less on the guide", memberOffFrom(listed, guide, new Set(["kit"]), 50), 30);
  is("  and only the kit is read for the guide", qualifyingFor(listed, guide), ["kit"]);

  part("Two rules: the larger one that another product meets");
  const two = parseMemberPrices({
    on: true,
    rules: [
      { id: "self", percent: 40, by: ["guide"], all: true, products: [] },
      { id: "club", percent: 15, by: ["kit"], all: true, products: [] },
    ],
  });
  is("holding the guide and the kit, the guide costs 15% less, never 40%", memberOffFrom(two, guide, new Set(["guide", "kit"]), 50), 15);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
