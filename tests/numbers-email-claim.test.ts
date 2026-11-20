import { NextRequest } from "next/server";
import { GET as weekly } from "@/app/api/cron/weekly/route";
import { GET as monthly } from "@/app/api/cron/monthly/route";
import { control } from "./numbers-email-claim-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// Rule 24 (CX-123) on the numbers-email crons: a store's week or month is claimed before anything is read, so
// a read that fails after the claim must let the claim go (as the monthly route already did for its numbers),
// and a read whose answer decides what is sent must be known before the claim is taken. Otherwise a creator
// silently misses that week's email (counted as "quiet"), or gets the email with the channel post they chose
// dropped for the whole week. Synthetic stores, stubbed sender and stats; no network.

const oldPipeline = redis.pipeline.bind(redis);
const commands: (string | number)[][] = [];
let failChatRead = false;
const request = (path: string) => new NextRequest(`https://example.test${path}`);

function reset(): void {
  redis.clear();
  commands.length = 0;
  control.sent.length = 0;
  control.numbers = "visitors-0";
  failChatRead = false;
}

/** The claim key this run tried to take (SET … NX on the sent key), and whether it is held now. */
function claim(prefix: string): { tried: boolean; held: boolean } {
  const set = commands.find((c) => c[0] === "SET" && String(c[1]).startsWith(prefix) && c.includes("NX"));
  if (!set) return { tried: false, held: false };
  return { tried: true, held: redis.run(["GET", String(set[1])]) !== null };
}

async function main(): Promise<void> {
  globalThis.fetch = async () => { throw new Error("No real network request belongs in a numbers-email route test"); };
  redis.pipeline = async (batch) => {
    commands.push(...batch.map((c) => [...c]));
    if (failChatRead && batch.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:chatsum:"))) {
      throw new Error("synthetic chat address read failure");
    }
    return oldPipeline(batch);
  };

  part("Weekly: a week with no visitors, read exactly, is quiet and stays claimed (control)");
  reset();
  let body = await (await weekly(request("/api/cron/weekly"))).json();
  is("quiet, nothing failed, nothing sent", [body.ok, body.quiet, body.failed, control.sent.length], [true, 1, 0, 0]);
  is("the week stays claimed, so nobody gets two", claim("nl:weekly:sent:"), { tried: true, held: true });

  for (const numbers of ["unknown", "throws"] as const) {
    part(`Weekly: numbers that could not be read (${numbers}) let the week go, never 'quiet'`);
    reset();
    control.numbers = numbers;
    body = await (await weekly(request("/api/cron/weekly"))).json();
    is("counted as failed, not as a quiet week", [body.ok, body.quiet, body.failed, control.sent.length], [true, 0, 1, 0]);
    is("the week's claim is let go, so a later run tries again", claim("nl:weekly:sent:"), { tried: true, held: false });
    control.numbers = "visitors-0";
    commands.length = 0;
    body = await (await weekly(request("/api/cron/weekly"))).json();
    is("the next run reads the numbers and claims the week", [body.quiet, claim("nl:weekly:sent:")], [1, { tried: true, held: true }]);
  }

  part("Weekly: a week with visitors is emailed once and stays claimed (control)");
  reset();
  control.numbers = "visitors-5";
  body = await (await weekly(request("/api/cron/weekly"))).json();
  is("one email, nothing failed", [body.ok, body.sent, body.failed, control.sent.map((m) => m.to)], [true, 1, 0, ["owner@example.test"]]);
  is("claimed for the week", claim("nl:weekly:sent:"), { tried: true, held: true });

  part("Weekly: an unreadable channel address takes no claim and sends nothing this run");
  reset();
  control.numbers = "visitors-5";
  failChatRead = true;
  body = await (await weekly(request("/api/cron/weekly"))).json();
  is("counted as failed; no email went without the channel post", [body.ok, body.failed, body.sent, control.sent.length], [true, 1, 0, 0]);
  is("the week is not claimed, so a later run sends both", claim("nl:weekly:sent:").tried, false);

  part("Monthly: unread numbers still let the month go (control)");
  reset();
  control.numbers = "unknown";
  body = await (await monthly(request("/api/cron/monthly"))).json();
  is("failed, claim let go", [body.ok, body.failed, claim("nl:monthly:sent:")], [true, 1, { tried: true, held: false }]);

  part("Monthly: a month with visitors is emailed once and stays claimed (control)");
  reset();
  control.numbers = "visitors-5";
  body = await (await monthly(request("/api/cron/monthly"))).json();
  is("one email, nothing failed", [body.ok, body.sent, body.failed, control.sent.map((m) => m.to)], [true, 1, 0, ["owner@example.test"]]);
  is("claimed for the month", claim("nl:monthly:sent:"), { tried: true, held: true });

  part("Monthly: an unreadable channel address takes no claim and sends nothing this run");
  reset();
  control.numbers = "visitors-5";
  failChatRead = true;
  body = await (await monthly(request("/api/cron/monthly"))).json();
  is("counted as failed; no email went without the channel post", [body.ok, body.failed, body.sent, control.sent.length], [true, 1, 0, 0]);
  is("the month is not claimed, so a later run sends both", claim("nl:monthly:sent:").tried, false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
