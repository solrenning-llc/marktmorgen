/**
 * next/server for tests/studio-today-trips.test.ts: everything from Next's own, except after(), which outside
 * Next has no response to run after. The page's loading is what is measured; what it leaves for later is not run.
 */
export * from "../node_modules/next/server.js";
export function after(task: unknown): void {
  void task;
}
