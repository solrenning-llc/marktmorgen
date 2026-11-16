export const world: { configured: boolean; throws: boolean; results: unknown[]; reads: number; folder: string } = { configured: true, throws: false, results: [[null, null]], reads: 0, folder: 'a'.repeat(32) };
export const isRedisConfigured = () => world.configured;
export async function redisPipeline(commands: unknown): Promise<unknown[]> {
  // The request a page is, counted in its store's window (lib/traffic.ts): one, always under the figure here.
  const first = Array.isArray(commands) && Array.isArray(commands[0]) ? commands[0][0] : null;
  if (first === 'INCR' || first === 'INCRBY' || first === 'EXPIRE') { if (world.throws) throw Error('unavailable'); return [1]; }
  world.reads++; if(world.throws)throw Error('unavailable'); return world.results;
}
export const storeRef = (_store: unknown) => 'synthetic-owner';
export const storeFolder = async (_ref: string) => world.folder;
export const rememberFolderOwner = async (..._args: unknown[]) => {};
export const deriveKey = (_name: string) => null;
export const monthKey = (date = new Date()) => date.toISOString().slice(0,7);
// The spike alarm lib/traffic.ts calls after each count (lib/traffic-spike.ts) loads the email and house-store
// modules, which import names this world does not stand in for; it is aliased here instead (tests/aliases), and it
// never alerts: this test counts admissions, and an alarm changes no count (Claude 4 on #3380, 6919548809).
export const alertSpike = async () => false;
