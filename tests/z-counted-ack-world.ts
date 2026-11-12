/** Synthetic Redis transport; real counted helper, no provider. */
export * from './redis-stub';
import { redisPipeline as normal, store } from './redis-stub';
export const isAiBudgetConfigured = () => true;
export const reserveAiSpend = async () => { throw new Error('Provider calls are outside this proof'); };
export const aiBudgetScopeFor = () => 'creator' as const;
let injected: unknown[] | undefined;
let substitute = false;
export const calls: (string | number)[][] = [];
export function reset(reply?: unknown[]) { store.clear(); calls.length=0; injected=reply; substitute=arguments.length>0; }
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
 calls.push(...commands);
 // Malformed replies do not apply the reservation; healthy controls use MemoryRedis.
 if(substitute && ['INCRBY','GET'].includes(String(commands[0]?.[0]))) return injected!;
 return normal(commands);
}
