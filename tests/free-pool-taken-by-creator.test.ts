/**
 * TODOS-51 C: one of the month's places for stores that pay nothing (lib/free-pool-rules.ts) is taken only by the
 * creator's own signed-in work (the studio, the API, an integration), never by what the public side answers. The
 * public side, a buyer's actions, emails and orders only check whether the store already holds a place: a store that
 * does not rests until its creator is back, and none of the month's places is spent for it.
 */
import { calendarWindow } from "@/lib/allowance-window";
import { admitNonPaying, poolPlace } from "@/lib/free-pool";
import { takeAllowance } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const free = (n: number) => ({ sid: `fpc${String(n).padStart(3, "0")}`.padEnd(32, "q"), handle: `fpc${n}`, statsId: `fpcstats${n}`.padEnd(20, "s"), tier: "creator" as const, subscriptionActive: false, subscriptionId: null, trialEnds: Math.floor(Date.now() / 1000) + 7 * 86_400, planEndedAt: "", listId: null });

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  const month = calendarWindow(now).id;
  const handedOut = () => Number(redis.run(["GET", `nl:free:n:${month}`]) ?? 0);

  part("The public side never takes a place");
  const visited = free(1);
  is("a public request for a store without a place is not let through", await admitNonPaying(visited, now), false);
  is("and no place of the month was handed out for it", handedOut(), 0);
  for (const kind of ["buyer", "transactional", "webhook", "inbox", "email"] as const) {
    const taken = await takeAllowance(free(10 + kind.length), kind, 1, now);
    is(`a ${kind} use for a store without a place is refused, never let through`, taken.ok, false);
  }
  is("none of those handed out a place", handedOut(), 0);

  part("The creator's own work takes it, and then the public side is answered");
  const opened = free(2);
  const studio = await takeAllowance(opened, "studio", 1, now);
  is("the studio takes a place", studio.ok, true);
  is("one place handed out", handedOut(), 1);
  is("the store's public side is answered now", await admitNonPaying(opened, now), true);
  is("a buyer's use is counted now", (await takeAllowance(opened, "buyer", 1, now)).ok, true);
  is("still one place: the public side used the one the creator took", handedOut(), 1);

  part("Places the creator's work can take are still the month's places");
  is("poolPlace (the creator's path) still hands out places", await poolPlace(free(3), now), "in");
  is("two places now", handedOut(), 2);
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
