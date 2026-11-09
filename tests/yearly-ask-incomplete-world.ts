/** The yearly-offer boundaries of tests/yearly-ask-read-world.ts, with one store listed and a reading that may not finish (audit A4). */
import { owner, runningMembers as oneMember } from "./yearly-ask-read-world";
import type { Store } from "@/lib/store";

export * from "./yearly-ask-read-world";
export const reading = { complete: true };
export async function runningMembers() {
  return { ...(await oneMember()), complete: reading.complete };
}
export async function storesAfter(): Promise<{ stores: Store[]; next: string }> {
  return { stores: [owner], next: "0" };
}
