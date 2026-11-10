/** A bounded, provider-free world for the existing daily cursor reader. */
export const world: {
  saved: unknown;
  commands: (string | number)[][];
  walks: string[];
} = { saved: null, commands: [], walks: [] };

export const isRedisConfigured = () => true;
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  if (world.commands.length + commands.length > 200) throw new Error("Synthetic Redis command ceiling");
  world.commands.push(...commands);
  if (commands.length !== 1 || commands[0][1] !== "nl:verified:cursor") throw new Error("Unexpected test command");
  if (commands[0][0] === "GET") return [world.saved];
  if (commands[0][0] === "SET") return ["OK"];
  throw new Error("Unexpected test operation");
}
export async function storesAfter(cursor: string): Promise<{ stores: never[]; next: string }> {
  if (world.walks.length >= 20) throw new Error("Synthetic walk ceiling");
  world.walks.push(cursor);
  return { stores: [], next: "0" };
}
export async function readFullNumbers(): Promise<never> { throw new Error("No store should be refreshed in this test"); }
export async function readTitles(): Promise<never> { throw new Error("No product should be read in this test"); }
