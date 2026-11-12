/**
 * 232 [CA1], the original unit 4c (the remaining scope recorded on 11/11/2026):
 * what still ran on Store's figures for a store nobody pays for.
 *
 *   - the creator's page photo had no pause: a new one is refused while the
 *     plan's renewal is unpaid or a payment for it is disputed, and once the
 *     plan has ended; taking the photo off stays open;
 *   - a store whose plan has ended still took a buyer's new review photo
 *     (held in tests/review-photo-paused.test.ts, which runs the review
 *     route with its request scope);
 *   - a store whose plan has ended still imported on Store's figures: no
 *     import or funnel migration starts, checks or moves on.
 *
 * A store that never had a plan is not refused: setting up is what its own
 * room is for. Real code over the in-memory Redis stub; synthetic data only.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as photoRoute } from "@/app/api/store/photo/route";
import { POST as importRoute } from "@/app/api/store/import/route";
import { POST as funnelRoute } from "@/app/api/store/import/funnel/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, recordPlanDispute, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { newCostCode, type PlanFields } from "@/lib/plan-standing";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { FUNNEL_PAUSED, IMPORTS_PAUSED } from "@/lib/import-limits";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "plan-ended-costs@example.test";
const HANDLE = "plan-ended-costs";
const NOW = 1_800_000_000;

/** A PNG's signature and a few synthetic bytes: what the page photo accepts. */
const PNG64 = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])).toString("base64");
const plan = (over: Partial<PlanFields>): PlanFields => ({ subscriptionActive: false, subscriptionId: null, trialEnds: 0, planEndedAt: "", ...over });

async function main() {
  part("The rule: who is refused new work that costs us");
  is("a store that never had a plan sets up freely", newCostCode(plan({}), NOW), null);
  is("a paid plan", newCostCode(plan({ subscriptionActive: true, subscriptionId: "sub_x" }), NOW), null);
  is("a trial", newCostCode(plan({ subscriptionActive: true, subscriptionId: "sub_x", trialEnds: NOW + 86_400 }), NOW), null);
  is("a renewal unpaid", newCostCode(plan({ subscriptionActive: true, subscriptionId: "sub_x", renewalUnpaidSince: NOW - 60 }), NOW), "renewal_unpaid");
  is("a plan payment disputed", newCostCode(plan({ subscriptionActive: true, subscriptionId: "sub_x", planDisputes: [{ id: "du_x", status: "open", at: NOW - 60, coversUntil: NOW + 86_400 }] }), NOW), "plan_disputed");
  is("a plan that ended, with its day written down", newCostCode(plan({ subscriptionId: "sub_x", planEndedAt: "2026-11-01" }), NOW), "plan_ended");
  is("a plan that ended without its day written down", newCostCode(plan({ subscriptionId: "sub_x" }), NOW), "plan_ended");

  redis.clear();
  await claimHandle(OWNER, HANDLE, "Plan Ended Shop", "");
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: "https://marktmorgen.com", host: "marktmorgen.com" };
  const json = async (route: (r: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>) => {
    const r = await route(new NextRequest(`https://marktmorgen.com${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const photo = (body: Record<string, unknown>) => json(photoRoute, "/api/store/photo", body);

  part("A store with no plan sets up: its page photo goes on");
  const first = await photo({ photo: PNG64 });
  is("the photo is saved", first.body.ok, true);
  const firstId = first.body.photoId as string;

  part("Renewal unpaid: a new page photo waits");
  await setSubscription(OWNER, { customerId: "cus_PlanEndedCost", subscriptionId: "sub_PlanEndedCost", active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
  const unpaid = await photo({ photo: PNG64 });
  is("refused with the renewal's word", [unpaid.status, unpaid.body.error], [409, "renewal_unpaid"]);
  is("the page still points at the photo it had", (await storeForEmail(OWNER))?.photoId, firstId);

  part("Disputed: the same");
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
  const paidUp = await photo({ photo: PNG64 });
  is("paid up, a new photo goes on", paidUp.body.ok, true);
  const disputed = await recordPlanDispute(storeRef((await storeForEmail(OWNER))!), { id: "du_PlanEndedCost01", status: "open", at: Math.floor(Date.now() / 1000), coversUntil: Math.floor(Date.now() / 1000) + 30 * 86_400 });
  is("the dispute is written down", Boolean(disputed), true);
  is("a new photo is refused with the dispute's word", (await photo({ photo: PNG64 })).body.error, "plan_disputed");

  part("The plan ends: a new page photo waits and nothing imports");
  await setSubscription(OWNER, { active: false, period: null });
  const ended = (await storeForEmail(OWNER))!;
  is("the store's plan has ended", newCostCode(ended), "plan_ended");
  const pagePhoto = await photo({ photo: PNG64 });
  is("a new page photo is refused", [pagePhoto.status, pagePhoto.body.error], [409, "plan_ended"]);
  is("the studio has words for it", typeof STUDIO_MESSAGES.plan_ended, "string");

  for (const action of ["start", "preview", "step"]) {
    const r = await json(importRoute, "/api/store/import", { action, kind: "contacts", id: "imp_synthetic000001" });
    is(`an import "${action}" is refused`, [r.status, r.body.error], [409, "plan_ended"]);
  }
  const funnel = await json(funnelRoute, "/api/store/import/funnel", { action: "page", html: "<html><body>Synthetic</body></html>", file: "a.html" });
  is("a funnel migration is refused", [funnel.status, funnel.body.error], [409, "plan_ended"]);
  is("the import page has words for it", IMPORTS_PAUSED.plan_ended.startsWith("Your plan has ended, so imports are paused."), true);
  is("and the funnel page", FUNNEL_PAUSED.plan_ended.startsWith("Your plan has ended, so funnel imports are paused."), true);

  part("Taking the page photo off stays open once the plan has ended");
  const removed = await photo({ remove: true });
  is("removed", [removed.body.ok, removed.body.photoId], [true, null]);

  part("What the studio and the Terms say matches what the code does");
  const where = "Check your studio's main page for your store's closing date.";
  is("each message points at where the closing date is shown", [STUDIO_MESSAGES.plan_ended, IMPORTS_PAUSED.plan_ended, FUNNEL_PAUSED.plan_ended].every((m) => m.includes(where)), true);
  const studio = readFileSync("app/studio/page.tsx", "utf8");
  is("the studio's main page does show it", studio.includes("Your plan has ended, and your store closes on ${dayWords(closing.day)}"), true);
  const terms = readFileSync("app/terms/page.tsx", "utf8").replace(/\s+/g, " ");
  is("the Terms say what waits for a plan", terms.includes("imports from other platforms, a new photo on the store&rsquo;s page and buyers&rsquo; new review photos wait for a plan, and a review&rsquo;s words are still saved."), true);
  const tool = readFileSync("components/import-tool.tsx", "utf8");
  is("the import page keeps showing the pause while a running import is stepped", tool.includes('data.error === "plan_ended"'), true);

  done();
}

main();
