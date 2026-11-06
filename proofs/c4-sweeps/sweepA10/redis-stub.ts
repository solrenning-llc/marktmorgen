// Scripted Redis: each pipeline gets its replies from `script(commands)`; every command is logged.
export const log: unknown[][] = [];
export let script: (commands: unknown[][]) => unknown[] = (c) => c.map(() => null);
export function setScript(s: (commands: unknown[][]) => unknown[]) { script = s; }
export function isRedisConfigured() { return true; }
export async function redisPipeline(commands: unknown[][]): Promise<unknown[]> { log.push(...commands); return script(commands); }
export async function redisPipelineBase64(commands: unknown[][]): Promise<unknown[]> { log.push(...commands); return script(commands); }
