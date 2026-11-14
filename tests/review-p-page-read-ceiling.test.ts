/**
 * Independent review evidence for #2571. A reading's paid work must stop at
 * the priced ceiling, and an incomplete admission receipt must not authorize
 * the detail write or leave its meter without the promised expiry.
 */
import { ADMIT_READING, admitReading, forgetReadingsSeen, type ReadPass } from "@/lib/page-read";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "readings01";
const WINDOW = "2026-11";
const meter = `nl:traffic:read:${STATS}:${WINDOW}`;

let nonces = 0;
const pass = (cap: number): ReadPass => ({
  statsId: STATS,
  nonce: `review${String((nonces += 1)).padStart(10, "0")}`,
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
    is("the one priced reading is admitted", await admitReading(pass(1)), true);
    commands = 0;
    is("the next reading is refused without another paid command", [await admitReading(pass(1)), commands], [false, 0]);
    forgetReadingsSeen();
    is("a server that saw nothing is refused too, and the count stays at the ceiling", [await admitReading(pass(1)), redis.run(["GET", meter])], [false, "1"]);

    part("Incomplete admission receipt");
    redis.clear();
    forgetReadingsSeen();
    commands = 0;
    let incomplete = true;
    redis.pipeline = async (list) => {
      commands += list.length;
      if (incomplete && list.length === 1 && list[0]?.[0] === "EVAL" && list[0]?.[1] === ADMIT_READING) {
        incomplete = false;
        await real(list);
        return [[1]];
      }
      return real(list);
    };
    const accepted = await admitReading(pass(10));
    const ttl = Number(redis.run(["TTL", meter]));
    is("a partial admission receipt is unknown, and the count made in the script keeps its finite lifetime", [accepted, ttl > 0], [false, true]);
  } finally {
    redis.pipeline = real;
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
