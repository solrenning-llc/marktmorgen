/**
 * Issue #3995 (Codex U): the monthly numbers email runs only on the 1st and the 2nd, and each run read only the month
 * just ended. A month whose whole two-day window was missed (the route down, or every run failing), or whose stores
 * the last runs of day 2 did not reach, was never sent: the next window read only the newer month. Each run now
 * reads the month before the last too, oldest first, in the same bounded batch; the month's claims (40 days) keep
 * anything already sent from going twice. Synthetic store, sender and stats; no network.
 */
import { NextRequest } from "next/server";
import { GET as monthly } from "@/app/api/cron/monthly/route";
import { control, seedMonthlyStore } from "./monthly-catch-up-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const request = () => new NextRequest("https://example.test/api/cron/monthly");
const realNow = Date.now;
const at = (iso: string) => {
  const ms = Date.parse(iso);
  Date.now = () => ms;
};
const subjects = () => control.sent.map((m) => m.subject);

function reset(): void {
  redis.clear();
  seedMonthlyStore();
  control.sent.length = 0;
  control.folders = { "2026-12": ["fixture-store"], "2027-01": ["fixture-store"] };
  control.visitors = { "2026-12": 4, "2027-01": 6 };
}

async function main(): Promise<void> {
  globalThis.fetch = async () => { throw new Error("No real network request belongs in this test"); };

  part("December's whole window was missed: the 1st of February sends December, then January");
  reset();
  at("2027-02-01T00:25:00Z");
  const body = await (await monthly(request())).json();
  is("both months sent, the older first", [body.ok, subjects()], [true, ["Fixture Store in December 2026", "Fixture Store in January 2027"]]);
  await monthly(request());
  is("a later run of the same window sends nothing twice", subjects().length, 2);

  part("December was sent in its own window: February sends only January");
  reset();
  at("2027-01-01T00:25:00Z");
  await monthly(request());
  is("December goes on the 1st of January", subjects(), ["Fixture Store in December 2026"]);
  at("2027-02-01T00:25:00Z");
  await monthly(request());
  is("on the 1st of February only January is added", subjects(), ["Fixture Store in December 2026", "Fixture Store in January 2027"]);

  part("Control: a month with no visitors is still quiet, never sent");
  reset();
  control.visitors = { "2026-12": 0, "2027-01": 6 };
  at("2027-02-01T00:25:00Z");
  await monthly(request());
  is("only January", subjects(), ["Fixture Store in January 2027"]);

  Date.now = realNow;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
