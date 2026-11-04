export const world: { configured: boolean; throws: boolean; results: unknown[]; reads: number; folder: string } = { configured: true, throws: false, results: [[null, null]], reads: 0, folder: 'a'.repeat(32) };
export const isRedisConfigured = () => world.configured;
export async function redisPipeline(commands: unknown): Promise<unknown[]> {
  // The request a page is, counted in its store's window (lib/traffic.ts): one, always under the figure here.
  const first = Array.isArray(commands) && Array.isArray(commands[0]) ? commands[0][0] : null;
  if (first === 'INCR' || first === 'INCRBY' || first === 'EXPIRE') { if (world.throws) throw Error('unavailable'); return [1]; }
  world.reads++; if(world.throws)throw Error('unavailable'); return world.results;
}
export const storeRef = (_store: unknown) => 'synthetic-owner';
export const saleHandles = (store: { handle?: string }) => new Set([store.handle ?? '']);
export const storeFolder = async (_ref: string) => world.folder;
export const rememberFolderOwner = async (..._args: unknown[]) => {};
export const deriveKey = (_name: string) => null;
export const monthKey = (date = new Date()) => date.toISOString().slice(0,7);
