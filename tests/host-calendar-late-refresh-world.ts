export * from "../lib/calendar-sync";
export const state: { during: () => Promise<void>; fails: boolean; now: number } = { during: async () => {}, fails: false, now: 1_800_000_000_000 };
export async function readFeed() {
  await state.during();
  if (state.fails) throw new Error("Synthetic private calendar unavailable");
  return { busy: [[state.now + 60_000, state.now + 120_000]] as [number, number][] };
}
