// The refund review page's one-time pass (lib/plan-refund-flow.ts, issueReview
// and takeReview). Opening the review page again issues a new pass and makes the
// old tab's pass worthless; an old tab submitted afterwards must be refused
// without taking the pass of the page the creator is looking at now, so that
// page's button still refunds once. Synthetic only: the in-memory Redis stub.
import "./redis-stub";
import { issueReview, takeReview } from "@/lib/plan-refund-flow";
import { done, is, part } from "./check";

async function main() {
  part("An old tab's pass never takes the current page's");
  const sid = "stale-tab-sid";
  const old = await issueReview(sid, 4_200);
  const current = await issueReview(sid, 6_900);
  is("the old tab is refused", await takeReview(sid, old), null);
  is("the current page still takes its own pass, once, for the amount it showed", await takeReview(sid, current), 6_900);
  is("and only once", await takeReview(sid, current), null);
  part("A malformed token takes nothing either");
  const again = await issueReview(sid, 1_000);
  is("a token that is not one of ours is refused", await takeReview(sid, "x".repeat(25)), null);
  is("the page's own pass is still there", await takeReview(sid, again), 1_000);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
