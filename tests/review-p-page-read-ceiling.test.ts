/**
 * Independent review evidence for #2571. A reading's paid work must stop at
 * the priced ceiling, and an incomplete admission receipt must not authorize
 * the detail write or leave its meter without the promised expiry.
 */
import { takeReading, type ReadPass } from "@/lib/page-read";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "readings01";
const WINDOW = "2026-11";
const meter = `nl:traffic:read:${STATS}:${WINDOW}`;

const pass = (cap: number): ReadPass => ({
  statsId: STATS,
  nonce: "review0000000001",
  issued: Math.floor(Date.now() / 1000),
  window: WINDOW,
  end: Math.floor(Date.now() / 1000) + 3_600,
  cap,
});

async function main(): Promise<void> {
  redis.clear();
  const real = redis.pipeline.bind(redis);
  let commands = 0;
  redis.pipeline = async (list) => {
    commands += list.length;
    return real(list);
  };

  try {
    part("Paid work past the priced ceiling");
    is("the one priced reading is admitted", await takeReading(pass(1)), true);
    commands = 0;
    is("the next reading is refused without another paid command", [await takeReading(pass(1)), commands], [false, 0]);

    part("Incomplete admission receipt");
    redis.clear();
    commands = 0;
    let incomplete = true;
    redis.pipeline = async (list) => {
      commands += list.length;
      if (incomplete && list.length === 2 && list[0]?.[0] === "INCR" && list[1]?.[0] === "EXPIRE") {
        incomplete = false;
        const [count] = await real([list[0]]);
        return [count];
      }
      return real(list);
    };
    const accepted = await takeReading(pass(10));
    const ttl = Number(redis.run(["TTL", meter]));
    is("a partial INCR/EXPIRE receipt is unknown and the meter is repaired with a finite lifetime", [accepted, ttl > 0], [false, true]);
  } finally {
    redis.pipeline = real;
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
