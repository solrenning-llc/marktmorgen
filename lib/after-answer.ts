/**
 * Work a "send me a link" form leaves for after its answer: whether the
 * address holds what it asks about, the link made, and its email. Run after
 * the answer is sent, inside the route's own time (Next's `after`), so the
 * answer is the same, and just as quick, for an address that holds the thing
 * and one that does not: neither its words nor its time tell them apart. At
 * once, unwaited, when there is no request to wait for. What fails goes only
 * to the server's log, since saying it would tell who bought what.
 *
 * The same shape as lib/buyer-orders.ts and lib/letter-access.ts.
 */
import { after } from "next/server";

export function afterAnswer(what: string, task: () => Promise<void>): void {
  const run = () =>
    task().catch((error) => {
      console.error(`${what} failed`, error);
    });
  try {
    after(run);
  } catch {
    void run();
  }
}
