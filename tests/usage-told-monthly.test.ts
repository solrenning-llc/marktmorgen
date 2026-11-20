/**
 * The delivery allowance notice (app/api/cron/usage/route.ts) once per store per calendar month, as its comment and
 * Section 5 of the Terms promise (webhooks/cron audit, Claude 1, 12/11/2026). The told list was one key for all
 * months, rewritten with every new notice (the union of all told so far) and its 40-day expiry renewed each time,
 * while the list of stores over the allowance is per month (lib/delivery.ts, overKey). A store told in October that
 * goes over again in November was not written to while the list still named it: for as long as some other store
 * was told within 40 days, never again. Now the told list is the month's own.
 * Synthetic only: the Redis stub and the SES mail fixture, no real IO.
 */
import { recordDelivery, rememberFolderOwner, DELIVERY_ALLOWANCE_BYTES, monthKey } from "@/lib/delivery";
import { GET } from "@/app/api/cron/usage/route";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

delete process.env.RESEND_API_KEY;
delete process.env.CRON_SECRET;

/** Addresses Amazon refuses outright, for now; Resend stays closed without its reviewed proof. */
const refused = new Set<string>();
const fixture = installSesMailFixture({
  onSes: (message) => message.to.some((to) => refused.has(to))
    ? new Response(JSON.stringify({ message: "synthetic confirmed message refusal" }), {
        status: 400, headers: { "content-type": "application/json", "x-amzn-errortype": "BadRequestException" },
      })
    : undefined,
});
fixture.configure();
const delivered = (): string[] => fixture.sent.flatMap((m) => m.to);

const request = { headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/usage") } as unknown as Parameters<typeof GET>[0];

async function run(): Promise<{ status: number; told: unknown; emails: string[]; unreadOwners: unknown }> {
  const from = delivered().length;
  const response = await GET(request);
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, told: body.told, emails: delivered().slice(from), unreadOwners: body.unreadOwners };
}

const folder = (c: string) => c.repeat(32);
async function overAllowance(f: string, owner: string | null): Promise<void> {
  if (owner) await rememberFolderOwner(f, owner);
  await recordDelivery(`stores/${f}/prod01/file.zip`, DELIVERY_ALLOWANCE_BYTES + 1024);
}

async function main(): Promise<void> {
  redis.clear();
  fixture.reset();
  const month = monthKey();
  const previous = monthKey(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15)));

  part("A store told last month goes over again this month");
  // As the watch leaves things after last month's notice: last month's own list.
  await redis.pipeline([
    ["SET", `nl:usage-watch:told:${previous}`, JSON.stringify([folder("a")]), "EX", 40 * 86_400],
  ]);
  await overAllowance(folder("a"), "again@example.com");
  const first = await run();
  is("its owner is written to this month", [first.status, first.told, first.emails], [200, 1, ["again@example.com"]]);

  part("Once a month: the next run writes to nobody");
  const second = await run();
  is("not written to twice in the month", [second.status, second.told, second.emails], [200, 0, []]);
  const [raw] = await redis.pipeline([["GET", `nl:usage-watch:told:${month}`]]);
  is("this month's own list names the store", typeof raw === "string" && (JSON.parse(raw) as string[]).includes(folder("a")), true);

  // The one list of all months (nl:usage-watch:told) is what the watch wrote before the lists were per month. A store
  // it names may already have been told this month, and nothing in it says which month: the first run after the
  // change copies it into this month's list and confirms that write before anyone is written to, then deletes it, so
  // nobody is told twice in the month of the change (Codex X4 and N4 on #4502). There is no separate "migrated" mark:
  // the old list is deleted only after the copy was confirmed, so no state says "done" while the copy is missing.
  part("A store named in the old list of all months is not told twice in the month of the change");
  redis.clear();
  fixture.reset();
  await redis.pipeline([
    ["SET", "nl:usage-watch:told", JSON.stringify([folder("m")]), "EX", 40 * 86_400],
  ]);
  await overAllowance(folder("m"), "already-told@example.com");
  const migrated = await run();
  is("its owner is not written to again", [migrated.status, migrated.told, migrated.emails], [200, 0, []]);
  const [monthRaw, legacyAfter] = await redis.pipeline([
    ["GET", `nl:usage-watch:told:${month}`],
    ["GET", "nl:usage-watch:told"],
  ]);
  is("the old list was copied into this month's", typeof monthRaw === "string" && (JSON.parse(monthRaw) as string[]).includes(folder("m")), true);
  is("the old list is gone once the copy was confirmed", legacyAfter, null);

  part("The copy into this month's list fails: nobody is written to and the old list is kept");
  redis.clear();
  fixture.reset();
  await redis.pipeline([
    ["SET", "nl:usage-watch:told", JSON.stringify([folder("n")]), "EX", 40 * 86_400],
  ]);
  await overAllowance(folder("n"), "kept-told@example.com");
  const real = redis.pipeline;
  // The month's write answers an error while every other command in the same call goes through, as a partial failure.
  redis.pipeline = async (commands) => {
    const replies = await real(commands);
    return commands.map((c, i) => c[0] === "SET" && c[1] === `nl:usage-watch:told:${month}` ? "ERR synthetic write refused" : replies[i]);
  };
  let failed: Awaited<ReturnType<typeof run>>;
  try {
    failed = await run();
  } finally {
    redis.pipeline = real;
  }
  is("nobody is written to while the copy is unconfirmed", [failed.status === 200, failed.emails], [false, []]);
  const [legacyKept] = await redis.pipeline([["GET", "nl:usage-watch:told"]]);
  is("the old list is kept for the next run", legacyKept, JSON.stringify([folder("n")]));
  const retried = await run();
  is("the next run copies it and still writes to nobody", [retried.status, retried.told, retried.emails], [200, 0, []]);
  const [legacyGone] = await redis.pipeline([["GET", "nl:usage-watch:told"]]);
  is("then the old list is gone", legacyGone, null);
  done();
}

main();
