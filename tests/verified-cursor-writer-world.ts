/** A bounded, provider-free world whose store scan answers a chosen next cursor. */
export const world: {
  next: string;
  delayMs: number;
  commands: (string | number)[][];
  walks: string[];
} = { next: "0", delayMs: 0, commands: [], walks: [] };
let usedCommands = 0;
let usedWalks = 0;

export const isRedisConfigured = () => true;
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  usedCommands += commands.length;
  if (usedCommands > 200) throw new Error("Synthetic Redis command ceiling");
  world.commands.push(...commands);
  if (commands.length !== 1 || commands[0][1] !== "nl:verified:cursor") throw new Error("Unexpected test command");
  if (commands[0][0] === "GET") return [null];
  if (commands[0][0] === "SET") return ["OK"];
  throw new Error("Unexpected test operation");
}
export async function storesAfter(cursor: string): Promise<{ stores: never[]; next: string }> {
  if (++usedWalks > 40) throw new Error("Synthetic walk ceiling");
  world.walks.push(cursor);
  await new Promise((resolve) => setTimeout(resolve, world.delayMs));
  return { stores: [], next: world.next };
}
// The shared numbers are read from the studio's kept readings since row 139 of #5010 (lib/store-readings.ts).
export async function keptStats(): Promise<never> { throw new Error("No store should be refreshed in this test"); }
export async function keptSales(): Promise<never> { throw new Error("No store should be refreshed in this test"); }
export async function statsCopy(): Promise<never> { throw new Error("No store should be refreshed in this test"); }
export async function salesCopy(): Promise<never> { throw new Error("No store should be refreshed in this test"); }
export function readsSales(): never { throw new Error("No store should be refreshed in this test"); }
export function studioStats(): never { throw new Error("No store should be refreshed in this test"); }
export function productsInStats(): never { throw new Error("No store should be refreshed in this test"); }
export async function readStats(): Promise<never> { throw new Error("No store should be refreshed in this test"); }
export async function readSales(): Promise<never> { throw new Error("No store should be refreshed in this test"); }
export async function readTitles(): Promise<never> { throw new Error("No product should be read in this test"); }
