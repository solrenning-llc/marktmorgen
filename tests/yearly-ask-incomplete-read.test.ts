/**
 * Audit A4: the daily yearly-offer run does not take the running members it
 * read for all of them. A store whose memberships did not fit one reading is
 * counted and named in the log; the members that were read still get theirs.
 */
import { sendYearlyAsks } from "@/lib/yearly-ask";
import { fixture, reading, reset } from "./yearly-ask-incomplete-world";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

  part("A reading that did not finish is said (A4)");
  reset(); reading.complete = false;
  const cut = await sendYearlyAsks(Date.now() + 20_000);
  is("the store is counted as not fully read; the member read still gets the offer",
    [cut.stores, cut.sent, (cut as { incomplete?: unknown }).incomplete, fixture.mails], [1, 1, 1, 1]);
  is("and the log names the store", errors.some((line) => line.includes("syntheticyearly") && /not read/.test(line)), true);

  part("A complete reading counts none");
  reset(); reading.complete = true; errors.length = 0;
  const whole = await sendYearlyAsks(Date.now() + 20_000);
  is("nothing counted, nothing logged", [whole.stores, whole.sent, (whole as { incomplete?: unknown }).incomplete, errors.length], [1, 1, 0, 0]);

  console.error = originalError;
  done();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
