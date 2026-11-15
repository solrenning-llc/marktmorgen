import { FUNNEL_ID, parsePageFunnels, readFunnelInput, sameSteps, type PageFunnelStep } from "@/lib/page-funnel";

export type FunnelMutation =
  | { action: "remove"; id: string }
  | { funnel: { id?: string; name: string; slug: string; on: boolean; steps: PageFunnelStep[] } };

export type FunnelMutationResult =
  | { state: "confirmed" }
  | { state: "rejected"; error: string }
  | { state: "uncertain" };

const REFUSALS = new Set(["name", "slug", "taken", "steps", "split", "branch", "full", "page", "gone", "call", "unknown", "role", "locked", "store_gone", "forbidden", "slow_down"]);

/** A failed transport or incomplete acknowledgement must never invite a blind repeat. */
export function readFunnelMutationResult(status: number, raw: unknown, request: FunnelMutation): FunnelMutationResult {
  const uncertain: FunnelMutationResult = { state: "uncertain" };
  if (!Number.isInteger(status) || status < 100 || status > 599) return uncertain;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return uncertain;
  const value = raw as Record<string, unknown>;
  if (status >= 400 && status < 500 && value.ok === false && typeof value.error === "string" && REFUSALS.has(value.error)) {
    return { state: "rejected", error: value.error };
  }
  if (status < 200 || status >= 300 || value.ok !== true || "error" in value) return uncertain;
  if ("action" in request) return FUNNEL_ID.test(request.id) ? { state: "confirmed" } : uncertain;
  if (!value.funnel || typeof value.funnel !== "object" || Array.isArray(value.funnel)) return uncertain;
  const supplied = value.funnel as Record<string, unknown>;
  const kept = parsePageFunnels([supplied])[0];
  const expected = readFunnelInput(request.funnel, [], 1);
  if (!kept || !expected.ok || typeof supplied.on !== "boolean" || !Number.isSafeInteger(supplied.since) || (supplied.since as number) <= 0) return uncertain;
  if (request.funnel.id && kept.id !== request.funnel.id) return uncertain;
  if (!Array.isArray(supplied.steps) || supplied.steps.length !== kept.steps.length) return uncertain;
  // A split test sent without an id is given one by the server: only that id is taken from the answer.
  const sent = request.funnel.steps as unknown[];
  const steps = expected.funnel.steps.map((step, i) => {
    const asked = sent[i] as { id?: unknown } | undefined;
    const answer = kept.steps[i];
    const minted = (step.kind === "split" || step.kind === "branch") && answer?.kind === step.kind && asked?.id === undefined;
    return minted ? { ...step, id: answer.id } : step;
  });
  if (kept.name !== expected.funnel.name || kept.slug !== expected.funnel.slug || kept.on !== expected.funnel.on || !sameSteps(kept.steps, steps)) return uncertain;
  return { state: "confirmed" };
}
