/**
 * The creator's protections on a running campaign: 632 [AA2] (e), unit 4
 * (owner, 2 November 2026: "pausar, ajustar orçamento e encerrar em um
 * clique; aviso quando o gasto do dia passa do limite que o criador escolheu
 * e pausa automática opcional no limite; ... nada muda sem confirmação").
 * Pure rules on top of lib/ad-campaign-plan.ts; nothing calls a platform.
 *
 *   - A budget change is a new plan: what was already spent plus the worst
 *     case of the days left (the same confirmed ceilings) must stay inside the
 *     creator's own limit, and the new plan comes back PAUSED with its own
 *     maximum, so it needs the creator's confirmation like the first one.
 *   - The day's alert: when what the platform reports as spent today passes
 *     the amount the creator chose, they are told.
 *   - The automatic pause at the limit is optional and the creator's choice;
 *     it pauses once what was spent reaches the limit. Spend is reported late
 *     by the platforms, which is why every plan is already sized so that its
 *     worst case never passes the limit: the pause is a second wall, not the
 *     only one.
 */
import { type CampaignPlan, MAX_DAILY_CENTS, worstCaseCents } from "@/lib/ad-campaign-plan";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayNumber = (date: string): number | null => {
  if (!DATE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? ms / 86_400_000 : null;
};

export type ChangeRefusal = "dates" | "ended" | "budget" | "spent" | "over_limit";

/**
 * A running plan with a new daily budget from `today` (inclusive) to its last
 * day, given what was spent so far; PAUSED until the creator confirms it.
 */
export function changeBudget(
  plan: CampaignPlan,
  newDailyCents: number,
  spentCents: number,
  today: string,
): { ok: true; plan: CampaignPlan } | { ok: false; error: ChangeRefusal; fix: string } {
  const from = dayNumber(today);
  const last = dayNumber(plan.end);
  const first = dayNumber(plan.start);
  if (from === null || last === null || first === null) return { ok: false, error: "dates", fix: "The dates could not be read." };
  if (from > last) return { ok: false, error: "ended", fix: "This campaign has ended; start a new one." };
  if (!Number.isSafeInteger(newDailyCents) || newDailyCents <= 0 || newDailyCents > MAX_DAILY_CENTS) return { ok: false, error: "budget", fix: "Choose a daily budget above zero." };
  if (!Number.isSafeInteger(spentCents) || spentCents < 0) return { ok: false, error: "spent", fix: "What was spent could not be read; try again once the platform reports it." };
  const start = Math.max(from, first);
  const left = last - start + 1;
  const maxSpendCents = spentCents + worstCaseCents(plan.platform, newDailyCents, start, left);
  if (maxSpendCents > plan.creatorTotalLimitCents) {
    return { ok: false, error: "over_limit", fix: "With what was already spent, the platform could pass your limit on its worst days: choose a lower daily budget or raise your limit." };
  }
  return { ok: true, plan: { ...plan, status: "PAUSED", dailyBudgetCents: newDailyCents, maxSpendCents } };
}

export type LimitState = {
  /** What was spent today passed the creator's chosen amount for a day. */
  alertToday: boolean;
  /** The creator chose the automatic pause, and the limit is reached. */
  pauseNow: boolean;
};

/** What the protections say about a running campaign, from what the platform reported. */
export function limitState(input: { spentTotalCents: number; spentTodayCents: number; creatorTotalLimitCents: number; dayAlertCents: number | null; autoPause: boolean }): LimitState {
  const total = Math.max(0, input.spentTotalCents);
  const today = Math.max(0, input.spentTodayCents);
  return {
    alertToday: input.dayAlertCents !== null && input.dayAlertCents > 0 && today > input.dayAlertCents,
    pauseNow: input.autoPause && total >= input.creatorTotalLimitCents,
  };
}
