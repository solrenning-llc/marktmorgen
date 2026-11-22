/**
 * The saved-configuration checks of one page funnel (lib/funnel-launch-review.ts,
 * lib/funnel-form-review.ts, lib/funnel-offer-review.ts), worked out the same way
 * for the studio's funnels page and for the AI explanation of a check
 * (lib/funnel-explain.ts). The checks are fixed code: they decide whether a
 * funnel has something to review. An explanation is asked only for a check
 * this file finds on the server, never for one the browser describes.
 */
import { cachedOfferListings, savedOfferIssues } from "@/lib/funnel-offer-review";
import { readFunnelFormReviews } from "@/lib/funnel-form-review";
import { funnelLaunchIssues, type FunnelLaunchIssue, type FunnelLaunchStep } from "@/lib/funnel-launch-review";
import type { PageFunnel } from "@/lib/page-funnel";
import { readPageFunnelsStrict, stepStates, type StepState } from "@/lib/page-funnel-store";
import { sellsThroughPayPal } from "@/lib/paypal-sales";
import type { Store } from "@/lib/store";
import { canSell } from "@/lib/store-checkout";

/** The checks a funnel's saved pages, forms and offers fail: the page reviews first, then each offer step's. */
export function funnelPageIssues(store: Store, formIssues: readonly FunnelLaunchIssue[], states: readonly StepState[] | null): FunnelLaunchIssue[] {
  const offerRecords = cachedOfferListings(store, (states ?? []).flatMap((state) => (state.reviewProduct ? [state.reviewProduct] : [])));
  return [
    ...formIssues,
    ...(states ?? []).flatMap((state, stepIndex) =>
      (state.reviewProduct ? savedOfferIssues(store, state.reviewProduct, offerRecords) : []).map((detail) => ({ code: "step" as const, title: `Step ${stepIndex + 1}: ${state.title}`, detail, stepIndex })),
    ),
  ];
}

/** Whether a paid step can be sold today, as the funnels page asks it. */
export const funnelPaymentsAvailable = (store: Store): boolean => canSell(store) || sellsThroughPayPal(store);

/** A step as the launch checks read it. */
export const launchStepOf = (state: StepState): FunnelLaunchStep => ({ title: state.title, open: state.open, why: state.why, product: state.step.kind === "product", free: state.free });

export type FunnelChecks = { funnel: PageFunnel; steps: FunnelLaunchStep[]; issues: FunnelLaunchIssue[] };

/**
 * One saved funnel's checks, read strictly: "gone" when the store has no such
 * funnel, "unknown" when anything it depends on could not be read, never a
 * shorter list than the funnels page would show.
 */
export async function readFunnelChecks(store: Store, funnelId: string): Promise<{ ok: true; checks: FunnelChecks } | { ok: false; reason: "gone" | "unknown" }> {
  if (!store.statsId) return { ok: false, reason: "unknown" };
  let funnel: PageFunnel | undefined;
  let states: StepState[];
  let formIssues: FunnelLaunchIssue[];
  try {
    const inventory = await readPageFunnelsStrict(store.statsId);
    funnel = inventory.find((saved) => saved.id === funnelId);
    if (!funnel) return { ok: false, reason: "gone" };
    const [read, reviews] = await Promise.all([
      stepStates(store, funnel, { strictProducts: true, includeReviewProduct: true }),
      readFunnelFormReviews(store, [funnel], { reviewOffers: true }),
    ]);
    states = read;
    formIssues = reviews.get(funnel.id) ?? [];
  } catch {
    return { ok: false, reason: "unknown" };
  }
  const steps = states.map(launchStepOf);
  const issues = [...funnelLaunchIssues(funnel.on, steps, funnelPaymentsAvailable(store)), ...funnelPageIssues(store, formIssues, states)];
  return { ok: true, checks: { funnel, steps, issues } };
}

/** The same check, field by field: a check the browser names is explained only when the server finds it unchanged. */
export function sameIssue(a: FunnelLaunchIssue, b: FunnelLaunchIssue): boolean {
  return a.code === b.code && a.title === b.title && a.detail === b.detail && a.stepIndex === b.stepIndex && a.formId === b.formId;
}

/** A check as the browser sends it back, read field by field; anything else is null. */
export function readIssue(value: unknown): FunnelLaunchIssue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const codes: readonly FunnelLaunchIssue["code"][] = ["disabled", "empty", "step", "payments", "payments_unknown", "form", "forms_unknown", "quiz_product", "quiz_unknown"];
  const code = codes.find((known) => known === record.code);
  if (!code || typeof record.title !== "string" || typeof record.detail !== "string") return null;
  if (record.title.length > 400 || record.detail.length > 1_000) return null;
  const issue: FunnelLaunchIssue = { code, title: record.title, detail: record.detail };
  if (record.stepIndex !== undefined) {
    if (!Number.isSafeInteger(record.stepIndex) || (record.stepIndex as number) < 0) return null;
    issue.stepIndex = record.stepIndex as number;
  }
  if (record.formId !== undefined) {
    if (typeof record.formId !== "string" || record.formId.length > 80) return null;
    issue.formId = record.formId;
  }
  return issue;
}
