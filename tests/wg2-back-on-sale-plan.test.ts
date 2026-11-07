/**
 * 642 [WG2], Claude 5's MEDIUM on #2690: putting a price back on sale when the
 * payment plan has no payment for it pauses the plan for every price
 * (planState answers "options"), and the editor did it at one click, with no
 * word at that moment. Removing a price already warns (planBefore/planAfter);
 * putting one back must do the same before it acts.
 *
 *   - planPausedByRestore reads the plan by the real rule (activePlan), with
 *     and without the price back on sale: true only when a plan offered now
 *     stops being offered;
 *   - the studio's "Put back on sale" asks first in that case, and acts at
 *     once otherwise.
 */
import { readFileSync } from "node:fs";
import { activePlan, planPausedByRestore } from "@/lib/product-extras";
import type { ProductOption } from "@/lib/product-option";
import type { Listing } from "@/lib/store";
import { done, is, part } from "./check";

const option = (over: Partial<ProductOption>): ProductOption => ({ id: "o1", label: "Basic", priceCents: 1000, file: null, link: "https://example.com/a", details: [], best: false, ...over });
const base = { priceCents: 3000, file: null, link: null, recurring: null, call: null, pwyw: false, keys: null, stock: null } as const;

part("The rule: true only when a plan offered now stops being offered");
const uncovered = { ...base, options: [option({ id: "p1", priceCents: 3000, offSale: true }), option({ id: "p2", label: "Plus", priceCents: 3000 })], plan: { payments: 3, interval: "month", amountCents: 1000, options: { p2: 1000 } } } as unknown as Listing;
is("the plan is offered now", activePlan(uncovered) !== null, true);
is("back on sale with no payment set for it: the plan stops", planPausedByRestore(uncovered, "p1"), true);
const covered = { ...uncovered, plan: { ...uncovered.plan!, options: { p1: 1000, p2: 1000 } } } as Listing;
is("back on sale with its payment set: the plan goes on", planPausedByRestore(covered, "p1"), false);
const short = { ...uncovered, plan: { ...uncovered.plan!, options: { p1: 500, p2: 1000 } } } as Listing;
is("back on sale with a payment that falls short: the plan stops", planPausedByRestore(short, "p1"), true);
const noPlan = { ...uncovered, plan: null } as unknown as Listing;
is("no plan: nothing to stop", planPausedByRestore(noPlan, "p1"), false);
const pausedAlready = { ...uncovered, options: uncovered.options.map((o) => ({ ...o, offSale: true as const })) } as Listing;
is("a plan already paused is not stopped by it", [activePlan(pausedAlready), planPausedByRestore(pausedAlready, "p1")], [null, false]);
is("a price on sale already: nothing changes", planPausedByRestore(uncovered, "p2"), false);
is("an id that names no price: nothing changes", planPausedByRestore(uncovered, "nope"), false);

part("The studio asks before it pauses the plan");
const editor = readFileSync("components/product-editor.tsx", "utf8");
is("the editor reads the rule", /planPausedByRestore\(/.test(editor), true);
is("it offers a way to keep the price off sale", editor.includes("Keep it off sale"), true);
is("it says the plan will stop, and how to keep it", editor.replace(/\s+/g, " ").includes("so the payment plan will stop for every price. To keep it, first set a payment for this price in the payment plan."), true);
// Claude 1's LEVE on #2690: the route's planStopped false also means no plan at all, or one paused already, so the
// studio never tells the creator a payment plan goes on that it cannot see.
is("after the question, a price back on sale never says a payment plan goes on", editor.includes("The payment plan goes on."), false);
is("it acts at once when the plan goes on: the question is asked only on the rule", /if \(option\.offSale && planPausedByRestore\(product as Listing, option\.id\)\) \{\s*setRestoringId\(option\.id\);/.test(editor), true);
done();
