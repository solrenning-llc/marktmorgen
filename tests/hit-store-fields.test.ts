/**
 * The count route (app/api/store/hit) reads only the store's fields it needs,
 * never the whole record (#1496, option A; coordinator, 21 November 2026).
 *
 * The store's record is read whole from the database by storeForHandle, up to
 * MAX_STORE_BYTES, and every byte read is billed. A count needs a few dozen
 * bytes of it: the store's ids, its plan and window, its links' and products'
 * ids. lib/store.ts storeForHit reads those inside Redis, in one script that
 * decodes the record there and answers only them, so the rest never crosses
 * the wire. Nothing is written and no second copy is kept: the record stays
 * the one source.
 *
 * Against the in-memory Redis; synthetic stores and addresses only.
 */
import { NextRequest } from "next/server";
import { POST as hitRoute } from "@/app/api/store/hit/route";
import { claimHandle, ownerKey, storeFolder, storeForHandle } from "@/lib/store";
import { visitsIn } from "@/lib/traffic";
import { allowanceWindow } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { withinOneUtcDay } from "./one-utc-day";

const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const EMAIL = "fields@example.com";

let sequence = 0;
async function hit(body: Record<string, string>): Promise<void> {
  sequence += 1;
  await hitRoute(
    new NextRequest("https://marktmorgen.com/api/store/hit", {
      method: "POST",
      headers: { "user-agent": PHONE, "x-forwarded-for": `10.9.${(sequence >> 8) & 255}.${sequence & 255}`, "x-vercel-ip-country": "US" },
      body: JSON.stringify(body),
    }),
  );
}

/** What each command the route sends asks of the database, in order. */
function recording(): { commands: (string | number)[][]; stop: () => void } {
  const commands: (string | number)[][] = [];
  const run = redis.run.bind(redis);
  redis.run = (c: (string | number)[]) => {
    commands.push(c);
    return run(c);
  };
  return { commands, stop: () => void (redis.run = run) };
}

async function main(): Promise<void> {
  const realClock = withinOneUtcDay();
  try {
    await checks();
  } finally {
    realClock();
  }
}

async function checks(): Promise<void> {
  redis.clear();
  await claimHandle(EMAIL, "fields", "Fields", "");
  const recordKey = await ownerKey(EMAIL);
  // The record at its heaviest where a count never looks: a long bio and many words of the products', beside the
  // links' and products' ids a count does need.
  const raw = JSON.parse(String(redis.run(["GET", recordKey]))) as Record<string, unknown>;
  raw.bio = "b".repeat(400_000);
  raw.links = [{ id: "l1", label: "My site", url: "https://example.com/", on: true }];
  redis.run(["SET", recordKey, JSON.stringify(raw)]);
  const store = (await storeForHandle("fields"))!;
  const folder = await storeFolder(EMAIL);
  const month = () => allowanceWindow(store, Date.now())!.id;

  const kinds: [string, Record<string, string>][] = [
    ["a visit", { h: "fields", k: "v", r: "", u: "", m: "", g: "" }],
    ["another page", { h: "fields", k: "p", p: "nothing" }],
    ["a link's click", { h: "fields", k: "l", id: "l1" }],
    ["a funnel's step", { h: "fields", k: "f", f: "x", t: "g", id: "p1" }],
    ["an affiliate's visit", { h: "fields", k: "a", c: "nobody" }],
  ];

  part("No count reads the whole store record");
  for (const [name, body] of kinds) {
    const seen = recording();
    try {
      await hit(body);
    } finally {
      seen.stop();
    }
    const whole = seen.commands.filter((c) => String(c[0]).toUpperCase() === "GET" && c[1] === recordKey).length;
    is(`${name}: the record is never fetched whole`, whole, 0);
  }

  part("The visit is still counted from the fields read in the database");
  const before = await visitsIn(folder, month());
  await hit({ h: "fields", k: "v", r: "", u: "", m: "", g: "" });
  is("one visit more", (await visitsIn(folder, month())) - before, 1);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
