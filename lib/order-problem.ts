import type { Store } from "@/lib/store";
export const ORDER_PROBLEM_PENDING_SECONDS = 300;
export const orderProblemKey = (sid: string, reference: string) => `nl:oprob:${sid}:${reference}`;
export async function reportOrderProblem(store: Store, purchase: unknown, email: string, problem: unknown, nowMs = 0): Promise<string> { void store; void purchase; void email; void problem; void nowMs; return "error"; }
