/** lib/calendar-sync.ts as it is, with readFeed replaced so a test can run code while a host's reading is in flight. */
export * from "../lib/calendar-sync";
export const state: { during: () => Promise<void>; now: number; reads: number } = { during: async () => {}, now: 1_800_000_000_000, reads: 0 };
export async function readFeed() {
  state.reads += 1;
  await state.during();
  return { busy: [[state.now + 60_000, state.now + 120_000]] as [number, number][] };
}
