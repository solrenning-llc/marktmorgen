import type { Agreement } from "@/lib/agreement-rules";

export const state = { attempts: 0, agreement: null as Agreement | null };
export async function sendEmail() { state.attempts += 1; return false; }
export function fromStore() { return "Sample <noreply@example.test>"; }
export function storeBase() { return "https://example.test/@sample"; }
export async function agreementOf() { return state.agreement; }
export async function readVersion() { return null; }
export async function changeAgreement(_store: unknown, _id: string, change: (current: Agreement) => Agreement) {
  if (!state.agreement) throw new Error("Missing synthetic record");
  state.agreement = change(state.agreement);
  return state.agreement;
}
