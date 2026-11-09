import { after } from "next/server";

/**
 * Runs `task` after the answer is sent, when there is a request to answer
 * (next/server after()), so the answer takes the same time whatever the task
 * finds or sends: a reply that waited for an email only for a customer would
 * tell, by its time alone, who is one (Claude 5's authentication audit, L1).
 * Outside a request (a scheduled job, a check) there is nothing to answer
 * first, so it runs now. Either way a failure is logged under `what`, never
 * thrown: the caller has already answered the same for everyone.
 */
export function afterAnswer(task: () => Promise<unknown>, what: string): Promise<void> {
  const logged = (error: unknown) => console.error(`${what} failed`, error);
  try {
    after(() => task().catch(logged));
    return Promise.resolve();
  } catch {
    return task().then(() => undefined, logged);
  }
}
